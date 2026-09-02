import { constants } from "node:fs";
import { chmod, open, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { effectiveConfigDigest, QUALITY_RUNNER_VERSION } from "./config";
import { contentId, DEFAULT_QUALITY_ROOT, listBundleIds, openBundleFile, publishBundle, readBundle, readLabelEvents, type BundleKind, type CommitResult, type OpenBundleFile } from "./store";
import type { MaterializedCase } from "./promote";
import type { QualityCaseResult, QualityMetrics, QualityObservation } from "./types";

const execFileAsync = promisify(execFile);
const LIVE_ATTEMPTS = ["live-1", "live-2", "live-3"] as const;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ObservationContext = Readonly<{ attemptName?: string }>;
export type ObservationAdapterResult = Readonly<{ status: QualityCaseResult["status"]; metrics: QualityMetrics }> | QualityCaseResult;
export type ObservationCaseRunner = (qualityCase: MaterializedCase, context: ObservationContext) => Promise<ObservationAdapterResult>;
export type ObservationAttemptRecord = Readonly<{ caseVersion: string; attemptName: string; result: QualityCaseResult }>;

export type ObservationDependencies = Readonly<{
  runCase: ObservationCaseRunner;
  publish?: (observation: QualityObservation, attempts: readonly ObservationAttemptRecord[]) => Promise<CommitResult>;
}>;

export type ObserveQualityOptions = Readonly<{
  set: "eval" | "holdout";
  mode: "baseline" | "candidate";
  commitSha: string;
  config: unknown;
  corpusSha256: `sha256:${string}`;
  runnerVersion: number;
  cases: readonly MaterializedCase[];
  dependencies: ObservationDependencies;
  root?: string;
  environment: Readonly<Record<string, string | undefined>>;
  allowedEnvironment: readonly string[];
  live?: boolean;
  promptFingerprint: `sha256:${string}`;
  modelFingerprint: `sha256:${string}`;
  requestFingerprint: `sha256:${string}`;
  recorded?: Readonly<{ promptFingerprint: `sha256:${string}`; modelFingerprint: `sha256:${string}`; requestFingerprint: `sha256:${string}` }>;
}>;

export class ObservationError extends Error {
  constructor(readonly code: "invalid_input" | "environment" | "set" | "fingerprint" | "live_required" | "publish_failed" | "missing" | "stale" | "corpus_mismatch") {
    super(code);
    this.name = "ObservationError";
  }
}

type LoadedCase = MaterializedCase & { loadStatus?: "missing" | "stale" };
export type LoadedPrivateCases = Readonly<{ cases: readonly LoadedCase[]; corpusSha256: `sha256:${string}` }>;

type LoadedCaseSet = readonly LoadedCase[];
export type CorpusSnapshot = Readonly<{ evalCases: LoadedCaseSet; holdoutCases: LoadedCaseSet; corpusSha256: `sha256:${string}` }>;

function unavailableCase(id: string, set: "eval" | "holdout", event: Readonly<Record<string, unknown>>, loadStatus: "missing" | "stale"): LoadedCase {
  const disposition = event.disposition === "confirmed_negative" || event.disposition === "exclude" ? event.disposition : "positive";
  const verdict = event.verdict === "EDIT" || event.verdict === "NO" ? event.verdict : "AS_IS";
  const subsystem = ["selection", "boundary", "framing", "subtitles", "render"].includes(event.subsystem as string) ? event.subsystem : "render";
  const zero = "sha256:" + "0".repeat(64) as `sha256:${string}`;
  return { schemaVersion: 1, caseVersion: id, feedbackId: "unavailable", clipId: "unavailable", jobId: "unavailable", userId: "unavailable", feedbackUpdatedAt: "1970-01-01T00:00:00.000Z", snapshotSha256: zero, candidateVersion: zero, set, disposition, verdict, subsystem: subsystem as LoadedCase["subsystem"], confidence: "medium", expected: { approvedMoment: false, completeBoundary: false, visualSamples: [] }, inputs: { transcriptSha256: null, evidenceSha256: zero, sourceSha256: null, sourceDurationSec: null, recordedResponsesSha256: null }, replay: { highlight: { start: 0, end: 0, title: "unavailable" }, subtitleTrack: null, cropPlan: null, renderManifest: null, reframeConfig: null, musicDirection: null, blackTail: null, sourceUrl: null }, loadStatus };
}

function parseCase(value: unknown, expectedId: string): MaterializedCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObservationError("invalid_input");
  const item = value as Record<string, unknown>;
  if (item.caseVersion !== expectedId || item.schemaVersion !== 1 || typeof item.feedbackId !== "string" || typeof item.clipId !== "string" || typeof item.jobId !== "string" || typeof item.userId !== "string" || (item.set !== "eval" && item.set !== "holdout") || !["positive", "confirmed_negative", "exclude"].includes(item.disposition as string) || !["AS_IS", "EDIT", "NO"].includes(item.verdict as string) || !["selection", "boundary", "framing", "subtitles", "render"].includes(item.subsystem as string) || !item.expected || typeof item.expected !== "object" || !item.inputs || typeof item.inputs !== "object") throw new ObservationError("invalid_input");
  const { caseVersion: _caseVersion, ...body } = item;
  if (contentId("case", body) !== expectedId) throw new ObservationError("invalid_input");
  return item as unknown as MaterializedCase;
}

function caseArtifactsValid(bundle: ReadonlyMap<string, Uint8Array>, qualityCase: MaterializedCase): boolean {
  // The legacy overloaded artifact is deliberately never interpreted: its
  // role cannot be inferred safely after publication.
  if (bundle.has("source-or-evidence.mp4") || !bundle.has("evidence.mp4")) return false;
  const sourceHash = qualityCase.inputs?.sourceSha256;
  if (sourceHash !== null && !validHash(sourceHash)) return false;
  if (sourceHash === null && bundle.has("source.mp4")) return false;
  if (sourceHash !== null && !bundle.has("source.mp4")) return false;
  return true;
}

function projectLabelEvents(events: ReadonlyArray<Readonly<Record<string, unknown>>>): Readonly<{ eval: ReadonlyMap<string, Readonly<Record<string, unknown>>>; holdout: ReadonlyMap<string, Readonly<Record<string, unknown>>> }> {
  const retired = new Set(events.filter((item) => item.action === "retire").map((item) => item.targetEventId).filter((item): item is string => typeof item === "string"));
  const selected = { eval: new Map<string, Readonly<Record<string, unknown>>>(), holdout: new Map<string, Readonly<Record<string, unknown>>>() };
  for (const event of events) {
    if (event.action !== "label" || (event.set !== "eval" && event.set !== "holdout") || typeof event.caseVersion !== "string" || typeof event.eventId !== "string" || retired.has(event.eventId)) continue;
    selected[event.set].set(event.caseVersion, event);
  }
  return selected;
}

/** Verify every selected case's content-addressed bundle from one immutable
 * ledger projection. A missing/stale label never becomes a skipped case. */
async function loadPrivateCaseSet(set: "eval" | "holdout", root: string, selected: ReadonlyMap<string, Readonly<Record<string, unknown>>>, ids: ReadonlySet<string>): Promise<LoadedCaseSet> {
  const cases: LoadedCase[] = [];
  for (const [id] of [...selected.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const event = selected.get(id)!;
    if (!ids.has(id)) { cases.push(unavailableCase(id, set, event, "missing")); continue; }
    let bundle: ReadonlyMap<string, Uint8Array>;
    try { bundle = await readBundle("case", id, root); } catch { cases.push(unavailableCase(id, set, event, "stale")); continue; }
    const bytes = bundle.get("case.json");
    if (!bytes) { cases.push(unavailableCase(id, set, event, "missing")); continue; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      const item = parseCase(parsed, id);
      if (item.set !== set) throw new ObservationError("set");
      if (!caseArtifactsValid(bundle, item)) throw new ObservationError("invalid_input");
      cases.push(item);
    } catch (error) {
      if (error instanceof ObservationError && error.code === "set") throw error;
      cases.push(unavailableCase(id, set, event, "stale"));
    }
  }
  return freeze(cases);
}

/** Build the complete corpus view from exactly one ledger read. Bundle IDs and
 * case bytes are content-addressed, so later promote/retire activity cannot
 * replace a case selected by this projection. */
export async function loadQualityCorpusSnapshot(
  root = DEFAULT_QUALITY_ROOT,
  readLedger: (root: string) => Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> = readLabelEvents,
): Promise<CorpusSnapshot> {
  const events = await readLedger(root);
  const selected = projectLabelEvents(events);
  const ids = new Set(await listBundleIds("case", root));
  const evalCases = await loadPrivateCaseSet("eval", root, selected.eval, ids);
  const holdoutCases = await loadPrivateCaseSet("holdout", root, selected.holdout, ids);
  const all = [...evalCases, ...holdoutCases].sort((left, right) => left.caseVersion.localeCompare(right.caseVersion));
  return { evalCases, holdoutCases, corpusSha256: sha256(canonicalJson(all.map((item) => ({ ...item })))) };
}

/** Content identity of the complete active corpus. Eval and holdout are views
 * over this same digest; changing either side invalidates every decision. */
export async function deriveQualityCorpusDigest(root = DEFAULT_QUALITY_ROOT): Promise<`sha256:${string}`> {
  return (await loadQualityCorpusSnapshot(root)).corpusSha256;
}

export async function loadPrivateCases(set: "eval" | "holdout", root = DEFAULT_QUALITY_ROOT): Promise<LoadedPrivateCases> {
  const snapshot = await loadQualityCorpusSnapshot(root);
  return { cases: set === "eval" ? snapshot.evalCases : snapshot.holdoutCases, corpusSha256: snapshot.corpusSha256 };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function validHash(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }
function invalidResult(qualityCase: MaterializedCase): QualityCaseResult {
  const common: QualityMetrics = { approvedMomentRetained: 0, approvedWindowOverlap: 0, emptyResult: 1, zeroClipFalseNegative: qualityCase.expected.approvedMoment ? 1 : 0, hardInvariantFailures: 1, boundaryErrors: 1, focalFailures: 1, subtitleOverlap: 1, defectSeverity: 1 };
  return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "error", metrics: common };
}

function validateEnvironment(environment: Readonly<Record<string, string | undefined>>, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of allowed) if (!SAFE_ENV_NAME.test(key)) throw new ObservationError("environment");
  for (const [key, value] of Object.entries(environment)) {
    if (!allow.has(key) || (value !== undefined && typeof value !== "string")) throw new ObservationError("environment");
  }
}

function validateOptions(options: ObserveQualityOptions): void {
  if (!COMMIT_RE.test(options.commitSha) || !validHash(options.corpusSha256) || options.runnerVersion !== QUALITY_RUNNER_VERSION) throw new ObservationError("invalid_input");
  if (!options.cases.length || new Set(options.cases.map((item) => item.caseVersion)).size !== options.cases.length) throw new ObservationError("invalid_input");
  for (const item of options.cases) if (item.set !== options.set) throw new ObservationError("set");
  validateEnvironment(options.environment, options.allowedEnvironment);
  if (!validHash(options.promptFingerprint) || !validHash(options.modelFingerprint) || !validHash(options.requestFingerprint)) throw new ObservationError("fingerprint");
  if (!options.live && !options.recorded) throw new ObservationError("fingerprint");
  if (options.recorded && (!validHash(options.recorded.promptFingerprint) || !validHash(options.recorded.modelFingerprint) || !validHash(options.recorded.requestFingerprint))) throw new ObservationError("fingerprint");
  // Deterministic replay is valid only for the exact reviewed request shape.
  // Any prompt/model/request drift must be evaluated as a live observation.
  if (options.recorded && !options.live && (options.promptFingerprint !== options.recorded.promptFingerprint || options.modelFingerprint !== options.recorded.modelFingerprint || options.requestFingerprint !== options.recorded.requestFingerprint)) throw new ObservationError("live_required");
}

function assertResult(value: ObservationAdapterResult, qualityCase: MaterializedCase): QualityCaseResult {
  const normalized = "schemaVersion" in value
    ? value
    : { schemaVersion: 1 as const, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: value.status, metrics: value.metrics };
  if (!normalized || normalized.schemaVersion !== 1 || normalized.caseVersion !== qualityCase.caseVersion || normalized.disposition !== qualityCase.disposition || normalized.subsystem !== qualityCase.subsystem || !normalized.metrics || typeof normalized.metrics !== "object") throw new ObservationError("invalid_input");
  return normalized;
}

async function publishDefault(observation: QualityObservation, attempts: readonly ObservationAttemptRecord[], root: string): Promise<CommitResult> {
  const results = serializeObservationAttempts(attempts);
  const names = new Set(attempts.map((item) => item.attemptName));
  const live = names.size === 3 && LIVE_ATTEMPTS.every((name) => names.has(name));
  const caseVersions = [...new Set(observation.cases.map((item) => item.caseVersion))].sort();
  const manifest = { schemaVersion: 1, observationId: observation.observationId, set: observation.set, mode: observation.mode, live, commitSha: observation.commitSha, configSha256: observation.configSha256, corpusSha256: observation.corpusSha256, runnerVersion: observation.runnerVersion, createdAt: observation.createdAt, caseVersions, attemptCount: attempts.length, attemptsSha256: sha256(results) };
  return publishBundle({ kind: "observation", id: observation.observationId, files: { "manifest.json": Buffer.from(canonicalJson(manifest) + "\n"), "results.jsonl": Buffer.from(results) } }, root);
}

export function serializeObservationAttempts(attempts: readonly ObservationAttemptRecord[]): string {
  return attempts.map((item) => canonicalJson(item)).join("\n") + "\n";
}

export type ObservationIdentityBody = Omit<QualityObservation, "observationId" | "createdAt"> & {
  live: boolean;
  caseVersions: string[];
  attemptCount: number;
  attemptsSha256: `sha256:${string}`;
};

/** Shared canonical identity helper. The complete attempts artifact is part
 * of the digest, so changing any live-2/live-3 result changes the ID. */
export function observationIdFor(body: ObservationIdentityBody): string {
  return contentId("observation", body);
}

async function readObservationFile(id: string, name: string, root: string): Promise<string> {
  const opened = await openBundleFile("observation", id, name, root);
  try {
    const reader = opened.stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 32 * 1024 * 1024) throw new ObservationError("invalid_input");
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    await opened.sha256;
    return Buffer.concat(chunks.map((item) => Buffer.from(item))).toString("utf8");
  } finally { await opened.close(); }
}

const OBSERVATION_MANIFEST_KEYS = ["schemaVersion", "observationId", "set", "mode", "live", "commitSha", "configSha256", "corpusSha256", "runnerVersion", "createdAt", "caseVersions", "attemptCount", "attemptsSha256"] as const;
const OBSERVATION_MANIFEST_KEY_SET = new Set<string>(OBSERVATION_MANIFEST_KEYS);

export type ObservationManifest = Readonly<{
  schemaVersion: 1;
  observationId: string;
  set: "eval" | "holdout";
  mode: "baseline" | "candidate";
  live: boolean;
  commitSha: string;
  configSha256: `sha256:${string}`;
  corpusSha256: `sha256:${string}`;
  runnerVersion: number;
  createdAt: string;
  caseVersions: readonly string[];
  attemptCount: number;
  attemptsSha256: `sha256:${string}`;
}>;

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function exactManifestObject(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== OBSERVATION_MANIFEST_KEYS.length) return false;
    for (const key of keys) {
      if (typeof key !== "string" || !OBSERVATION_MANIFEST_KEY_SET.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
    }
    return OBSERVATION_MANIFEST_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  } catch {
    return false;
  }
}

function parseManifestBytes(bytes: Uint8Array | string, expectedId: string): ObservationManifest {
  if (!/^observation:sha256:[0-9a-f]{64}$/.test(expectedId)) throw new ObservationError("invalid_input");
  let value: unknown;
  try { value = JSON.parse(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")); } catch { throw new ObservationError("invalid_input"); }
  if (!exactManifestObject(value)) throw new ObservationError("invalid_input");
  const manifest = value;
  const cases = manifest.caseVersions;
  if (manifest.schemaVersion !== 1 || manifest.observationId !== expectedId || (manifest.set !== "eval" && manifest.set !== "holdout") || (manifest.mode !== "baseline" && manifest.mode !== "candidate") || typeof manifest.live !== "boolean" || !COMMIT_RE.test(String(manifest.commitSha)) || !validHash(manifest.configSha256) || !validHash(manifest.corpusSha256) || !Number.isSafeInteger(manifest.runnerVersion) || (manifest.runnerVersion as number) < 0 || !validTimestamp(manifest.createdAt) || !Array.isArray(cases) || cases.length === 0 || cases.some((item) => typeof item !== "string") || [...cases].sort().join("\n") !== cases.join("\n") || new Set(cases).size !== cases.length || !Number.isSafeInteger(manifest.attemptCount) || (manifest.attemptCount as number) <= 0 || !validHash(manifest.attemptsSha256)) throw new ObservationError("invalid_input");
  return manifest as ObservationManifest;
}

export type ObservationSnapshot = Readonly<{ manifest: ObservationManifest; attempts: readonly ObservationAttemptRecord[] }>;

/** Parse one exact manifest/results byte snapshot. No caller may supply a
 * pre-parsed observation or fetch the two artifacts independently. */
export function parseObservationSnapshot(manifestBytes: Uint8Array | string, resultsBytes: Uint8Array | string, expectedId: string): ObservationSnapshot {
  const manifest = parseManifestBytes(manifestBytes, expectedId);
  const results = typeof resultsBytes === "string" ? resultsBytes : Buffer.from(resultsBytes).toString("utf8");
  if (manifest.attemptsSha256 !== sha256(results)) throw new ObservationError("invalid_input");
  const lines = results.endsWith("\n") ? results.slice(0, -1).split("\n") : [];
  if (lines.length !== manifest.attemptCount || lines.length === 0) throw new ObservationError("invalid_input");
  const attempts: ObservationAttemptRecord[] = [];
  const names = new Set<string>();
  const byCase = new Map<string, Set<string>>();
  const manifestCases = new Set(manifest.caseVersions);
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new ObservationError("invalid_input"); }
    if (!exactAttemptWrapper(parsed)) throw new ObservationError("invalid_input");
    const item = parsed as Record<string, unknown>;
    if (typeof item.caseVersion !== "string" || !manifestCases.has(item.caseVersion) || typeof item.attemptName !== "string" || item.attemptName.length === 0 || names.has(`${item.caseVersion}:${item.attemptName}`) || !item.result || typeof item.result !== "object") throw new ObservationError("invalid_input");
    const result = item.result as Record<string, unknown>;
    if (result.schemaVersion !== 1 || result.caseVersion !== item.caseVersion || !["positive", "confirmed_negative", "exclude"].includes(result.disposition as string) || !["selection", "boundary", "framing", "subtitles", "render"].includes(result.subsystem as string) || !["ok", "missing", "stale", "error"].includes(result.status as string) || !result.metrics || typeof result.metrics !== "object" || Array.isArray(result.metrics)) throw new ObservationError("invalid_input");
    names.add(`${item.caseVersion}:${item.attemptName}`);
    const caseNames = byCase.get(item.caseVersion) ?? new Set<string>();
    caseNames.add(item.attemptName);
    byCase.set(item.caseVersion, caseNames);
    attempts.push(Object.freeze({ caseVersion: item.caseVersion, attemptName: item.attemptName, result: result as unknown as QualityCaseResult }));
  }
  if (byCase.size !== manifestCases.size || [...byCase.keys()].some((caseVersion) => !manifestCases.has(caseVersion))) throw new ObservationError("invalid_input");
  for (const caseNames of byCase.values()) {
    const values = [...caseNames].sort();
    const expected = manifest.live ? [...LIVE_ATTEMPTS].sort() : ["recorded"];
    if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) throw new ObservationError("invalid_input");
  }
  return Object.freeze({ manifest, attempts: Object.freeze(attempts) });
}

/** Pure parser for one immutable observation snapshot. */
export function parseObservationAttempts(manifestBytes: Uint8Array | string, resultsBytes: Uint8Array | string, expectedId: string): readonly ObservationAttemptRecord[] {
  return parseObservationSnapshot(manifestBytes, resultsBytes, expectedId).attempts;
}

/** Typed reader for the complete immutable attempt artifact. Consumers must
 * use this API rather than `QualityObservation.cases`, which intentionally
 * contains only the first result for policy compatibility. */
export async function readObservationAttempts(id: string, root = DEFAULT_QUALITY_ROOT): Promise<readonly ObservationAttemptRecord[]> {
  let files: ReadonlyMap<string, Uint8Array>;
  try {
    files = await readBundle("observation", id, root);
  } catch (error) {
    if (error instanceof ObservationError) throw error;
    throw new ObservationError("invalid_input");
  }
  if (!files.has("manifest.json") || !files.has("results.jsonl")) throw new ObservationError("invalid_input");
  return parseObservationSnapshot(files.get("manifest.json")!, files.get("results.jsonl")!, id).attempts;
}

function exactAttemptWrapper(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3) return false;
    for (const key of keys) {
      if (typeof key !== "string" || !["caseVersion", "attemptName", "result"].includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Execute one immutable observation. All input cases are visited; an adapter
 * failure is represented as an error result so policy can fail closed. */
export async function observeQualitySet(options: ObserveQualityOptions): Promise<QualityObservation> {
  validateOptions(options);
  const attemptNames: readonly string[] = options.live ? LIVE_ATTEMPTS : ["recorded"];
  const results: QualityCaseResult[] = [];
  const attempts: ObservationAttemptRecord[] = [];
  for (const qualityCase of options.cases) {
    let first: QualityCaseResult | undefined;
    for (const attemptName of attemptNames) {
      let result: QualityCaseResult;
      try {
        result = assertResult(await options.dependencies.runCase(qualityCase, { attemptName }), qualityCase);
      } catch {
        result = invalidResult(qualityCase);
      }
      attempts.push({ caseVersion: qualityCase.caseVersion, attemptName, result: freeze(result) });
      first ??= result;
    }
    results.push(first!);
  }
  const orderedResults = [...results].sort((left, right) => left.caseVersion.localeCompare(right.caseVersion));
  const caseVersions = orderedResults.map((item) => item.caseVersion);
  const resultsBytes = serializeObservationAttempts(attempts);
  const body: ObservationIdentityBody = { schemaVersion: 1 as const, mode: options.mode, set: options.set, commitSha: options.commitSha, configSha256: effectiveConfigDigest(options.config, options.environment), corpusSha256: options.corpusSha256, runnerVersion: options.runnerVersion, live: options.live === true, caseVersions, attemptCount: attempts.length, attemptsSha256: sha256(resultsBytes), cases: orderedResults };
  const observation = freeze({ ...body, observationId: observationIdFor(body), createdAt: new Date().toISOString() } as QualityObservation);
  const publish = options.dependencies.publish ?? ((value, records) => publishDefault(value, records, options.root ?? DEFAULT_QUALITY_ROOT));
  const outcome = await publish(observation, attempts);
  if (outcome.status === "indeterminate") throw new ObservationError("publish_failed");
  return observation;
}

export function configDigest(config: unknown, environment: Readonly<Record<string, string | undefined>> = process.env): `sha256:${string}` { return effectiveConfigDigest(config, environment); }
export function liveAttemptNames(): readonly string[] { return LIVE_ATTEMPTS; }

/** Large private artifacts stay streaming and descriptor-pinned. Callers must
 * close the returned handle when their adapter has finished consuming it. */
export function openQualityArtifact(kind: BundleKind, id: string, name: string, root = DEFAULT_QUALITY_ROOT): Promise<OpenBundleFile> {
  return openBundleFile(kind, id, name, root);
}
