import { constants } from "node:fs";
import { chmod, open, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { contentId, DEFAULT_QUALITY_ROOT, openBundleFile, publishBundle, type BundleKind, type CommitResult, type OpenBundleFile } from "./store";
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
  promptFingerprint?: `sha256:${string}`;
  modelFingerprint?: `sha256:${string}`;
  recorded?: Readonly<{ promptFingerprint: `sha256:${string}`; modelFingerprint: `sha256:${string}` }>;
}>;

export class ObservationError extends Error {
  constructor(readonly code: "invalid_input" | "environment" | "set" | "fingerprint" | "live_required" | "publish_failed") {
    super(code);
    this.name = "ObservationError";
  }
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
  if (!COMMIT_RE.test(options.commitSha) || !validHash(options.corpusSha256) || !Number.isSafeInteger(options.runnerVersion) || options.runnerVersion < 0) throw new ObservationError("invalid_input");
  if (!options.cases.length || new Set(options.cases.map((item) => item.caseVersion)).size !== options.cases.length) throw new ObservationError("invalid_input");
  for (const item of options.cases) if (item.set !== options.set) throw new ObservationError("set");
  validateEnvironment(options.environment, options.allowedEnvironment);
  if (options.promptFingerprint !== undefined && !validHash(options.promptFingerprint)) throw new ObservationError("fingerprint");
  if (options.modelFingerprint !== undefined && !validHash(options.modelFingerprint)) throw new ObservationError("fingerprint");
  if (options.recorded && (!validHash(options.recorded.promptFingerprint) || !validHash(options.recorded.modelFingerprint))) throw new ObservationError("fingerprint");
  if (options.live && (!options.promptFingerprint || !options.modelFingerprint)) throw new ObservationError("fingerprint");
  if (options.recorded && !options.live && (options.promptFingerprint !== options.recorded.promptFingerprint || options.modelFingerprint !== options.recorded.modelFingerprint)) throw new ObservationError("live_required");
}

function assertResult(value: ObservationAdapterResult, qualityCase: MaterializedCase): QualityCaseResult {
  const normalized = "schemaVersion" in value
    ? value
    : { schemaVersion: 1 as const, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: value.status, metrics: value.metrics };
  if (!normalized || normalized.schemaVersion !== 1 || normalized.caseVersion !== qualityCase.caseVersion || normalized.disposition !== qualityCase.disposition || normalized.subsystem !== qualityCase.subsystem || !normalized.metrics || typeof normalized.metrics !== "object") throw new ObservationError("invalid_input");
  return normalized;
}

async function publishDefault(observation: QualityObservation, attempts: readonly ObservationAttemptRecord[], root: string): Promise<CommitResult> {
  const manifest = { schemaVersion: 1, observationId: observation.observationId, set: observation.set, mode: observation.mode, commitSha: observation.commitSha, configSha256: observation.configSha256, corpusSha256: observation.corpusSha256, runnerVersion: observation.runnerVersion, attemptCount: attempts.length };
  const results = attempts.map((item) => canonicalJson(item)).join("\n") + "\n";
  return publishBundle({ kind: "observation", id: observation.observationId, files: { "manifest.json": Buffer.from(canonicalJson(manifest) + "\n"), "results.jsonl": Buffer.from(results) } }, root);
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
  const body = { schemaVersion: 1 as const, mode: options.mode, set: options.set, commitSha: options.commitSha, configSha256: sha256(canonicalJson(options.config)), corpusSha256: options.corpusSha256, runnerVersion: options.runnerVersion, cases: results };
  const observation = freeze({ ...body, observationId: contentId("observation", body), createdAt: new Date().toISOString() } as QualityObservation);
  const publish = options.dependencies.publish ?? ((value, records) => publishDefault(value, records, options.root ?? DEFAULT_QUALITY_ROOT));
  const outcome = await publish(observation, attempts);
  if (outcome.status === "indeterminate") throw new ObservationError("publish_failed");
  return observation;
}

export function configDigest(config: unknown): `sha256:${string}` { return sha256(canonicalJson(config)); }
export function liveAttemptNames(): readonly string[] { return LIVE_ATTEMPTS; }

/** Large private artifacts stay streaming and descriptor-pinned. Callers must
 * close the returned handle when their adapter has finished consuming it. */
export function openQualityArtifact(kind: BundleKind, id: string, name: string, root = DEFAULT_QUALITY_ROOT): Promise<OpenBundleFile> {
  return openBundleFile(kind, id, name, root);
}
