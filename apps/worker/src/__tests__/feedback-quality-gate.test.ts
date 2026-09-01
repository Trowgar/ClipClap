import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { contentId, publishBundle, readBundle } from "../feedback-quality/store";
import { decideGate, type GateDependencies, type DecideGateInput } from "../feedback-quality/gate";
import type { ObservationAttemptRecord } from "../feedback-quality/observe";
import { observationIdFor, serializeObservationAttempts } from "../feedback-quality/observe";
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
  return snapshot({ schemaVersion: 1 as const, mode, set, commitSha: "a".repeat(40), configSha256: hash("c"), corpusSha256: hash("d"), runnerVersion: 1, cases }, createdAt);
}

function snapshot(base: Omit<QualityObservation, "observationId" | "createdAt" | "live" | "caseVersions" | "attemptCount" | "attemptsSha256">, createdAt: string, live = false): QualityObservation {
  const cases = [...base.cases].sort((left, right) => left.caseVersion.localeCompare(right.caseVersion));
  const names = live ? ["live-1", "live-2", "live-3"] : ["recorded"];
  const attempts = cases.flatMap((result) => names.map((attemptName) => ({ caseVersion: result.caseVersion, attemptName, result })));
  const body = { ...base, live, caseVersions: cases.map((result) => result.caseVersion), attemptCount: attempts.length, attemptsSha256: sha256(serializeObservationAttempts(attempts)) };
  return { ...body, observationId: observationIdFor(body), createdAt };
}

function snapshotAttempts(base: Omit<QualityObservation, "observationId" | "createdAt" | "live" | "caseVersions" | "attemptCount" | "attemptsSha256">, createdAt: string, attempts: readonly ObservationAttemptRecord[]): QualityObservation {
  const cases = [...base.cases].sort((left, right) => left.caseVersion.localeCompare(right.caseVersion));
  const names = [...new Set(attempts.map((item) => item.attemptName))].sort();
  const body = { ...base, live: names.length === 3, caseVersions: cases.map((result) => result.caseVersion), attemptCount: attempts.length, attemptsSha256: sha256(serializeObservationAttempts(attempts)), cases };
  return { ...body, observationId: observationIdFor(body), createdAt };
}

function rebuild(source: QualityObservation, mode: "baseline" | "candidate", cases = source.cases, createdAt = source.createdAt, live = false): QualityObservation {
  const { observationId: _id, createdAt: _createdAt, live: _live, caseVersions: _versions, attemptCount: _count, attemptsSha256: _attempts, ...base } = source;
  return snapshot({ ...base, mode, cases }, createdAt, live);
}

function attemptsFor(item: QualityObservation): readonly ObservationAttemptRecord[] {
  const names = item.live ? ["live-1", "live-2", "live-3"] : ["recorded"];
  return item.cases.flatMap((result) => names.map((attemptName) => ({ caseVersion: result.caseVersion, attemptName, result })));
}

function bundleFor(item: QualityObservation, suppliedAttempts = attemptsFor(item)): ReadonlyMap<string, Uint8Array> {
  const results = serializeObservationAttempts(suppliedAttempts);
  const manifest = { schemaVersion: 1, observationId: item.observationId, set: item.set, mode: item.mode, live: item.live === true, commitSha: item.commitSha, configSha256: item.configSha256, corpusSha256: item.corpusSha256, runnerVersion: item.runnerVersion, createdAt: item.createdAt, caseVersions: item.caseVersions ?? item.cases.map((result) => result.caseVersion).sort(), attemptCount: suppliedAttempts.length, attemptsSha256: sha256(results) };
  return new Map([["manifest.json", Buffer.from(canonicalJson(manifest))], ["results.jsonl", Buffer.from(results)]]) as ReadonlyMap<string, Uint8Array>;
}

const input = (overrides: Partial<DecideGateInput> = {}): DecideGateInput => ({
  baselineEvalObservationId: "observation:" + hash("1"), candidateEvalObservationId: "observation:" + hash("2"),
  baselineHoldoutObservationId: "observation:" + hash("3"), candidateHoldoutObservationId: "observation:" + hash("4"), policy,
  ...overrides,
});

function deps(observations: Record<string, QualityObservation>, events: string[] = [], bundles: Record<string, ReadonlyMap<string, Uint8Array>> = {}): GateDependencies {
  return {
    root: "/private/corpus",
    readBundle: vi.fn(async (_kind: "case" | "observation" | "decision", id: string) => { events.push(`read:${id}`); const value = observations[id]; if (!value) throw new Error("missing private observation"); return bundles[id] ?? bundleFor(value); }),
    publishDecision: vi.fn(async () => ({ status: "committed" as const })),
    now: () => new Date("2026-09-01T12:00:00.000Z"),
  };
}

describe("feedback quality gate", () => {
  const roots: string[] = [];
  afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("compares eval before it reads holdout and publishes a canonical passing decision", async () => {
    const baseEval = observation("eval", "baseline", 4, 6);
    const candidateEval = rebuild(baseEval, "candidate");
    const baseHoldout = observation("holdout", "baseline", 1, 2);
    const candidateHoldout = rebuild(baseHoldout, "candidate");
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
    const candidate = rebuild(base, "candidate", base.cases.slice(1));
    const ids = input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId });
    const events: string[] = [];
    const dependencies = deps({ [base.observationId]: base, [candidate.observationId]: candidate }, events);
    const decision = await decideGate(ids, dependencies);
    expect(decision.verdict).toBe("fail");
    expect(decision.reasons).toContain("positive_regression");
    expect(events).toEqual([`read:${base.observationId}`, `read:${candidate.observationId}`]);
  });

  it("rejects holdout observations supplied in the eval role before metrics", async () => {
    const base = observation("holdout", "baseline", 4, 6);
    const candidate = rebuild(base, "candidate");
    const events: string[] = [];
    const dependencies = deps({ [base.observationId]: base, [candidate.observationId]: candidate }, events);
    const decision = await decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId }), dependencies);
    expect(decision.verdict).toBe("fail");
    expect(decision.reasons).toEqual(["set_mismatch"]);
    expect(events).toEqual([`read:${base.observationId}`]);
  });

  it("rejects eval observations supplied in the holdout role", async () => {
    const baseEval = observation("eval", "baseline", 4, 6);
    const candidateEval = rebuild(baseEval, "candidate");
    const baseHoldout = observation("eval", "baseline", 1, 2);
    const candidateHoldout = rebuild(baseHoldout, "candidate");
    const events: string[] = [];
    const map = { [baseEval.observationId]: baseEval, [candidateEval.observationId]: candidateEval, [baseHoldout.observationId]: baseHoldout, [candidateHoldout.observationId]: candidateHoldout };
    const decision = await decideGate(input({ baselineEvalObservationId: baseEval.observationId, candidateEvalObservationId: candidateEval.observationId, baselineHoldoutObservationId: baseHoldout.observationId, candidateHoldoutObservationId: candidateHoldout.observationId }), deps(map, events));
    expect(decision.verdict).toBe("fail");
    expect(decision.reasons).toEqual(["set_mismatch"]);
    expect(events).toEqual([`read:${baseEval.observationId}`, `read:${candidateEval.observationId}`, `read:${baseHoldout.observationId}`]);
  });

  it("fails closed when a non-primary live attempt is malformed", async () => {
    const base = observation("eval", "baseline", 4, 6);
    const candidateAttempts = base.cases.flatMap((result) => ["live-1", "live-2", "live-3"].map((attemptName) => ({ caseVersion: result.caseVersion, attemptName, result: (attemptName === "live-2" ? { ...result, metrics: { ...result.metrics, score: "malformed" } } : result) as unknown as QualityCaseResult })));
    const { observationId: _candidateId, ...candidateBase } = rebuild(base, "candidate", base.cases, base.createdAt, true);
    const candidate = snapshotAttempts(candidateBase, base.createdAt, candidateAttempts);
    const events: string[] = [];
    const dependencies = deps({ [base.observationId]: base, [candidate.observationId]: candidate }, events, { [candidate.observationId]: bundleFor(candidate, candidateAttempts) });
    const decision = await decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId }), dependencies);
    expect(decision.verdict).toBe("fail");
    expect(decision.reasons).toContain("invalid_schema");
    expect(events).toEqual([`read:${base.observationId}`, `read:${candidate.observationId}`]);
  });

  it("requires robust improvement from at least two of three live attempts", async () => {
    const base = observation("eval", "baseline", 4, 6);
    const candidateCases = base.cases.map((item) => item.disposition === "positive" ? { ...item, metrics: { ...item.metrics, approvedWindowOverlap: 2 } } : item);
    const candidateAttempts = candidateCases.flatMap((result) => ["live-1", "live-2", "live-3"].map((attemptName) => ({ caseVersion: result.caseVersion, attemptName, result: result.disposition === "positive" && attemptName === "live-3" ? { ...result, metrics: { ...result.metrics, approvedWindowOverlap: 1 } } : result })));
    const rebuiltCandidate = rebuild(base, "candidate", candidateCases, base.createdAt, true);
    const { observationId: _candidateId, ...candidateBase } = rebuiltCandidate;
    const candidate = snapshotAttempts(candidateBase, base.createdAt, candidateAttempts);
    const holdout = observation("holdout", "baseline", 1, 2);
    const holdoutCandidate = rebuild(holdout, "candidate");
    const map = { [base.observationId]: base, [candidate.observationId]: candidate, [holdout.observationId]: holdout, [holdoutCandidate.observationId]: holdoutCandidate };
    const dependencies = deps(map, [], { [candidate.observationId]: bundleFor(candidate, candidateAttempts) });
    const decision = await decideGate(input({ claim: "improvement", policy: { ...policy, claim: "improvement" }, baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId, baselineHoldoutObservationId: holdout.observationId, candidateHoldoutObservationId: holdoutCandidate.observationId }), dependencies);
    expect(decision.verdict).toBe("pass");
    expect(decision.eval.attemptCount).toBe(3);
  });

  it("expires no later than the oldest observation plus 24 hours", async () => {
    const base = observation("eval", "baseline", 4, 6, "2026-09-01T00:00:00.000Z");
    const candidate = rebuild(base, "candidate");
    const holdout = observation("holdout", "baseline", 1, 2, "2026-09-01T06:00:00.000Z");
    const holdoutCandidate = rebuild(holdout, "candidate");
    const map = { [base.observationId]: base, [candidate.observationId]: candidate, [holdout.observationId]: holdout, [holdoutCandidate.observationId]: holdoutCandidate };
    const dependencies = { ...deps(map), now: () => new Date("2026-09-01T12:00:00.000Z") };
    const decision = await decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId, baselineHoldoutObservationId: holdout.observationId, candidateHoldoutObservationId: holdoutCandidate.observationId }), dependencies);
    expect(decision.expiresAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it.each([
    ["missing observation", async () => decideGate(input(), deps({})), "invalid_schema"],
    ["expired decision", async () => {
      const base = observation("eval", "baseline", 4, 6, "2026-08-30T00:00:00.000Z");
      const candidate = rebuild(base, "candidate", base.cases, "2026-08-30T00:00:00.000Z");
      const holdout = observation("holdout", "baseline", 1, 2, "2026-08-30T00:00:00.000Z");
      const holdoutCandidate = rebuild(holdout, "candidate", holdout.cases, "2026-08-30T00:00:00.000Z");
      return decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId, baselineHoldoutObservationId: holdout.observationId, candidateHoldoutObservationId: holdoutCandidate.observationId }), deps({ [base.observationId]: base, [candidate.observationId]: candidate, [holdout.observationId]: holdout, [holdoutCandidate.observationId]: holdoutCandidate }));
    }, "stale_case"],
  ])("fails closed for %s", async (_name, run, reason) => expect((await run()).reasons).toContain(reason));

  it("redacts private values from decision report and uses atomic decision bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-gate-")).then((value) => { roots.push(value); return value; });
    const base = observation("eval", "baseline", 4, 6);
    const candidate = rebuild(base, "candidate");
    const holdout = observation("holdout", "baseline", 1, 2);
    const holdoutCandidate = rebuild(holdout, "candidate");
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

  it("rejects a bundle whose manifest ID does not match the requested ID", async () => {
    const base = observation("eval", "baseline", 4, 6);
    const candidate = rebuild(base, "candidate");
    const wrongManifest = JSON.parse(Buffer.from(bundleFor(candidate).get("manifest.json")!).toString("utf8"));
    wrongManifest.observationId = "observation:" + hash("9");
    const wrongBundle = new Map(bundleFor(candidate));
    wrongBundle.set("manifest.json", Buffer.from(canonicalJson(wrongManifest)));
    const dependencies = deps({ [base.observationId]: base, [candidate.observationId]: candidate }, [], { [candidate.observationId]: wrongBundle });
    const decision = await decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId }), dependencies);
    expect(decision.verdict).toBe("fail");
    expect(decision.reasons).toEqual(["invalid_schema"]);
  });

  it("rejects attempts bytes changed after the manifest digest was recorded", async () => {
    const base = observation("eval", "baseline", 4, 6);
    const candidate = rebuild(base, "candidate");
    const original = bundleFor(candidate);
    const changedResults = Buffer.from(Buffer.from(original.get("results.jsonl")!).toString("utf8").replace('"approvedMomentRetained":1', '"approvedMomentRetained":0'));
    const tampered = new Map(original);
    tampered.set("results.jsonl", changedResults);
    const dependencies = deps({ [base.observationId]: base, [candidate.observationId]: candidate }, [], { [candidate.observationId]: tampered });
    const decision = await decideGate(input({ baselineEvalObservationId: base.observationId, candidateEvalObservationId: candidate.observationId }), dependencies);
    expect(decision.verdict).toBe("fail");
    expect(decision.reasons).toEqual(["invalid_schema"]);
  });

  it("reads each immutable observation bundle once, so a swapped second snapshot cannot be consumed", async () => {
    const baseEval = observation("eval", "baseline", 4, 6);
    const candidateEval = rebuild(baseEval, "candidate");
    const baseHoldout = observation("holdout", "baseline", 1, 2);
    const candidateHoldout = rebuild(baseHoldout, "candidate");
    const map = { [baseEval.observationId]: bundleFor(baseEval), [candidateEval.observationId]: bundleFor(candidateEval), [baseHoldout.observationId]: bundleFor(baseHoldout), [candidateHoldout.observationId]: bundleFor(candidateHoldout) };
    const readBundle = vi.fn(async (_kind: "case" | "observation" | "decision", id: string, _root?: string) => {
      const value = map[id as keyof typeof map];
      if (!value) throw new Error("missing");
      return value;
    });
    const decision = await decideGate(input({ baselineEvalObservationId: baseEval.observationId, candidateEvalObservationId: candidateEval.observationId, baselineHoldoutObservationId: baseHoldout.observationId, candidateHoldoutObservationId: candidateHoldout.observationId }), { readBundle, now: () => new Date("2026-09-01T12:00:00.000Z"), publishDecision: vi.fn(async () => ({ status: "committed" as const })) });
    expect(decision.verdict).toBe("pass");
    expect(readBundle).toHaveBeenCalledTimes(4);
  });
});
