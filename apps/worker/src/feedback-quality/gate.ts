import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import {
  contentId,
  DEFAULT_QUALITY_ROOT,
  publishBundle,
  readBundle,
  type CommitResult,
} from "./store";
import { readObservationAttempts, type ObservationAttemptRecord } from "./observe";
import { compareObservations } from "./policy";
import type {
  GateAggregate,
  GatePolicy,
  GateComparison,
  MachineReason,
  QualityCaseResult,
  QualityClaim,
  QualityObservation,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OBSERVATION_FILES = new Set(["manifest.json", "results.jsonl"]);
const REASON_ORDER: readonly MachineReason[] = [
  "invalid_schema", "invalid_metric", "duplicate_case_version", "missing_case", "stale_case", "error_case",
  "set_mismatch", "mode_mismatch", "corpus_mismatch", "config_mismatch", "runner_mismatch", "insufficient_corpus",
  "case_mismatch", "positive_regression", "negative_regression", "hard_invariant_regression", "aggregate_regression", "no_improvement",
];
const MANIFEST_KEYS = new Set([
  "schemaVersion", "observationId", "set", "mode", "live", "commitSha", "configSha256",
  "corpusSha256", "runnerVersion", "createdAt", "caseVersions", "attemptCount", "attemptsSha256",
]);

export type DecideGateInput = Readonly<{
  baselineEvalObservationId: string;
  candidateEvalObservationId: string;
  baselineHoldoutObservationId: string;
  candidateHoldoutObservationId: string;
  claim?: QualityClaim | "non-regression";
  policy: GatePolicy;
}>;

export type GateSetSummary = Readonly<{
  positiveCount: number;
  negativeCount: number;
  baseline: GateAggregate;
  candidate: GateAggregate;
}>;

export type GateDecision = Readonly<{
  schemaVersion: 1;
  decisionId: string;
  claim: QualityClaim;
  policyVersion: string;
  candidateCommitSha: string;
  configSha256: string;
  corpusSha256: string;
  runnerVersion: number;
  baselineEvalObservationId: string;
  candidateEvalObservationId: string;
  baselineHoldoutObservationId: string;
  candidateHoldoutObservationId: string;
  createdAt: string;
  expiresAt: string;
  eval: GateSetSummary;
  holdout: GateSetSummary;
  verdict: "pass" | "fail";
  reasons: MachineReason[];
}>;

export type GateDependencies = Readonly<{
  root?: string;
  now?: () => Date;
  readObservation?: (id: string, root?: string) => Promise<QualityObservation>;
  readAttempts?: typeof readObservationAttempts;
  readBundle?: typeof readBundle;
  publishDecision?: (decision: GateDecision, report: string, root: string) => Promise<CommitResult>;
  /** Alias kept for thin test/host adapters; production uses publishDecision. */
  publish?: (decision: GateDecision, report: string, root: string) => Promise<CommitResult>;
}>;

export class GateError extends Error {
  constructor(readonly code: "invalid_input" | "observation_invalid" | "publish_failed") {
    super(code);
    this.name = "GateError";
  }
}

const emptyAggregate = (): GateAggregate => ({
  positiveRetention: 0,
  negativeDefects: 0,
  zeroClipFalseNegatives: 0,
  boundaryErrors: 0,
  focalFailures: 0,
  subtitleFailures: 0,
});
const emptySummary = (): GateSetSummary => ({ positiveCount: 0, negativeCount: 0, baseline: emptyAggregate(), candidate: emptyAggregate() });
const zeroHash = (): `sha256:${string}` => `sha256:${"0".repeat(64)}`;
const zeroObservation = (id: string, set: "eval" | "holdout", mode: "baseline" | "candidate", now: string): QualityObservation => ({
  schemaVersion: 1, observationId: id, mode, set, commitSha: "0".repeat(40), configSha256: zeroHash(), corpusSha256: zeroHash(), runnerVersion: 0, createdAt: now, cases: [],
});

function ownKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string" || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, "value"));
  });
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validManifest(value: unknown, id: string): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (!ownKeys(manifest, MANIFEST_KEYS)) return false;
  return manifest.schemaVersion === 1 && manifest.observationId === id &&
    (manifest.set === "eval" || manifest.set === "holdout") &&
    (manifest.mode === "baseline" || manifest.mode === "candidate") && typeof manifest.live === "boolean" &&
    SHA1.test(String(manifest.commitSha)) && SHA256.test(String(manifest.configSha256)) && SHA256.test(String(manifest.corpusSha256)) &&
    Number.isSafeInteger(manifest.runnerVersion) && (manifest.runnerVersion as number) >= 0 && validTimestamp(manifest.createdAt) &&
    Array.isArray(manifest.caseVersions) && manifest.caseVersions.length > 0 && manifest.caseVersions.every((item) => typeof item === "string") &&
    [...(manifest.caseVersions as string[])].sort().join("\n") === (manifest.caseVersions as string[]).join("\n") &&
    new Set(manifest.caseVersions as string[]).size === (manifest.caseVersions as string[]).length &&
    Number.isSafeInteger(manifest.attemptCount) && (manifest.attemptCount as number) > 0 && SHA256.test(String(manifest.attemptsSha256));
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function firstAttempt(attempts: readonly ObservationAttemptRecord[], caseVersion: string, live: boolean): ObservationAttemptRecord | undefined {
  const preferred = live ? "live-1" : "recorded";
  return attempts.find((item) => item.caseVersion === caseVersion && item.attemptName === preferred);
}

function validResult(result: QualityCaseResult, caseVersion: string): boolean {
  return result && result.schemaVersion === 1 && result.caseVersion === caseVersion &&
    (result.disposition === "positive" || result.disposition === "confirmed_negative" || result.disposition === "exclude") &&
    (result.subsystem === "selection" || result.subsystem === "boundary" || result.subsystem === "framing" || result.subsystem === "subtitles" || result.subsystem === "render") &&
    (result.status === "ok" || result.status === "missing" || result.status === "stale" || result.status === "error") &&
    Boolean(result.metrics && typeof result.metrics === "object" && !Array.isArray(result.metrics));
}

/** Strictly reconstruct an observation body from the two immutable files. */
async function readStoredObservation(
  id: string,
  root: string,
  readBundleFn: typeof readBundle,
  readAttemptsFn: typeof readObservationAttempts,
): Promise<QualityObservation> {
  if (!/^observation:sha256:[0-9a-f]{64}$/.test(id)) throw new GateError("observation_invalid");
  let files: ReadonlyMap<string, Uint8Array>;
  let attempts: readonly ObservationAttemptRecord[];
  try {
    files = await readBundleFn("observation", id, root);
    attempts = await readAttemptsFn(id, root);
  } catch {
    throw new GateError("observation_invalid");
  }
  if (files.size !== OBSERVATION_FILES.size || [...files.keys()].some((name) => !OBSERVATION_FILES.has(name))) throw new GateError("observation_invalid");
  let manifest: unknown;
  try { manifest = JSON.parse(Buffer.from(files.get("manifest.json")!).toString("utf8")); } catch { throw new GateError("observation_invalid"); }
  if (!validManifest(manifest, id)) throw new GateError("observation_invalid");
  const caseVersions = manifest.caseVersions as string[];
  const results: QualityCaseResult[] = [];
  for (const caseVersion of caseVersions) {
    const first = firstAttempt(attempts, caseVersion, manifest.live as boolean);
    if (!first || !validResult(first.result, caseVersion)) throw new GateError("observation_invalid");
    const all = attempts.filter((item) => item.caseVersion === caseVersion);
    /* Every independently stored result must remain a valid result for the
     * same immutable case. A failed attempt is represented in the body so the
     * policy emits its closed stale/error reason instead of silently skipping. */
    const inconsistent = all.some((item) => !validResult(item.result, caseVersion) || item.result.status !== "ok" || item.result.disposition !== first.result.disposition || item.result.subsystem !== first.result.subsystem);
    results.push(inconsistent ? { ...first.result, status: "error" } : first.result);
  }
  const body = { schemaVersion: 1 as const, mode: manifest.mode, set: manifest.set, commitSha: manifest.commitSha, configSha256: manifest.configSha256, corpusSha256: manifest.corpusSha256, runnerVersion: manifest.runnerVersion, cases: results } as QualityObservation;
  if (contentId("observation", body) !== id) throw new GateError("observation_invalid");
  return Object.freeze({ ...body, observationId: id, createdAt: manifest.createdAt as string });
}

function normalizeClaim(claim: DecideGateInput["claim"]): QualityClaim {
  if (claim === "non-regression") return "non_regression_only";
  if (claim === "improvement" || claim === "non_regression_only") return claim;
  throw new GateError("invalid_input");
}

function safeNow(dependencies: GateDependencies): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new GateError("invalid_input");
  return now;
}

function countSummary(comparison: GateComparison, baseline: QualityObservation, candidate: QualityObservation): GateSetSummary {
  const count = (observation: QualityObservation, disposition: "positive" | "confirmed_negative") => observation.cases.filter((item) => item.disposition === disposition).length;
  return { positiveCount: count(candidate, "positive"), negativeCount: count(candidate, "confirmed_negative"), baseline: comparison.baseline, candidate: comparison.candidate };
}

function identityReasons(left: QualityObservation, right: QualityObservation): MachineReason[] {
  const reasons: MachineReason[] = [];
  if (left.commitSha !== right.commitSha) reasons.push("case_mismatch");
  if (left.configSha256 !== right.configSha256) reasons.push("config_mismatch");
  if (left.corpusSha256 !== right.corpusSha256) reasons.push("corpus_mismatch");
  if (left.runnerVersion !== right.runnerVersion) reasons.push("runner_mismatch");
  return reasons;
}

function redactedReport(decision: Omit<GateDecision, "decisionId"> & { decisionId: string }): string {
  return [
    "# Feedback quality gate",
    "",
    `verdict: ${decision.verdict}`,
    `reasons: ${decision.reasons.join(",") || "none"}`,
    `candidate_commit: ${decision.candidateCommitSha}`,
    `config: ${decision.configSha256}`,
    `corpus: ${decision.corpusSha256}`,
    `runner: ${decision.runnerVersion}`,
    `eval: ${canonicalJson(decision.eval)}`,
    `holdout: ${canonicalJson(decision.holdout)}`,
    `observations: ${decision.baselineEvalObservationId},${decision.candidateEvalObservationId},${decision.baselineHoldoutObservationId},${decision.candidateHoldoutObservationId}`,
    `decision: ${decision.decisionId}`,
    "",
  ].join("\n");
}

function decisionBody(input: DecideGateInput, claim: QualityClaim, now: string, expiresAt: string, candidate: QualityObservation, evalSummary: GateSetSummary, holdoutSummary: GateSetSummary, verdict: "pass" | "fail", reasons: MachineReason[]) {
  return {
    schemaVersion: 1 as const,
    claim,
    policyVersion: input.policy.policyVersion,
    candidateCommitSha: candidate.commitSha,
    configSha256: candidate.configSha256,
    corpusSha256: candidate.corpusSha256,
    runnerVersion: candidate.runnerVersion,
    baselineEvalObservationId: input.baselineEvalObservationId,
    candidateEvalObservationId: input.candidateEvalObservationId,
    baselineHoldoutObservationId: input.baselineHoldoutObservationId,
    candidateHoldoutObservationId: input.candidateHoldoutObservationId,
    createdAt: now,
    expiresAt,
    eval: evalSummary,
    holdout: holdoutSummary,
    verdict,
    reasons,
  };
}

async function publishDefault(decision: GateDecision, report: string, root: string): Promise<CommitResult> {
  return publishBundle({ kind: "decision", id: decision.decisionId, files: { "decision.json": Buffer.from(canonicalJson(decision) + "\n"), "report.md": Buffer.from(report, "utf8") } }, root);
}

/** Run eval first; holdout is intentionally unreachable until eval passes. */
export async function decideGate(input: DecideGateInput, dependencies: GateDependencies = {}): Promise<GateDecision> {
  const claim = normalizeClaim(input.claim ?? input.policy.claim);
  if (input.policy.claim !== claim) throw new GateError("invalid_input");
  const root = dependencies.root ?? DEFAULT_QUALITY_ROOT;
  const nowDate = safeNow(dependencies);
  const now = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + DAY_MS).toISOString();
  const read = dependencies.readObservation ?? ((id: string, readRoot?: string) => readStoredObservation(id, readRoot ?? root, dependencies.readBundle ?? readBundle, dependencies.readAttempts ?? readObservationAttempts));
  const ids = [input.baselineEvalObservationId, input.candidateEvalObservationId, input.baselineHoldoutObservationId, input.candidateHoldoutObservationId];
  let baselineEval = zeroObservation(input.baselineEvalObservationId, "eval", "baseline", now);
  let candidateEval = zeroObservation(input.candidateEvalObservationId, "eval", "candidate", now);
  let evalComparison: GateComparison = { verdict: "fail", reasons: ["invalid_schema"], baseline: emptyAggregate(), candidate: emptyAggregate() };
  let extraReasons: MachineReason[] = [];
  try {
    baselineEval = await read(ids[0], root);
    candidateEval = await read(ids[1], root);
    if ([baselineEval, candidateEval].some((item) => new Date(item.createdAt).getTime() + DAY_MS <= nowDate.getTime())) extraReasons.push("stale_case");
    evalComparison = extraReasons.length ? { verdict: "fail", reasons: extraReasons, baseline: emptyAggregate(), candidate: emptyAggregate() } : compareObservations(baselineEval, candidateEval, { ...input.policy, claim });
  } catch {
    evalComparison = { verdict: "fail", reasons: ["invalid_schema"], baseline: emptyAggregate(), candidate: emptyAggregate() };
  }
  const evalSummary = countSummary(evalComparison, baselineEval, candidateEval);
  let holdoutSummary = emptySummary();
  let reasons = [...evalComparison.reasons];
  let candidateForBinding = candidateEval;
  if (evalComparison.verdict === "pass") {
    try {
      const baselineHoldout = await read(input.baselineHoldoutObservationId, root);
      const candidateHoldout = await read(input.candidateHoldoutObservationId, root);
      candidateForBinding = candidateEval;
      const stale = [baselineHoldout, candidateHoldout].some((item) => new Date(item.createdAt).getTime() + DAY_MS <= nowDate.getTime());
      const holdoutComparison = stale ? { verdict: "fail" as const, reasons: ["stale_case" as MachineReason], baseline: emptyAggregate(), candidate: emptyAggregate() } : compareObservations(baselineHoldout, candidateHoldout, { ...input.policy, claim });
      holdoutSummary = countSummary(holdoutComparison, baselineHoldout, candidateHoldout);
      reasons = [...reasons, ...holdoutComparison.reasons, ...identityReasons(candidateEval, candidateHoldout), ...identityReasons(baselineEval, baselineHoldout)];
    } catch {
      reasons.push("invalid_schema");
    }
  }
  const present = new Set(reasons);
  reasons = REASON_ORDER.filter((reason) => present.has(reason));
  const verdict = reasons.length === 0 ? "pass" : "fail";
  const base = decisionBody(input, claim, now, expiresAt, candidateForBinding, evalSummary, holdoutSummary, verdict, reasons);
  const decision = Object.freeze({ ...base, decisionId: contentId("decision", base) }) as GateDecision;
  const report = redactedReport(decision);
  const publish = dependencies.publishDecision ?? dependencies.publish ?? publishDefault;
  const published = await publish(decision, report, root);
  if (published.status !== "committed" && published.status !== "noop") throw new GateError("publish_failed");
  return decision;
}

export { readStoredObservation };
