import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { contentId, publishBundle, readBundle } from "../feedback-quality/store";
import { decideGate, type GateDependencies, type DecideGateInput } from "../feedback-quality/gate";
import type { ObservationAttemptRecord } from "../feedback-quality/observe";
import type { GatePolicy, QualityCaseResult, QualityObservation } from "../feedback-quality/types";

const hash = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;
const policy: GatePolicy = { schemaVersion: 1, policyVersion: "quality-gate-v2", claim: "non_regression_only", minimum: { evalPositive: 4, evalNegative: 6, holdoutPositive: 1, holdoutNegative: 2 } };
const metric = (positive: boolean): QualityCaseResult["metrics"] => positive
  ? { approvedMomentRetained: 1, approvedWindowOverlap: 1, emptyResult: 0, zeroClipFalseNegative: 0 }
  : { defectSeverity: 0, boundaryErrors: 0 };

function observation(set: "eval" | "holdout", mode: "baseline" | "candidate", positiveCount: number, negativeCount: number, createdAt = "2026-09-01T00:00:00.000Z"): QualityObservation {
  const cases: QualityCaseResult[] = [];
  for (let index = 0; index < positiveCount; index += 1) cases.push({ schemaVersion: 1, caseVersion: `case:${hash(`p${index}`)}`, disposition: "positive", subsystem: "selection", status: "ok", metrics: metric(true) });
  for (let index = 0; index < negativeCount; index += 1) cases.push({ schemaVersion: 1, caseVersion: `case:${hash(`n${index}`)}`, disposition: "confirmed_negative", subsystem: "boundary", status: "ok", metrics: metric(false) });
  const body = { schemaVersion: 1 as const, mode, set, commitSha: "a".repeat(40), configSha256: hash("c"), corpusSha256: hash("d"), runnerVersion: 1, cases };
  return { ...body, observationId: contentId("observation", body), createdAt };
}

const input = (overrides: Partial<DecideGateInput> = {}): DecideGateInput => ({
  baselineEvalObservationId: "observation:" + hash("1"), candidateEvalObservationId: "observation:" + hash("2"),
  baselineHoldoutObservationId: "observation:" + hash("3"), candidateHoldoutObservationId: "observation:" + hash("4"), policy,
  ...overrides,
});

function deps(observations: Record<string, QualityObservation>, events: string[] = []): GateDependencies {
  return {
    root: "/private/corpus",
    readObservation: vi.fn(async (id: string) => { events.push(`read:${id}`); const value = observations[id]; if (!value) throw new Error("missing private observation"); return value; }),
    publishDecision: vi.fn(async () => ({ status: "committed" as const })),
    now: () => new Date("2026-09-01T12:00:00.000Z"),
  };
}

describe("feedback quality gate", () => {
  const roots: string[] = [];
  afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("compares eval before it reads holdout and publishes a canonical passing decision", async () => {
    const baseEval = observation("eval", "baseline", 4, 6);
    const candidateEval = { ...baseEval, mode: "candidate" as const, observationId: "observation:" + hash("5") };
    const baseHoldout = observation("holdout", "baseline", 1, 2);
    const candidateHoldout = { ...baseHoldout, mode: "candidate" as const, observationId: "observation:" + hash("6") };
    const ids = input({ baselineEvalObservationId: baseEval.observationId, candidateEvalObservationId: candidateEval.observationId, baselineHoldoutObservationId: baseHoldout.observationId, candidateHoldoutObservationId: candidateHoldout.observationId });
    const events: string[] = [];
    const dependencies = deps(Object.fromEntries([[baseEval.observationId, baseEval], [candidateEval.observationId, candidateEval], [baseHoldout.observationId, baseHoldout], [candidateHoldout.observationId, candidateHoldout]]), events);
    const decision = await decideGate(ids, dependencies);
    expect(decision.verdict).toBe("pass");
    expect(events.slice(0, 2)).toEqual([`read:${baseEval.observationId}`, `read:${candidateEval.observationId}`]);
    expect(events).toHaveLength(4);
    const { decisionId: _decisionId, ...decisionBody } = decision;
    expect(decision.decisionId).toBe(contentId("decision", decisionBody));
    expect(dependencies.publishDecision).toHaveBeenCalledOnce();
  });

  it("does not read holdout after an eval regression", async () => {
    const base = observation("eval", "baseline", 4, 6);
    const candidate = { ...base, mode: "candidate" as const, observationId: "observation:" + hash("7"), cases: base.cases.slice(1) };
    const ids = input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId });
    const events: string[] = [];
    const dependencies = deps({ [base.observationId]: base, [candidate.observationId]: candidate }, events);
    const decision = await decideGate(ids, dependencies);
    expect(decision.verdict).toBe("fail");
    expect(decision.reasons).toContain("positive_regression");
    expect(events).toEqual([`read:${base.observationId}`, `read:${candidate.observationId}`]);
  });

  it("fails closed when a non-primary live attempt is malformed", async () => {
    const base = observation("eval", "baseline", 4, 6);
    const candidate = { ...base, mode: "candidate" as const, observationId: "observation:" + hash("7") };
    const events: string[] = [];
    const attempts = (item: QualityObservation): readonly ObservationAttemptRecord[] => item === candidate
      ? item.cases.map((result) => ["live-1", "live-2", "live-3"].map((attemptName) => ({ caseVersion: result.caseVersion, attemptName, result: attemptName === "live-2" ? { ...result, metrics: { ...result.metrics, score: Number.NaN } } : result }))).flat()
      : item.cases.map((result) => ({ caseVersion: result.caseVersion, attemptName: "recorded", result }));
    const dependencies = { ...deps({ [base.observationId]: base, [candidate.observationId]: candidate }, events), readAttempts: vi.fn(async (id: string) => attempts(id === candidate.observationId ? candidate : base)) };
    const decision = await decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId }), dependencies);
    expect(decision.verdict).toBe("fail");
    expect(decision.reasons).toContain("invalid_schema");
    expect(events).toEqual([`read:${base.observationId}`, `read:${candidate.observationId}`]);
  });

  it("requires robust improvement from at least two of three live attempts", async () => {
    const base = observation("eval", "baseline", 4, 6);
    const candidate = { ...base, mode: "candidate" as const, observationId: "observation:" + hash("7"), cases: base.cases.map((item) => item.disposition === "positive" ? { ...item, metrics: { ...item.metrics, approvedWindowOverlap: 2 } } : item) };
    const holdout = observation("holdout", "baseline", 1, 2);
    const holdoutCandidate = { ...holdout, mode: "candidate" as const, observationId: "observation:" + hash("8") };
    const attemptRecords = (item: QualityObservation, live: boolean): readonly ObservationAttemptRecord[] => item.cases.flatMap((result) => (live ? ["live-1", "live-2", "live-3"] : ["recorded"]).map((attemptName) => ({
      caseVersion: result.caseVersion, attemptName,
      result: result.disposition === "positive" && attemptName === "live-3" ? { ...result, metrics: { ...result.metrics, approvedWindowOverlap: 1 } } : result,
    })));
    const map = { [base.observationId]: base, [candidate.observationId]: candidate, [holdout.observationId]: holdout, [holdoutCandidate.observationId]: holdoutCandidate };
    const dependencies = { ...deps(map), readAttempts: vi.fn(async (id: string) => attemptRecords(map[id as keyof typeof map], id === candidate.observationId || id === holdoutCandidate.observationId)) };
    const decision = await decideGate(input({ claim: "improvement", policy: { ...policy, claim: "improvement" }, baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId, baselineHoldoutObservationId: holdout.observationId, candidateHoldoutObservationId: holdoutCandidate.observationId }), dependencies);
    expect(decision.verdict).toBe("pass");
    expect(decision.eval.attemptCount).toBe(3);
  });

  it("expires no later than the oldest observation plus 24 hours", async () => {
    const base = observation("eval", "baseline", 4, 6, "2026-09-01T00:00:00.000Z");
    const candidate = { ...base, mode: "candidate" as const, observationId: "observation:" + hash("7") };
    const holdout = observation("holdout", "baseline", 1, 2, "2026-09-01T06:00:00.000Z");
    const holdoutCandidate = { ...holdout, mode: "candidate" as const, observationId: "observation:" + hash("8") };
    const map = { [base.observationId]: base, [candidate.observationId]: candidate, [holdout.observationId]: holdout, [holdoutCandidate.observationId]: holdoutCandidate };
    const dependencies = { ...deps(map), now: () => new Date("2026-09-01T12:00:00.000Z") };
    const decision = await decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId, baselineHoldoutObservationId: holdout.observationId, candidateHoldoutObservationId: holdoutCandidate.observationId }), dependencies);
    expect(decision.expiresAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it.each([
    ["missing observation", async () => decideGate(input(), deps({})), "invalid_schema"],
    ["expired decision", async () => {
      const base = observation("eval", "baseline", 4, 6, "2026-08-30T00:00:00.000Z");
      const candidate = { ...base, mode: "candidate" as const, observationId: "observation:" + hash("8") };
      const holdout = observation("holdout", "baseline", 1, 2, "2026-08-30T00:00:00.000Z");
      const holdoutCandidate = { ...holdout, mode: "candidate" as const, observationId: "observation:" + hash("9") };
      return decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId, baselineHoldoutObservationId: holdout.observationId, candidateHoldoutObservationId: holdoutCandidate.observationId }), deps({ [base.observationId]: base, [candidate.observationId]: candidate, [holdout.observationId]: holdout, [holdoutCandidate.observationId]: holdoutCandidate }));
    }, "stale_case"],
  ])("fails closed for %s", async (_name, run, reason) => expect((await run()).reasons).toContain(reason));

  it("redacts private values from decision report and uses atomic decision bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-gate-")).then((value) => { roots.push(value); return value; });
    const base = observation("eval", "baseline", 4, 6);
    const candidate = { ...base, mode: "candidate" as const, observationId: "observation:" + hash("a") };
    const holdout = observation("holdout", "baseline", 1, 2);
    const holdoutCandidate = { ...holdout, mode: "candidate" as const, observationId: "observation:" + hash("b") };
    const { publishDecision: _mockPublish, ...readerDependencies } = deps({ [base.observationId]: base, [candidate.observationId]: candidate, [holdout.observationId]: holdout, [holdoutCandidate.observationId]: holdoutCandidate });
    const decision = await decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId, baselineHoldoutObservationId: holdout.observationId, candidateHoldoutObservationId: holdoutCandidate.observationId }), { ...readerDependencies, root });
    const bundle = await readBundle("decision", decision.decisionId, root);
    expect(bundle.has("decision.json")).toBe(true);
    expect(bundle.has("report.md")).toBe(true);
    const report = Buffer.from(bundle.get("report.md")!).toString("utf8");
    expect(report).not.toContain("feedback-1");
    expect(report).not.toContain("case:");
    expect((await stat(join(root, "decisions", decision.decisionId, "decision.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(Buffer.from(bundle.get("decision.json")!).toString("utf8")).decisionId).toBe(decision.decisionId);
  });
});
