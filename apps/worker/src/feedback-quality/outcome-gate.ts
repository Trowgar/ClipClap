import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { Sha256 } from "../feedback-learning/types";
import { readGateCaseEvidence, readGateDecision, type GateDecision } from "./gate";
import { type OutcomeObservation, type OutcomeObservationResult, OUTCOME_OBSERVATION_RUNNER_VERSION } from "./outcome-observe";
import { DEFAULT_OUTCOME_ROOT, ensureOutcomeStore, readActiveOutcomeLabels } from "./outcome-store";
import type { OutcomeLabel } from "./outcome-types";
import { decideOutcomeGate, OUTCOME_POLICY_VERSION, OUTCOME_REASON_ORDER, type ClipGateEvidence, type OutcomeGateMetrics, type OutcomeGateReason } from "./outcome-policy";
import type { CommitResult } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECISION_ID = /^decision:sha256:[0-9a-f]{64}$/;
const OUTCOME_DECISION_ID = /^outcome-decision:sha256:[0-9a-f]{64}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const METRIC_KEYS = [
  "recoverableCases", "validEmptyCases", "recoverableHoldoutCases", "validEmptyHoldoutCases",
  "recoveredCases", "recoveryRateBps", "validEmptyFalsePositives", "positiveLosses",
  "confirmedNegativeWorsening", "keepFalseShipped", "explicitGateResurrections",
  "maximumCandidateCap", "maximumCriticBatches", "clipPositiveCases",
  "clipConfirmedNegativeCases", "clipSelectionNegativeCases",
] as const;

export type DecideOutcomeGateInput = Readonly<{
  baselineObservationId: Sha256;
  candidateObservationId: Sha256;
  clipDecisionId: string;
  expectedCandidateEngineFingerprint: Sha256;
  customerOutputsMatch: boolean;
}>;

export type OutcomeGateDecision = Readonly<{
  schemaVersion: 1;
  decisionId: string;
  policyVersion: typeof OUTCOME_POLICY_VERSION;
  clipDecisionId: string;
  candidateCommitSha: string;
  configSha256: string;
  outcomeEngineFingerprint: Sha256;
  outcomeCorpusDigest: Sha256;
  runnerVersion: typeof OUTCOME_OBSERVATION_RUNNER_VERSION;
  baselineObservationId: Sha256;
  candidateObservationId: Sha256;
  createdAt: string;
  expiresAt: string;
  metrics: OutcomeGateMetrics;
  verdict: "pass" | "fail";
  reasons: readonly OutcomeGateReason[];
}>;

export type LoadedOutcomeObservation = Readonly<{ observation: OutcomeObservation; observedAt: Date }>;
type ClipCaseEvidence = Omit<ClipGateEvidence, "verdict">;
export type OutcomeGateDependencies = Readonly<{
  root?: string;
  clipRoot?: string;
  now?: () => Date;
  loadObservation?: (id: Sha256, root: string) => Promise<LoadedOutcomeObservation>;
  loadLabels?: (root: string) => Promise<readonly OutcomeLabel[]>;
  loadClipDecision?: (id: string, root: string, now: Date) => Promise<GateDecision>;
  loadClipEvidence?: (decision: GateDecision, root: string) => Promise<ClipCaseEvidence>;
  publishDecision?: (decision: OutcomeGateDecision, report: string, root: string) => Promise<CommitResult>;
}>;

export class OutcomeGateError extends Error {
  constructor(readonly code: "invalid_input" | "private_store_invalid" | "publication_failed") { super(code); this.name = "OutcomeGateError"; }
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value); const actual = Reflect.ownKeys(descriptors);
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key) && descriptors[key].enumerable === true && Object.prototype.hasOwnProperty.call(descriptors[key], "value"));
}

function utc(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function nonnegativeInt(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

function validMetrics(value: unknown): value is OutcomeGateMetrics {
  return exact(value, METRIC_KEYS) && METRIC_KEYS.every((key) => nonnegativeInt(value[key]));
}

function validReasons(value: unknown): value is readonly OutcomeGateReason[] {
  if (!Array.isArray(value) || value.some((reason) => typeof reason !== "string" || !OUTCOME_REASON_ORDER.includes(reason as OutcomeGateReason))) return false;
  if (new Set(value).size !== value.length) return false;
  return value.every((reason, index) => index === 0 ||
    OUTCOME_REASON_ORDER.indexOf(reason as OutcomeGateReason) > OUTCOME_REASON_ORDER.indexOf(value[index - 1] as OutcomeGateReason));
}

function parseObservation(value: unknown, wantedId: Sha256): OutcomeObservation {
  if (!exact(value, ["schemaVersion", "observationId", "mode", "commitSha", "engineFingerprint", "corpusDigest", "runnerVersion", "recordedResponsesDigest", "results"]) &&
      !exact(value, ["schemaVersion", "observationId", "mode", "commitSha", "engineFingerprint", "corpusDigest", "runnerVersion", "recordedResponsesDigest", "results", "liveLane"])) throw new OutcomeGateError("private_store_invalid");
  const item = value as unknown as OutcomeObservation;
  if (item.schemaVersion !== 1 || item.observationId !== wantedId || (item.mode !== "baseline" && item.mode !== "candidate") || !COMMIT.test(item.commitSha) ||
      !HASH.test(item.engineFingerprint) || !HASH.test(item.corpusDigest) || item.runnerVersion !== OUTCOME_OBSERVATION_RUNNER_VERSION || !HASH.test(item.recordedResponsesDigest) || !Array.isArray(item.results) || item.results.length === 0) throw new OutcomeGateError("private_store_invalid");
  const seen = new Set<string>();
  for (const result of item.results) {
    const raw: unknown = result;
    if (!exact(raw, ["caseVersion", "disposition", "shippedWindows", "approvedHits", "forbiddenHits", "keepFalseShipped", "explicitGateResurrections", "candidateCap", "criticBatches", "noClipsReason"])) throw new OutcomeGateError("private_store_invalid");
    const checked = raw as unknown as OutcomeObservationResult;
    if (!HASH.test(checked.caseVersion) || seen.has(checked.caseVersion) || (checked.disposition !== "recoverable_false_negative" && checked.disposition !== "valid_empty") || !Array.isArray(checked.shippedWindows) ||
        ![checked.approvedHits, checked.forbiddenHits, checked.keepFalseShipped, checked.explicitGateResurrections, checked.candidateCap, checked.criticBatches].every(nonnegativeInt)) throw new OutcomeGateError("private_store_invalid");
    seen.add(checked.caseVersion);
    for (const window of checked.shippedWindows) if (!exact(window, ["start", "end"]) || typeof window.start !== "number" || !Number.isFinite(window.start) || typeof window.end !== "number" || !Number.isFinite(window.end) || window.start < 0 || window.end <= window.start) throw new OutcomeGateError("private_store_invalid");
  }
  const { observationId: _id, ...body } = item;
  if (sha256(canonicalJson(body)) !== wantedId) throw new OutcomeGateError("private_store_invalid");
  return item;
}

async function readPrivate(path: string): Promise<{ bytes: Buffer; modifiedAt: Date }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const first = await handle.stat();
    if (!first.isFile() || first.nlink !== 1 || (first.mode & 0o7777) !== FILE_MODE || first.size <= 0 || first.size > 16 * 1024 * 1024) throw new Error();
    const bytes = await handle.readFile(); const last = await handle.stat();
    if (last.dev !== first.dev || last.ino !== first.ino || last.size !== first.size || last.mtimeMs !== first.mtimeMs) throw new Error();
    return { bytes, modifiedAt: new Date(first.mtimeMs) };
  } catch { throw new OutcomeGateError("private_store_invalid"); }
  finally { await handle?.close().catch(() => undefined); }
}

export async function readOutcomeObservation(id: Sha256, root = DEFAULT_OUTCOME_ROOT): Promise<LoadedOutcomeObservation> {
  if (!HASH.test(id)) throw new OutcomeGateError("invalid_input");
  const loaded = await readPrivate(join(root, "observations", id, "results.jsonl"));
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(loaded.bytes).trimEnd()); } catch { throw new OutcomeGateError("private_store_invalid"); }
  return Object.freeze({ observation: parseObservation(value, id), observedAt: loaded.modifiedAt });
}

function decisionBody(input: DecideOutcomeGateInput, clip: GateDecision, candidate: OutcomeObservation, createdAt: string, expiresAt: string, metrics: OutcomeGateMetrics, verdict: "pass" | "fail", reasons: readonly OutcomeGateReason[]) {
  return { schemaVersion: 1 as const, policyVersion: OUTCOME_POLICY_VERSION, clipDecisionId: input.clipDecisionId, candidateCommitSha: candidate.commitSha,
    configSha256: clip.configSha256, outcomeEngineFingerprint: candidate.engineFingerprint, outcomeCorpusDigest: candidate.corpusDigest,
    runnerVersion: candidate.runnerVersion, baselineObservationId: input.baselineObservationId, candidateObservationId: input.candidateObservationId,
    createdAt, expiresAt, metrics, verdict, reasons };
}

export function outcomeDecisionReport(decision: OutcomeGateDecision): string {
  return ["# Outcome recovery quality gate", "", `verdict: ${decision.verdict}`, `reasons: ${decision.reasons.join(",") || "none"}`,
    `candidate_commit: ${decision.candidateCommitSha}`, `config: ${decision.configSha256}`, `outcome_engine: ${decision.outcomeEngineFingerprint}`,
    `outcome_corpus: ${decision.outcomeCorpusDigest}`, `runner: ${decision.runnerVersion}`, `metrics: ${canonicalJson(decision.metrics)}`,
    `clip_decision: ${decision.clipDecisionId}`, `decision: ${decision.decisionId}`, ""].join("\n");
}

async function publishDefault(decision: OutcomeGateDecision, report: string, root: string): Promise<CommitResult> {
  const paths = await ensureOutcomeStore(root); let parent: FileHandle | undefined; let temporaryName: string | undefined;
  const decisionBytes = Buffer.from(`${canonicalJson(decision)}\n`); const reportBytes = Buffer.from(report);
  try {
    parent = await open(paths.decisionsDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentInfo = await parent.stat(); if (!parentInfo.isDirectory() || (parentInfo.mode & 0o7777) !== DIRECTORY_MODE) throw new Error();
    const finalPath = join(`/proc/self/fd/${parent.fd}`, decision.decisionId);
    try {
      const names = await readdir(finalPath); if (names.sort().join(",") !== "decision.json,report.md") throw new Error();
      const [storedDecision, storedReport] = await Promise.all([readPrivate(join(finalPath, "decision.json")), readPrivate(join(finalPath, "report.md"))]);
      if (!storedDecision.bytes.equals(decisionBytes) || !storedReport.bytes.equals(reportBytes)) throw new Error();
      return { status: "noop" };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    temporaryName = `.tmp-${randomBytes(12).toString("hex")}`; const temporaryPath = join(`/proc/self/fd/${parent.fd}`, temporaryName);
    await mkdir(temporaryPath, { mode: DIRECTORY_MODE }); const temporary = await open(temporaryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const [name, bytes] of [["decision.json", decisionBytes], ["report.md", reportBytes]] as const) {
        const file = await open(join(`/proc/self/fd/${temporary.fd}`, name), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, FILE_MODE);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      }
      await temporary.sync();
    } finally { await temporary.close(); }
    await rename(temporaryPath, finalPath); temporaryName = undefined; await parent.sync(); return { status: "committed" };
  } catch { throw new OutcomeGateError("publication_failed"); }
  finally { if (temporaryName && parent) await rm(join(`/proc/self/fd/${parent.fd}`, temporaryName), { recursive: true, force: true }).catch(() => undefined); await parent?.close().catch(() => undefined); }
}

export async function decideOutcomeRecoveryGate(input: DecideOutcomeGateInput, dependencies: OutcomeGateDependencies = {}): Promise<OutcomeGateDecision> {
  if (!input || !HASH.test(input.baselineObservationId) || !HASH.test(input.candidateObservationId) || !DECISION_ID.test(input.clipDecisionId) || !HASH.test(input.expectedCandidateEngineFingerprint) || typeof input.customerOutputsMatch !== "boolean") throw new OutcomeGateError("invalid_input");
  const root = dependencies.root ?? DEFAULT_OUTCOME_ROOT; const clipRoot = dependencies.clipRoot ?? dirname(root); const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new OutcomeGateError("invalid_input");
  const loadObservation = dependencies.loadObservation ?? readOutcomeObservation;
  let baseline: LoadedOutcomeObservation | undefined; let candidate: LoadedOutcomeObservation | undefined; let labels: readonly OutcomeLabel[] = []; let clip: GateDecision | undefined; let clipEvidence: ClipCaseEvidence | undefined;
  try {
    [baseline, candidate, labels, clip] = await Promise.all([
      loadObservation(input.baselineObservationId, root), loadObservation(input.candidateObservationId, root),
      (dependencies.loadLabels ?? readActiveOutcomeLabels)(root), (dependencies.loadClipDecision ?? readGateDecision)(input.clipDecisionId, clipRoot, now),
    ]);
    clipEvidence = await (dependencies.loadClipEvidence ?? readGateCaseEvidence)(clip, clipRoot);
  } catch { /* policy publishes a fail-closed missing-input decision */ }
  const fallback = (mode: "baseline" | "candidate"): OutcomeObservation => ({ schemaVersion: 1, observationId: mode === "baseline" ? input.baselineObservationId : input.candidateObservationId, mode, commitSha: "0".repeat(40), engineFingerprint: `sha256:${"0".repeat(64)}`, corpusDigest: `sha256:${"0".repeat(64)}`, runnerVersion: OUTCOME_OBSERVATION_RUNNER_VERSION, recordedResponsesDigest: `sha256:${"0".repeat(64)}`, results: [] });
  const selectedBaseline = baseline?.observation ?? fallback("baseline"); const selectedCandidate = candidate?.observation ?? fallback("candidate");
  const selectedClip = clip ?? ({ decisionId: input.clipDecisionId, candidateCommitSha: "0".repeat(40), configSha256: `sha256:${"0".repeat(64)}`, verdict: "fail", createdAt: now.toISOString(), expiresAt: now.toISOString() } as GateDecision);
  const freshness = [baseline?.observedAt, candidate?.observedAt, clip ? new Date(clip.createdAt) : undefined].filter((value): value is Date => value instanceof Date);
  const inputsFresh = freshness.length === 3 && freshness.every((value) => value.getTime() <= now.getTime() && value.getTime() + DAY_MS > now.getTime()) && new Date(selectedClip.expiresAt).getTime() > now.getTime();
  const boundFingerprint = selectedCandidate.commitSha === selectedClip.candidateCommitSha && selectedCandidate.engineFingerprint === input.expectedCandidateEngineFingerprint;
  const policy = decideOutcomeGate({ baseline: selectedBaseline, candidate: selectedCandidate,
    cases: labels.filter((label) => label.disposition !== "exclude").map((label) => ({ caseVersion: label.caseVersion, disposition: label.disposition as "recoverable_false_negative" | "valid_empty", set: label.set! })),
    expectedCandidateEngineFingerprint: boundFingerprint ? input.expectedCandidateEngineFingerprint : `sha256:${"f".repeat(64)}`,
    customerOutputsMatch: input.customerOutputsMatch, clip: { verdict: selectedClip.verdict, positiveCases: clipEvidence?.positiveCases ?? 0, confirmedNegativeCases: clipEvidence?.confirmedNegativeCases ?? 0,
      selectionNegativeCases: clipEvidence?.selectionNegativeCases ?? 0, positiveLosses: clipEvidence?.positiveLosses ?? 0, confirmedNegativeWorsening: clipEvidence?.confirmedNegativeWorsening ?? 0 },
    inputsPresent: Boolean(baseline && candidate && clip && clipEvidence), inputsFresh });
  const createdAt = now.toISOString(); const expiresAt = new Date(now.getTime() + DAY_MS).toISOString();
  const body = decisionBody(input, selectedClip, selectedCandidate, createdAt, expiresAt, policy.metrics, policy.verdict, policy.reasons);
  const decision = Object.freeze({ ...body, decisionId: `outcome-decision:${sha256(canonicalJson(body))}` }) as OutcomeGateDecision;
  const committed = await (dependencies.publishDecision ?? publishDefault)(decision, outcomeDecisionReport(decision), root);
  if (committed.status !== "committed" && committed.status !== "noop") throw new OutcomeGateError("publication_failed");
  return decision;
}

export async function readOutcomeGateDecision(id: string, root = DEFAULT_OUTCOME_ROOT, now = new Date()): Promise<OutcomeGateDecision> {
  if (!OUTCOME_DECISION_ID.test(id) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new OutcomeGateError("invalid_input");
  const directory = join(root, "decisions", id); const names = await readdir(directory).catch(() => { throw new OutcomeGateError("private_store_invalid"); });
  if (names.sort().join(",") !== "decision.json,report.md") throw new OutcomeGateError("private_store_invalid");
  const [decisionFile, reportFile] = await Promise.all([readPrivate(join(directory, "decision.json")), readPrivate(join(directory, "report.md"))]);
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(decisionFile.bytes)); } catch { throw new OutcomeGateError("private_store_invalid"); }
  const keys = ["schemaVersion", "decisionId", "policyVersion", "clipDecisionId", "candidateCommitSha", "configSha256", "outcomeEngineFingerprint", "outcomeCorpusDigest", "runnerVersion", "baselineObservationId", "candidateObservationId", "createdAt", "expiresAt", "metrics", "verdict", "reasons"];
  if (!exact(parsed, keys)) throw new OutcomeGateError("private_store_invalid"); const decision = parsed as unknown as OutcomeGateDecision;
  const { decisionId: _id, ...body } = decision;
  if (decision.decisionId !== id || `outcome-decision:${sha256(canonicalJson(body))}` !== id || decision.schemaVersion !== 1 || decision.policyVersion !== OUTCOME_POLICY_VERSION || !DECISION_ID.test(decision.clipDecisionId) || !COMMIT.test(decision.candidateCommitSha) || !HASH.test(decision.configSha256) || !HASH.test(decision.outcomeEngineFingerprint) || !HASH.test(decision.outcomeCorpusDigest) || decision.runnerVersion !== OUTCOME_OBSERVATION_RUNNER_VERSION || !HASH.test(decision.baselineObservationId) || !HASH.test(decision.candidateObservationId) || !utc(decision.createdAt) || !utc(decision.expiresAt) || new Date(decision.createdAt).getTime() > now.getTime() || new Date(decision.expiresAt).getTime() <= now.getTime() || new Date(decision.expiresAt).getTime() > new Date(decision.createdAt).getTime() + DAY_MS || (decision.verdict !== "pass" && decision.verdict !== "fail") || !validReasons(decision.reasons) || !validMetrics(decision.metrics) || (decision.verdict === "pass" ? decision.reasons.length !== 0 : decision.reasons.length === 0) || reportFile.bytes.toString("utf8") !== outcomeDecisionReport(decision)) throw new OutcomeGateError("private_store_invalid");
  return decision;
}
