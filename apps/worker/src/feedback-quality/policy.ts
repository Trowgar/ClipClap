import type {
  CorpusMinimum,
  Disposition,
  GateAggregate,
  GateComparison,
  GatePolicy,
  MachineReason,
  QualityCaseResult,
  QualityMetrics,
  QualityObservation,
  Subsystem,
} from "./types";

const REQUIRED_MINIMUM: CorpusMinimum = {
  evalPositive: 4,
  evalNegative: 6,
  holdoutPositive: 1,
  holdoutNegative: 2,
};

/* This is also the serialization order used by reports and decisions. */
const REASON_ORDER: readonly MachineReason[] = [
  "invalid_schema",
  "invalid_metric",
  "duplicate_case_version",
  "missing_case",
  "stale_case",
  "error_case",
  "set_mismatch",
  "mode_mismatch",
  "corpus_mismatch",
  "config_mismatch",
  "runner_mismatch",
  "insufficient_corpus",
  "case_mismatch",
  "positive_regression",
  "negative_regression",
  "hard_invariant_regression",
  "aggregate_regression",
  "no_improvement",
];

const OBSERVATION_KEYS = new Set([
  "schemaVersion",
  "observationId",
  "mode",
  "set",
  "commitSha",
  "configSha256",
  "corpusSha256",
  "runnerVersion",
  "createdAt",
  "cases",
  "metrics",
]);
const CASE_KEYS = new Set(["schemaVersion", "caseVersion", "disposition", "subsystem", "status", "metrics"]);
const METRIC_KEYS = new Set([
  "approvedMomentRetained",
  "approvedMoment",
  "approvedWindowOverlap",
  "hardInvariantFailures",
  "invariantFailures",
  "defectSeverity",
  "severity",
  "emptyResult",
  "empty",
  "zeroClipFalseNegative",
  "zeroClipFalseNegatives",
  "boundaryErrors",
  "boundaryError",
  "focalFailures",
  "focalFailure",
  "subtitleFailures",
  "subtitleFailure",
  "subtitleOverlap",
  "requiredTextClipped",
  "requiredSubjectClipped",
  "outputWidth",
  "outputHeight",
  "geometryWidth",
  "geometryHeight",
  "sar",
  "sampleAspectRatio",
  "durationDrift",
  "durationDriftSeconds",
  "blackTail",
  "blackTailSeconds",
  "blackTailSec",
  "frozenTail",
  "frozenTailSeconds",
  "frozenTailSec",
  "frameCount",
  "clipCount",
  "newSubtitleOverlap",
  "positiveRetention",
  "negativeDefects",
]);
const POLICY_KEYS = new Set(["schemaVersion", "policyVersion", "claim", "minimum"]);
const MINIMUM_KEYS = new Set(["evalPositive", "evalNegative", "holdoutPositive", "holdoutNegative"]);

type MetricName = keyof QualityMetrics;
type RequiredMetricGroups = readonly (readonly MetricName[])[];
const REQUIRED_POSITIVE_METRICS: Record<Subsystem, RequiredMetricGroups> = {
  selection: [
    ["approvedMomentRetained"],
    ["approvedWindowOverlap"],
    ["emptyResult", "empty"],
    ["zeroClipFalseNegative", "zeroClipFalseNegatives"],
  ],
  boundary: [["approvedMomentRetained"], ["approvedWindowOverlap"], ["boundaryErrors", "boundaryError"]],
  framing: [
    ["approvedMomentRetained"],
    ["approvedWindowOverlap"],
    ["focalFailures", "focalFailure"],
    ["requiredTextClipped"],
    ["requiredSubjectClipped"],
  ],
  subtitles: [["approvedMomentRetained"], ["approvedWindowOverlap"], ["subtitleOverlap", "newSubtitleOverlap"]],
  render: [
    ["approvedMomentRetained"],
    ["approvedWindowOverlap"],
    ["hardInvariantFailures"],
    ["outputWidth", "geometryWidth"],
    ["outputHeight", "geometryHeight"],
    ["sar", "sampleAspectRatio"],
    ["blackTail", "blackTailSeconds", "blackTailSec"],
    ["frozenTail", "frozenTailSeconds", "frozenTailSec"],
    ["subtitleOverlap", "newSubtitleOverlap"],
    ["requiredTextClipped"],
    ["requiredSubjectClipped"],
    ["focalFailures", "focalFailure"],
  ],
};

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function ownDataKeys(value: object, allowed: Set<string>): boolean {
  for (const rawKey of Reflect.ownKeys(value)) {
    if (typeof rawKey !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
    /* Closed JSON contracts do not permit hidden fields or accessors. */
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
    if (!allowed.has(rawKey)) return false;
  }
  return true;
}

function validCasesArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (const rawKey of Reflect.ownKeys(value)) {
    if (rawKey === "length") {
      const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
      continue;
    }
    if (typeof rawKey !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
    if (!/^(0|[1-9]\d*)$/.test(rawKey)) return false;
  }
  return true;
}

function ownDataFields(value: object, required: readonly string[]): boolean {
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
  }
  return true;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validSha1(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validMetrics(value: unknown): value is QualityMetrics {
  if (!isObject(value) || !ownDataKeys(value, METRIC_KEYS)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!finiteNonnegative(value[key])) return false;
  }
  return true;
}

function hasMetric(metrics: QualityMetrics, names: readonly MetricName[]): boolean {
  return names.some((name) => Object.prototype.hasOwnProperty.call(metrics, name));
}

function observationReason(value: unknown, validateMetrics: boolean): MachineReason | undefined {
  if (!isObject(value) || !ownDataKeys(value, OBSERVATION_KEYS) || !ownDataFields(value, ["schemaVersion", "observationId", "mode", "set", "commitSha", "configSha256", "corpusSha256", "runnerVersion", "createdAt", "cases"])) return "invalid_schema";
  if (
    value.schemaVersion !== 1 ||
    !validSha256(value.observationId) ||
    (value.mode !== "baseline" && value.mode !== "candidate") ||
    (value.set !== "eval" && value.set !== "holdout") ||
    !validSha1(value.commitSha) ||
    !validSha256(value.configSha256) ||
    !validSha256(value.corpusSha256) ||
    !finiteNonnegative(value.runnerVersion) ||
    !Number.isInteger(value.runnerVersion) ||
    typeof value.createdAt !== "string" ||
    !validCasesArray(value.cases)
  ) return "invalid_schema";
  if (validateMetrics && hasOwn(value, "metrics") && !validMetrics(value.metrics)) return "invalid_metric";
  const versions = new Set<string>();
  for (const entry of value.cases) {
    if (!isObject(entry) || !ownDataKeys(entry, CASE_KEYS)) return "invalid_schema";
    if (!ownDataFields(entry, ["schemaVersion", "caseVersion", "disposition", "subsystem", "status", "metrics"])) return "invalid_schema";
    if (
      entry.schemaVersion !== 1 ||
      typeof entry.caseVersion !== "string" ||
      entry.caseVersion.length === 0 ||
      (entry.disposition !== "positive" && entry.disposition !== "confirmed_negative" && entry.disposition !== "exclude") ||
      (entry.subsystem !== "selection" && entry.subsystem !== "boundary" && entry.subsystem !== "framing" && entry.subsystem !== "subtitles" && entry.subsystem !== "render") ||
      (entry.status !== "ok" && entry.status !== "missing" && entry.status !== "stale" && entry.status !== "error")
    ) return "invalid_schema";
    if (validateMetrics && !validMetrics(entry.metrics)) return "invalid_metric";
    if (validateMetrics && entry.disposition === "positive") {
      const metrics = entry.metrics as QualityMetrics;
      const required = REQUIRED_POSITIVE_METRICS[entry.subsystem];
      if (required.some((names) => !hasMetric(metrics, names))) return "invalid_metric";
    }
    if (validateMetrics && entry.disposition === "confirmed_negative" && !hasMetric(entry.metrics as QualityMetrics, ["defectSeverity"])) return "invalid_metric";
    if (versions.has(entry.caseVersion)) return "duplicate_case_version";
    versions.add(entry.caseVersion);
  }
  return undefined;
}

function validPolicy(value: unknown): value is GatePolicy {
  if (!isObject(value) || !ownDataKeys(value, POLICY_KEYS) || !ownDataFields(value, ["schemaVersion", "policyVersion", "claim", "minimum"])) return false;
  if (
    value.schemaVersion !== 1 ||
    typeof value.policyVersion !== "string" ||
    (value.claim !== "improvement" && value.claim !== "non_regression_only") ||
    !isObject(value.minimum) ||
    !ownDataKeys(value.minimum, MINIMUM_KEYS) ||
    !ownDataFields(value.minimum, ["evalPositive", "evalNegative", "holdoutPositive", "holdoutNegative"])
  ) {
    return false;
  }
  const minimum = value.minimum;
  return (
    finiteNonnegative(minimum.evalPositive) &&
    Number.isInteger(minimum.evalPositive) &&
    finiteNonnegative(minimum.evalNegative) &&
    Number.isInteger(minimum.evalNegative) &&
    finiteNonnegative(minimum.holdoutPositive) &&
    Number.isInteger(minimum.holdoutPositive) &&
    finiteNonnegative(minimum.holdoutNegative) &&
    Number.isInteger(minimum.holdoutNegative)
  );
}

function uniqueReasons(reasons: readonly MachineReason[]): MachineReason[] {
  const present = new Set(reasons);
  return REASON_ORDER.filter((reason) => present.has(reason));
}

function failure(
  reasons: readonly MachineReason[],
  baseline: GateAggregate = emptyAggregate(),
  candidate: GateAggregate = emptyAggregate(),
): GateComparison {
  return { verdict: "fail", reasons: uniqueReasons(reasons), baseline, candidate };
}

function emptyAggregate(): GateAggregate {
  return {
    positiveRetention: 0,
    negativeDefects: 0,
    zeroClipFalseNegatives: 0,
    boundaryErrors: 0,
    focalFailures: 0,
    subtitleFailures: 0,
  };
}

function numberMetric(metrics: QualityMetrics, names: readonly MetricName[]): number | undefined {
  for (const name of names) {
    const value = metrics[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function sumMetric(cases: readonly QualityCaseResult[], names: readonly MetricName[]): number {
  let total = 0;
  for (const entry of cases) total += numberMetric(entry.metrics, names) ?? 0;
  return total;
}

function sameMetricKeys(left: QualityMetrics, right: QualityMetrics): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
  }
  return true;
}

function aggregate(observation: QualityObservation): GateAggregate {
  const positives = observation.cases.filter((entry) => entry.disposition === "positive");
  const negatives = observation.cases.filter((entry) => entry.disposition === "confirmed_negative");
  return {
    positiveRetention: positives.filter((entry) =>
      (numberMetric(entry.metrics, ["approvedMomentRetained", "approvedMoment"]) ?? 0) > 0 &&
      (numberMetric(entry.metrics, ["approvedWindowOverlap"]) ?? 0) > 0,
    ).length,
    negativeDefects: negatives.filter((entry) => (numberMetric(entry.metrics, ["defectSeverity", "severity"]) ?? 0) > 0).length,
    zeroClipFalseNegatives: sumMetric(observation.cases, ["zeroClipFalseNegatives", "zeroClipFalseNegative"]),
    boundaryErrors: sumMetric(observation.cases, ["boundaryErrors", "boundaryError"]),
    focalFailures: sumMetric(observation.cases, ["focalFailures", "focalFailure"]),
    subtitleFailures: sumMetric(observation.cases, ["subtitleFailures", "subtitleFailure"]),
  };
}

function minimumFor(policy: GatePolicy, set: QualityObservation["set"]): { positive: number; negative: number } {
  return set === "eval"
    ? { positive: Math.max(REQUIRED_MINIMUM.evalPositive, policy.minimum.evalPositive), negative: Math.max(REQUIRED_MINIMUM.evalNegative, policy.minimum.evalNegative) }
    : { positive: Math.max(REQUIRED_MINIMUM.holdoutPositive, policy.minimum.holdoutPositive), negative: Math.max(REQUIRED_MINIMUM.holdoutNegative, policy.minimum.holdoutNegative) };
}

function metricImproved(before: QualityCaseResult, after: QualityCaseResult): boolean {
  const beforePositive = before.disposition === "positive";
  const higherIsBetter: readonly MetricName[] = ["approvedMomentRetained", "approvedMoment", "approvedWindowOverlap"];
  const lowerIsBetter: readonly MetricName[] = [
    "defectSeverity",
    "severity",
    "hardInvariantFailures",
    "invariantFailures",
    "emptyResult",
    "zeroClipFalseNegative",
    "zeroClipFalseNegatives",
    "boundaryErrors",
    "boundaryError",
    "focalFailures",
    "focalFailure",
    "subtitleFailures",
    "subtitleFailure",
    "subtitleOverlap",
    "newSubtitleOverlap",
    "requiredTextClipped",
    "requiredSubjectClipped",
    "durationDrift",
    "durationDriftSeconds",
    "blackTail",
    "blackTailSeconds",
    "blackTailSec",
    "frozenTail",
    "frozenTailSeconds",
    "frozenTailSec",
  ];
  for (const key of higherIsBetter) {
    if (beforePositive && (after.metrics[key] ?? 0) > (before.metrics[key] ?? 0)) return true;
  }
  for (const key of lowerIsBetter) if ((after.metrics[key] ?? 0) < (before.metrics[key] ?? 0)) return true;
  return false;
}

function checkHardInvariants(before: QualityCaseResult, after: QualityCaseResult): boolean {
  if (after.disposition !== "positive") return false;
  const priorMoment = numberMetric(before.metrics, ["approvedMomentRetained", "approvedMoment", "approvedWindowOverlap"]);
  const nextMoment = numberMetric(after.metrics, ["approvedMomentRetained", "approvedMoment", "approvedWindowOverlap"]);
  if (nextMoment !== undefined && nextMoment <= 0) return true;
  if (priorMoment !== undefined && nextMoment === undefined) return true;
  if (priorMoment !== undefined && nextMoment !== undefined && nextMoment < priorMoment) return true;
  const priorWindow = numberMetric(before.metrics, ["approvedWindowOverlap"]);
  const nextWindow = numberMetric(after.metrics, ["approvedWindowOverlap"]);
  if (nextWindow !== undefined && nextWindow <= 0) return true;
  if (priorWindow !== undefined && nextWindow === undefined) return true;
  if (priorWindow !== undefined && nextWindow !== undefined && nextWindow < priorWindow) return true;

  const priorFailures = numberMetric(before.metrics, ["hardInvariantFailures", "invariantFailures"]) ?? 0;
  const nextFailures = numberMetric(after.metrics, ["hardInvariantFailures", "invariantFailures"]);
  if (nextFailures !== undefined && (nextFailures > priorFailures || nextFailures > 0)) return true;

  const width = numberMetric(after.metrics, ["outputWidth", "geometryWidth"]);
  const height = numberMetric(after.metrics, ["outputHeight", "geometryHeight"]);
  const sar = numberMetric(after.metrics, ["sar", "sampleAspectRatio"]);
  if ((width !== undefined && width !== 1080) || (height !== undefined && height !== 1920) || (sar !== undefined && sar !== 1)) return true;

  const hardMetrics: readonly MetricName[][] = [
    ["emptyResult", "empty"],
    ["zeroClipFalseNegative", "zeroClipFalseNegatives"],
    ["boundaryErrors", "boundaryError"],
    ["blackTail", "blackTailSeconds", "blackTailSec"],
    ["frozenTail", "frozenTailSeconds", "frozenTailSec"],
    ["subtitleOverlap", "newSubtitleOverlap"],
    ["requiredTextClipped"],
    ["requiredSubjectClipped"],
  ];
  for (const names of hardMetrics) {
    const prior = numberMetric(before.metrics, names);
    const next = numberMetric(after.metrics, names);
    if (prior !== undefined && next === undefined) return true;
    if (next !== undefined && next > (prior ?? 0)) return true;
  }
  return false;
}

/** Compare two immutable observations without I/O or hidden mutable state. */
export function compareObservations(
  baseline: QualityObservation,
  candidate: QualityObservation,
  policy: GatePolicy,
): GateComparison {
  const baselineReason = observationReason(baseline, false);
  const candidateReason = observationReason(candidate, false);
  if (baselineReason || candidateReason || !validPolicy(policy)) {
    return failure([baselineReason ?? candidateReason ?? "invalid_schema"]);
  }

  /* Status and identity failures intentionally happen before any metric read. */
  const statusReasons: MachineReason[] = [];
  for (const entry of [...baseline.cases, ...candidate.cases]) {
    if (entry.status === "missing") statusReasons.push("missing_case");
    else if (entry.status === "stale") statusReasons.push("stale_case");
    else if (entry.status === "error") statusReasons.push("error_case");
  }
  if (statusReasons.length > 0) return failure(statusReasons);

  const baselineMetricReason = observationReason(baseline, true);
  const candidateMetricReason = observationReason(candidate, true);
  if (baselineMetricReason || candidateMetricReason) {
    return failure([baselineMetricReason ?? candidateMetricReason ?? "invalid_metric"]);
  }

  const identityReasons: MachineReason[] = [];
  if (baseline.set !== candidate.set) identityReasons.push("set_mismatch");
  if (baseline.mode !== "baseline" || candidate.mode !== "candidate") identityReasons.push("mode_mismatch");
  if (baseline.corpusSha256 !== candidate.corpusSha256) identityReasons.push("corpus_mismatch");
  if (baseline.configSha256 !== candidate.configSha256) identityReasons.push("config_mismatch");
  if (baseline.runnerVersion !== candidate.runnerVersion) identityReasons.push("runner_mismatch");
  if (identityReasons.length > 0) return failure(identityReasons);

  const minimum = minimumFor(policy, baseline.set);
  const baselinePositive = baseline.cases.filter((entry) => entry.disposition === "positive").length;
  const baselineNegative = baseline.cases.filter((entry) => entry.disposition === "confirmed_negative").length;
  if (baselinePositive < minimum.positive || baselineNegative < minimum.negative) return failure(["insufficient_corpus"]);

  const beforeByVersion = new Map(baseline.cases.map((entry) => [entry.caseVersion, entry]));
  const afterByVersion = new Map(candidate.cases.map((entry) => [entry.caseVersion, entry]));
  const regressions: MachineReason[] = [];
  let improvement = false;
  for (const [version, before] of beforeByVersion) {
    const after = afterByVersion.get(version);
    if (!after) {
      regressions.push(before.disposition === "positive" ? "positive_regression" : "missing_case");
      continue;
    }
    if (after.disposition !== before.disposition || after.subsystem !== before.subsystem) {
      regressions.push("case_mismatch");
      continue;
    }
    if (!sameMetricKeys(before.metrics, after.metrics)) return failure(["invalid_metric"]);
    if (before.disposition === "positive" && checkHardInvariants(before, after)) regressions.push("hard_invariant_regression");
    if (before.disposition === "confirmed_negative") {
      const prior = numberMetric(before.metrics, ["defectSeverity", "severity"]);
      const next = numberMetric(after.metrics, ["defectSeverity", "severity"]);
      if (prior !== undefined && next === undefined) regressions.push("negative_regression");
      else if ((next ?? 0) > (prior ?? 0)) regressions.push("negative_regression");
    }
    if (metricImproved(before, after)) improvement = true;
  }
  for (const version of afterByVersion.keys()) if (!beforeByVersion.has(version)) regressions.push("case_mismatch");
  if (regressions.length > 0) return failure(regressions);

  const beforeAggregate = aggregate(baseline);
  const afterAggregate = aggregate(candidate);
  const aggregateRegressed =
    afterAggregate.positiveRetention < beforeAggregate.positiveRetention ||
    afterAggregate.negativeDefects > beforeAggregate.negativeDefects ||
    afterAggregate.zeroClipFalseNegatives > beforeAggregate.zeroClipFalseNegatives ||
    afterAggregate.boundaryErrors > beforeAggregate.boundaryErrors ||
    afterAggregate.focalFailures > beforeAggregate.focalFailures ||
    afterAggregate.subtitleFailures > beforeAggregate.subtitleFailures;
  if (aggregateRegressed) return failure(["aggregate_regression"], beforeAggregate, afterAggregate);
  if (policy.claim === "improvement" && !improvement) return failure(["no_improvement"], beforeAggregate, afterAggregate);
  return { verdict: "pass", reasons: [], baseline: beforeAggregate, candidate: afterAggregate };
}

export type {
  CorpusMinimum,
  GateComparison,
  GatePolicy,
  QualityCaseResult,
  QualityMetrics,
  QualityObservation,
} from "./types";
