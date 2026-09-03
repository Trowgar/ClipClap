import { canonicalJson } from "../feedback-learning/canonical";
import {
  contentId,
  DEFAULT_QUALITY_ROOT,
  publishBundle,
  readBundle,
  type CommitResult,
} from "./store";
import { observationIdFor, parseObservationSnapshot, type ObservationAttemptRecord, type ObservationIdentityBody } from "./observe";
import { compareObservations, validateQualityCaseResult, validateQualityObservation } from "./policy";
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
const OBSERVATION_FILES = new Set(["manifest.json", "results.jsonl"]);
export const GATE_REASON_ORDER: readonly MachineReason[] = [
  "invalid_schema", "invalid_metric", "duplicate_case_version", "missing_case", "stale_case", "error_case",
  "set_mismatch", "mode_mismatch", "corpus_mismatch", "config_mismatch", "runner_mismatch", "insufficient_corpus",
  "case_mismatch", "positive_regression", "negative_regression", "hard_invariant_regression", "aggregate_regression", "no_improvement",
];

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
  attemptCount: number;
  varianceCaseCount: number;
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

type GateBundleReader = (kind: "observation" | "decision", id: string, root?: string) => ReturnType<typeof readBundle>;
export type GateDependencies = Readonly<{
  root?: string;
  now?: () => Date;
  readBundle?: GateBundleReader;
  publishDecision?: (decision: GateDecision, report: string, root: string) => Promise<CommitResult>;
  /** Alias kept for thin test/host adapters; production uses publishDecision. */
  publish?: (decision: GateDecision, report: string, root: string) => Promise<CommitResult>;
}>;

export class GateError extends Error {
  constructor(readonly code: "invalid_input" | "observation_invalid" | "set_mismatch" | "publish_failed") {
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
const emptySummary = (): GateSetSummary => ({ positiveCount: 0, negativeCount: 0, attemptCount: 0, varianceCaseCount: 0, baseline: emptyAggregate(), candidate: emptyAggregate() });
const zeroHash = (): `sha256:${string}` => `sha256:${"0".repeat(64)}`;
const zeroObservation = (id: string, set: "eval" | "holdout", mode: "baseline" | "candidate", now: string): QualityObservation => ({
  schemaVersion: 1, observationId: id, mode, set, commitSha: "0".repeat(40), configSha256: zeroHash(), corpusSha256: zeroHash(), runnerVersion: 0, createdAt: now, cases: [],
});

/** Strictly reconstruct an observation body from the two immutable files. */
async function readStoredObservation(
  id: string,
  root: string,
  readBundleFn: GateBundleReader,
): Promise<{ observation: QualityObservation; attempts: readonly ObservationAttemptRecord[] }> {
  if (!/^observation:sha256:[0-9a-f]{64}$/.test(id)) throw new GateError("observation_invalid");
  let files: ReadonlyMap<string, Uint8Array>;
  try {
    files = await readBundleFn("observation", id, root);
  } catch {
    throw new GateError("observation_invalid");
  }
  if (files.size !== OBSERVATION_FILES.size || [...files.keys()].some((name) => !OBSERVATION_FILES.has(name))) throw new GateError("observation_invalid");
  let snapshot: ReturnType<typeof parseObservationSnapshot>;
  try { snapshot = parseObservationSnapshot(files.get("manifest.json")!, files.get("results.jsonl")!, id); }
  catch { throw new GateError("observation_invalid"); }
  const { manifest, attempts } = snapshot;
  const caseVersions = [...manifest.caseVersions];
  const results: QualityCaseResult[] = [];
  for (const caseVersion of caseVersions) {
    const preferred = manifest.live ? "live-1" : "recorded";
    const first = attempts.find((item) => item.caseVersion === caseVersion && item.attemptName === preferred);
    if (!first) throw new GateError("observation_invalid");
    const all = attempts.filter((item) => item.caseVersion === caseVersion);
    /* Every independently stored result must remain a valid result for the
     * same immutable case. A failed attempt is represented in the body so the
     * policy emits its closed stale/error reason instead of silently skipping. */
    const inconsistent = all.some((item) => item.result.status !== "ok" || item.result.disposition !== first.result.disposition || item.result.subsystem !== first.result.subsystem);
    results.push(inconsistent ? { ...first.result, status: "error" } : first.result);
  }
  const body: ObservationIdentityBody = { schemaVersion: 1 as const, mode: manifest.mode, set: manifest.set, commitSha: manifest.commitSha, configSha256: manifest.configSha256, corpusSha256: manifest.corpusSha256, runnerVersion: manifest.runnerVersion, live: manifest.live, caseVersions, attemptCount: manifest.attemptCount, attemptsSha256: manifest.attemptsSha256, cases: results };
  if (observationIdFor(body) !== id) throw new GateError("observation_invalid");
  return { observation: Object.freeze({ ...body, observationId: id, createdAt: manifest.createdAt }) as QualityObservation, attempts: Object.freeze(attempts) };
}

type LoadedObservation = Readonly<{
  observation: QualityObservation;
  attempts: readonly ObservationAttemptRecord[];
}>;

function metricKeys(value: QualityCaseResult): string[] {
  return Object.keys(value.metrics).sort();
}

function equalKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function numericMetric(value: QualityCaseResult, key: string): number {
  const metric = value.metrics[key as keyof typeof value.metrics];
  return typeof metric === "number" ? metric : 0;
}

const HIGHER_IS_BETTER = new Set(["approvedMomentRetained", "approvedWindowOverlap", "positiveRetention", "payoffContainment", "score"]);
const HARD_EXACT = new Set(["outputWidth", "outputHeight", "sar"]);

/** Validate every attempt and collapse it to a conservative envelope. The
 * envelope is only used for the ordinary non-regression comparison; claim
 * improvement is checked independently against each live attempt below. */
function envelope(loaded: LoadedObservation): LoadedObservation & { varianceCaseCount: number; attemptCount: number } {
  const { observation, attempts } = loaded;
  if (!Array.isArray(attempts) || attempts.length === 0) throw new GateError("observation_invalid");
  const byCase = new Map<string, ObservationAttemptRecord[]>();
  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== "object" || typeof attempt.caseVersion !== "string" || typeof attempt.attemptName !== "string" || !attempt.result || typeof attempt.result !== "object") throw new GateError("observation_invalid");
    if (validateQualityCaseResult(attempt.result)) throw new GateError("observation_invalid");
    const expected = observation.cases.find((item) => item.caseVersion === attempt.caseVersion);
    if (!expected || expected.disposition !== attempt.result.disposition || expected.subsystem !== attempt.result.subsystem) throw new GateError("observation_invalid");
    const group = byCase.get(attempt.caseVersion) ?? [];
    group.push(attempt);
    byCase.set(attempt.caseVersion, group);
  }
  const expectedNames = new Set(attempts.map((item) => item.attemptName));
  const expectedNameList = [...expectedNames].sort();
  const liveNames = ["live-1", "live-2", "live-3"];
  const expectedReplayNames = expectedNameList.some((name) => name.startsWith("live-")) ? liveNames : ["recorded"];
  if (!equalKeys(expectedReplayNames, expectedNameList)) throw new GateError("observation_invalid");
  if (observation.live !== (expectedReplayNames.length === 3)) throw new GateError("observation_invalid");
  if (byCase.size !== observation.cases.length || [...byCase.keys()].some((key) => !observation.cases.some((item) => item.caseVersion === key))) throw new GateError("observation_invalid");
  const cases: QualityCaseResult[] = [];
  let varianceCaseCount = 0;
  for (const base of observation.cases) {
    const group = byCase.get(base.caseVersion);
    if (!group || group.length !== expectedNames.size) throw new GateError("observation_invalid");
    const actualNames = group.map((item) => item.attemptName).sort();
    if (!equalKeys(expectedNameList, actualNames)) throw new GateError("observation_invalid");
    const first = group[0].result;
    const keys = metricKeys(first);
    if (group.some((item) => !equalKeys(keys, metricKeys(item.result)))) throw new GateError("observation_invalid");
    const metrics: Record<string, number> = {};
    for (const key of keys) {
      const values = group.map((item) => numericMetric(item.result, key));
      if (values.some((value) => value !== values[0])) varianceCaseCount += 1;
      if (HARD_EXACT.has(key) && values.some((value) => value !== values[0])) throw new GateError("observation_invalid");
      metrics[key] = HIGHER_IS_BETTER.has(key) ? Math.min(...values) : Math.max(...values);
    }
    const anyFailure = group.some((item) => item.result.status !== "ok");
    cases.push({ ...first, status: anyFailure ? "error" : first.status, metrics });
  }
  return {
    observation: Object.freeze({ ...observation, cases: Object.freeze(cases) }) as unknown as QualityObservation,
    attempts,
    varianceCaseCount,
    attemptCount: expectedNames.size,
  };
}

async function loadObservation(
  id: string,
  expectedSet: "eval" | "holdout",
  root: string,
  dependencies: GateDependencies,
): Promise<LoadedObservation> {
  const stored = await readStoredObservation(id, root, dependencies.readBundle ?? readBundle);
  const observation = stored.observation;
  const attempts = stored.attempts;
  if (observation.observationId !== id) throw new GateError("observation_invalid");
  /* Role separation precedes metric inspection: a holdout bundle supplied as
   * eval (or vice versa) is rejected without consulting its measurements. */
  if (validateQualityObservation(observation, false)) throw new GateError("observation_invalid");
  if (observation.set !== expectedSet) throw new GateError("set_mismatch");
  if (validateQualityObservation(observation, true, true)) throw new GateError("observation_invalid");
  const { observationId: _observationId, createdAt: _createdAt, ...identityBody } = observation;
  if (observationIdFor(identityBody as ObservationIdentityBody) !== id) throw new GateError("observation_invalid");
  return envelope({ observation, attempts });
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

function countSummary(comparison: GateComparison, baseline: QualityObservation, candidate: QualityObservation, baselineLoaded?: LoadedObservation, candidateLoaded?: LoadedObservation): GateSetSummary {
  const count = (observation: QualityObservation, disposition: "positive" | "confirmed_negative") => observation.cases.filter((item) => item.disposition === disposition).length;
  const candidateAttempts = candidateLoaded?.attempts ?? [];
  const attemptCount = candidateAttempts.length > 0 ? new Set(candidateAttempts.map((item) => item.attemptName)).size : 1;
  const varianceCaseCount = candidateAttempts.length > 0 ? (() => { try { return envelope(candidateLoaded!).varianceCaseCount; } catch { return 0; } })() : 0;
  return { positiveCount: count(candidate, "positive"), negativeCount: count(candidate, "confirmed_negative"), attemptCount, varianceCaseCount, baseline: comparison.baseline, candidate: comparison.candidate };
}

function attemptObservation(observation: QualityObservation, attempts: readonly ObservationAttemptRecord[], attemptName: string): QualityObservation {
  const byCase = new Map(attempts.filter((item) => item.attemptName === attemptName).map((item) => [item.caseVersion, item.result]));
  return { ...observation, cases: observation.cases.map((item) => byCase.get(item.caseVersion) ?? { ...item, status: "error" }) };
}

function staleObservation(observation: QualityObservation, now: Date): boolean {
  return new Date(observation.createdAt).getTime() + DAY_MS <= now.getTime();
}

function compareLoadedPair(baseline: LoadedObservation, candidate: LoadedObservation, expectedSet: "eval" | "holdout", policy: GatePolicy, claim: QualityClaim): GateComparison {
  if (baseline.observation.set !== expectedSet || candidate.observation.set !== expectedSet) return { verdict: "fail", reasons: ["set_mismatch"], baseline: emptyAggregate(), candidate: emptyAggregate() };
  const baselineObservation = baseline.observation;
  const candidateEnvelope = candidate.observation;
  const nonRegression = compareObservations(baselineObservation, candidateEnvelope, { ...policy, claim: "non_regression_only" });
  if (nonRegression.verdict === "fail") return nonRegression;
  const candidateNames = [...new Set(candidate.attempts.map((item) => item.attemptName))];
  if (claim === "non_regression_only") return nonRegression;
  if (candidateNames.length <= 1) return compareObservations(baselineObservation, candidateEnvelope, { ...policy, claim: "improvement" });
  let improved = 0;
  for (const attemptName of candidateNames) {
    const attempt = attemptObservation(candidateEnvelope, candidate.attempts, attemptName);
    const result = compareObservations(baselineObservation, attempt, { ...policy, claim: "improvement" });
    if (result.verdict === "pass") improved += 1;
  }
  return improved >= 2 ? nonRegression : { ...nonRegression, verdict: "fail", reasons: ["no_improvement"] };
}

function identityReasons(left: QualityObservation, right: QualityObservation): MachineReason[] {
  const reasons: MachineReason[] = [];
  if (left.commitSha !== right.commitSha) reasons.push("case_mismatch");
  if (left.configSha256 !== right.configSha256) reasons.push("config_mismatch");
  if (left.corpusSha256 !== right.corpusSha256) reasons.push("corpus_mismatch");
  if (left.runnerVersion !== right.runnerVersion) reasons.push("runner_mismatch");
  return reasons;
}

export function redactedReport(decision: Omit<GateDecision, "decisionId"> & { decisionId: string }): string {
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

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => {
    if (typeof key !== "string" || !keys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

function strictDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

const DECISION_KEYS = ["schemaVersion", "decisionId", "claim", "policyVersion", "candidateCommitSha", "configSha256", "corpusSha256", "runnerVersion", "baselineEvalObservationId", "candidateEvalObservationId", "baselineHoldoutObservationId", "candidateHoldoutObservationId", "createdAt", "expiresAt", "eval", "holdout", "verdict", "reasons"] as const;
const SUMMARY_KEYS = ["positiveCount", "negativeCount", "attemptCount", "varianceCaseCount", "baseline", "candidate"] as const;
const AGGREGATE_KEYS = ["positiveRetention", "negativeDefects", "zeroClipFalseNegatives", "boundaryErrors", "focalFailures", "subtitleFailures"] as const;

function validAggregate(value: unknown): boolean {
  return exactObject(value, AGGREGATE_KEYS) && AGGREGATE_KEYS.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0);
}

function validSummary(value: unknown): value is GateSetSummary {
  return exactObject(value, SUMMARY_KEYS) && ["positiveCount", "negativeCount", "attemptCount", "varianceCaseCount"].every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) && validAggregate(value.baseline) && validAggregate(value.candidate);
}

/** One strict reader shared by deploy and operator tooling. It verifies the
 * content-addressed decision, closed reasons, temporal bounds, and its
 * redacted report as one immutable bundle. */
export async function readGateDecision(id: string, root = DEFAULT_QUALITY_ROOT, now = new Date()): Promise<GateDecision> {
  if (!/^decision:sha256:[0-9a-f]{64}$/.test(id) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new GateError("invalid_input");
  let files: ReadonlyMap<string, Uint8Array>;
  try { files = await readBundle("decision", id, root); } catch { throw new GateError("invalid_input"); }
  if (files.size !== 2 || !files.has("decision.json") || !files.has("report.md")) throw new GateError("invalid_input");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(files.get("decision.json")!).toString("utf8")); } catch { throw new GateError("invalid_input"); }
  const parsedReasons = exactObject(parsed, DECISION_KEYS) && Array.isArray(parsed.reasons) ? parsed.reasons : undefined;
  if (!exactObject(parsed, DECISION_KEYS) || parsed.schemaVersion !== 1 || parsed.decisionId !== id ||
      (parsed.claim !== "improvement" && parsed.claim !== "non_regression_only") || typeof parsed.policyVersion !== "string" || parsed.policyVersion.length === 0 ||
      typeof parsed.candidateCommitSha !== "string" || !/^[0-9a-f]{40}$/.test(parsed.candidateCommitSha) || typeof parsed.configSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(parsed.configSha256) || typeof parsed.corpusSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(parsed.corpusSha256) || !Number.isSafeInteger(parsed.runnerVersion) || (parsed.runnerVersion as number) < 0 ||
      ![parsed.baselineEvalObservationId, parsed.candidateEvalObservationId, parsed.baselineHoldoutObservationId, parsed.candidateHoldoutObservationId].every((value) => typeof value === "string" && /^observation:sha256:[0-9a-f]{64}$/.test(value)) || !strictDate(parsed.createdAt) || !strictDate(parsed.expiresAt) || !validSummary(parsed.eval) || !validSummary(parsed.holdout) || (parsed.verdict !== "pass" && parsed.verdict !== "fail") || !parsedReasons || parsedReasons.some((reason) => typeof reason !== "string" || !GATE_REASON_ORDER.includes(reason as MachineReason)) || new Set(parsedReasons).size !== parsedReasons.length || [...parsedReasons].sort((left, right) => GATE_REASON_ORDER.indexOf(left as MachineReason) - GATE_REASON_ORDER.indexOf(right as MachineReason)).some((value, index) => value !== parsedReasons[index])) throw new GateError("invalid_input");
  const created = new Date(parsed.createdAt as string).getTime();
  const expires = new Date(parsed.expiresAt as string).getTime();
  if (created > now.getTime() || expires <= created || expires > created + DAY_MS || (parsed.verdict === "pass" && parsedReasons.length !== 0) || (parsed.verdict === "fail" && parsedReasons.length === 0)) throw new GateError("invalid_input");
  const { decisionId: _id, ...body } = parsed as unknown as GateDecision;
  if (contentId("decision", body) !== id) throw new GateError("invalid_input");
  const report = Buffer.from(files.get("report.md")!).toString("utf8");
  const decision = parsed as unknown as GateDecision;
  if (report !== redactedReport(decision)) throw new GateError("invalid_input");
  return decision;
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
  const ids = [input.baselineEvalObservationId, input.candidateEvalObservationId, input.baselineHoldoutObservationId, input.candidateHoldoutObservationId];
  const fallback = (index: number): LoadedObservation => ({ observation: zeroObservation(ids[index], index % 2 === 0 ? "eval" : "holdout", index === 0 || index === 2 ? "baseline" : "candidate", now), attempts: [] });
  let baselineEvalLoaded = fallback(0);
  let candidateEvalLoaded = fallback(1);
  let evalComparison: GateComparison = { verdict: "fail", reasons: ["invalid_schema"], baseline: emptyAggregate(), candidate: emptyAggregate() };
  try {
    baselineEvalLoaded = await loadObservation(ids[0], "eval", root, dependencies);
    candidateEvalLoaded = await loadObservation(ids[1], "eval", root, dependencies);
    evalComparison = [baselineEvalLoaded.observation, candidateEvalLoaded.observation].some((item) => staleObservation(item, nowDate))
      ? { verdict: "fail", reasons: ["stale_case"], baseline: emptyAggregate(), candidate: emptyAggregate() }
      : compareLoadedPair(baselineEvalLoaded, candidateEvalLoaded, "eval", input.policy, claim);
  } catch (error) {
    evalComparison = { verdict: "fail", reasons: [error instanceof GateError && error.code === "set_mismatch" ? "set_mismatch" : "invalid_schema"], baseline: emptyAggregate(), candidate: emptyAggregate() };
  }
  const evalSummary = countSummary(evalComparison, baselineEvalLoaded.observation, candidateEvalLoaded.observation, baselineEvalLoaded, candidateEvalLoaded);
  let holdoutSummary = emptySummary();
  let reasons = [...evalComparison.reasons];
  let candidateForBinding = candidateEvalLoaded.observation;
  const loadedForExpiry: LoadedObservation[] = [baselineEvalLoaded, candidateEvalLoaded];
  if (evalComparison.verdict === "pass") {
    try {
      const baselineHoldoutLoaded = await loadObservation(input.baselineHoldoutObservationId, "holdout", root, dependencies);
      const candidateHoldoutLoaded = await loadObservation(input.candidateHoldoutObservationId, "holdout", root, dependencies);
      loadedForExpiry.push(baselineHoldoutLoaded, candidateHoldoutLoaded);
      const baselineHoldout = baselineHoldoutLoaded.observation;
      const candidateHoldout = candidateHoldoutLoaded.observation;
      const stale = [baselineHoldout, candidateHoldout].some((item) => staleObservation(item, nowDate));
      const holdoutComparison = stale ? { verdict: "fail" as const, reasons: ["stale_case" as MachineReason], baseline: emptyAggregate(), candidate: emptyAggregate() } : compareLoadedPair(baselineHoldoutLoaded, candidateHoldoutLoaded, "holdout", input.policy, "non_regression_only");
      holdoutSummary = countSummary(holdoutComparison, baselineHoldout, candidateHoldout, baselineHoldoutLoaded, candidateHoldoutLoaded);
      reasons = [...reasons, ...holdoutComparison.reasons, ...identityReasons(candidateEvalLoaded.observation, candidateHoldout), ...identityReasons(baselineEvalLoaded.observation, baselineHoldout)];
    } catch (error) {
      reasons.push(error instanceof GateError && error.code === "set_mismatch" ? "set_mismatch" : "invalid_schema");
    }
  }
  const present = new Set(reasons);
  reasons = GATE_REASON_ORDER.filter((reason) => present.has(reason));
  const verdict = reasons.length === 0 ? "pass" : "fail";
  const expiryCandidates = [nowDate.getTime(), ...loadedForExpiry.map((item) => new Date(item.observation.createdAt).getTime()).filter((value) => Number.isFinite(value))].map((value) => value + DAY_MS);
  const expiresAt = new Date(Math.min(...expiryCandidates)).toISOString();
  const base = decisionBody(input, claim, now, expiresAt, candidateForBinding, evalSummary, holdoutSummary, verdict, reasons);
  const decision = Object.freeze({ ...base, decisionId: contentId("decision", base) }) as GateDecision;
  const report = redactedReport(decision);
  const publish = dependencies.publishDecision ?? dependencies.publish ?? publishDefault;
  const published = await publish(decision, report, root);
  if (published.status !== "committed" && published.status !== "noop") throw new GateError("publish_failed");
  return decision;
}

/** Aggregate-only evidence for gates which compose the clip decision with a
 * subsystem-specific policy. The case identities never leave this module. */
export async function readGateCaseEvidence(decision: GateDecision, root = DEFAULT_QUALITY_ROOT): Promise<Readonly<{
  positiveCases: number;
  confirmedNegativeCases: number;
  selectionNegativeCases: number;
  positiveLosses: number;
  confirmedNegativeWorsening: number;
}>> {
  const pairs = [
    [decision.baselineEvalObservationId, decision.candidateEvalObservationId, "eval"],
    [decision.baselineHoldoutObservationId, decision.candidateHoldoutObservationId, "holdout"],
  ] as const;
  let positiveCases = 0;
  let confirmedNegativeCases = 0;
  let selectionNegativeCases = 0;
  let positiveLosses = 0;
  let confirmedNegativeWorsening = 0;
  for (const [baselineId, candidateId, set] of pairs) {
    const baseline = (await loadObservation(baselineId, set, root, {})).observation;
    const candidate = (await loadObservation(candidateId, set, root, {})).observation;
    const baselineByCase = new Map(baseline.cases.map((item) => [item.caseVersion, item]));
    for (const item of candidate.cases) {
      const prior = baselineByCase.get(item.caseVersion);
      if (!prior || prior.disposition !== item.disposition || prior.subsystem !== item.subsystem) throw new GateError("observation_invalid");
      if (item.disposition === "positive") {
        positiveCases += 1;
        if ((item.metrics.approvedMomentRetained ?? item.metrics.positiveRetention ?? 0) < (prior.metrics.approvedMomentRetained ?? prior.metrics.positiveRetention ?? 0)) positiveLosses += 1;
      } else if (item.disposition === "confirmed_negative") {
        confirmedNegativeCases += 1;
        if (item.subsystem === "selection") selectionNegativeCases += 1;
        if ((item.metrics.defectSeverity ?? item.metrics.negativeDefects ?? 0) > (prior.metrics.defectSeverity ?? prior.metrics.negativeDefects ?? 0)) confirmedNegativeWorsening += 1;
      }
    }
  }
  return Object.freeze({ positiveCases, confirmedNegativeCases, selectionNegativeCases, positiveLosses, confirmedNegativeWorsening });
}
