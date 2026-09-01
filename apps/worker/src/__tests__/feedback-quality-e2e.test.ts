import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runFeedbackQualityGate } from "../scripts/feedback-quality-gate";
import { runObservationCli } from "../scripts/feedback-quality-observe";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { contentId, appendLabelEvent, publishBundle, type CommitResult } from "../feedback-quality/store";
import { observeQualitySet, serializeObservationAttempts, type ObservationAttemptRecord } from "../feedback-quality/observe";
import type { MaterializedCase } from "../feedback-quality/promote";
import type { QualityCaseResult, QualityObservation } from "../feedback-quality/types";

const HASH = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;
const COMMIT = "a".repeat(40);
const CONFIG = {
  schemaVersion: 1 as const,
  runnerVersion: 2,
  promptFingerprint: HASH("1"),
  modelFingerprint: HASH("2"),
  requestFingerprint: HASH("3"),
  recorded: { promptFingerprint: HASH("1"), modelFingerprint: HASH("2"), requestFingerprint: HASH("3") },
  envAllowlist: [],
  engine: {},
};

const policyMetrics = (positive: boolean, regression = false) => positive
  ? { approvedMomentRetained: regression ? 0 : 1, approvedWindowOverlap: regression ? 0 : 1, emptyResult: regression ? 1 : 0, zeroClipFalseNegative: regression ? 1 : 0 }
  : { defectSeverity: regression ? 1 : 0 };

function materializedCase(index: number, set: "eval" | "holdout", positive: boolean): MaterializedCase {
  const body = {
    schemaVersion: 1 as const, feedbackId: `feedback-${index}`, clipId: `clip-${index}`, jobId: `job-${index}`, userId: `user-${index}`,
    feedbackUpdatedAt: "2026-08-31T00:00:00.000Z", snapshotSha256: HASH("4"), candidateVersion: HASH("5"), set,
    disposition: positive ? "positive" as const : "confirmed_negative" as const, verdict: positive ? "AS_IS" as const : "EDIT" as const,
    subsystem: "selection" as const, confidence: "high" as const,
    expected: { approvedMoment: positive, completeBoundary: positive, visualSamples: [] as const },
    inputs: { transcriptSha256: null, evidenceSha256: HASH("6"), sourceSha256: null, sourceDurationSec: null, recordedResponsesSha256: null },
    replay: { highlight: { start: 0, end: 1, title: `case-${index}` }, subtitleTrack: null, cropPlan: null, renderManifest: null, reframeConfig: null, musicDirection: null, blackTail: null },
  };
  return { ...body, caseVersion: contentId("case", body) };
}

function resultFor(qualityCase: MaterializedCase, regression = false): QualityCaseResult {
  return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "ok", metrics: policyMetrics(qualityCase.disposition === "positive", regression) };
}

async function publishObservation(observation: QualityObservation, attempts: readonly ObservationAttemptRecord[], root: string): Promise<CommitResult> {
  const results = serializeObservationAttempts(attempts);
  const caseVersions = observation.cases.map((item) => item.caseVersion).sort();
  const manifest = { schemaVersion: 1, observationId: observation.observationId, set: observation.set, mode: observation.mode, live: false, commitSha: observation.commitSha, configSha256: observation.configSha256, corpusSha256: observation.corpusSha256, runnerVersion: observation.runnerVersion, createdAt: observation.createdAt, caseVersions, attemptCount: attempts.length, attemptsSha256: sha256(results) };
  return publishBundle({ kind: "observation", id: observation.observationId, files: { "manifest.json": Buffer.from(`${canonicalJson(manifest)}\n`), "results.jsonl": Buffer.from(results) } }, root);
}

async function seedCorpus(root: string): Promise<{ evalCases: MaterializedCase[]; holdoutCases: MaterializedCase[] }> {
  const all = [...Array.from({ length: 4 }, (_, index) => materializedCase(index, "eval", true)), ...Array.from({ length: 6 }, (_, index) => materializedCase(index + 4, "eval", false)), materializedCase(10, "holdout", true), ...Array.from({ length: 2 }, (_, index) => materializedCase(index + 11, "holdout", false))];
  for (const qualityCase of all) {
    await publishBundle({ kind: "case", id: qualityCase.caseVersion, files: { "case.json": Buffer.from(`${canonicalJson(qualityCase)}\n`), "evidence.mp4": Buffer.from("private-evidence") } }, root);
    await appendLabelEvent({ eventId: `label-${qualityCase.feedbackId}`, action: "label", set: qualityCase.set, caseVersion: qualityCase.caseVersion, feedbackId: qualityCase.feedbackId, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, verdict: qualityCase.verdict }, root);
  }
  return { evalCases: all.filter((item) => item.set === "eval"), holdoutCases: all.filter((item) => item.set === "holdout") };
}

describe("feedback quality gate end to end", () => {
  it("passes identical baseline/candidate eval+holdout and fails a synthetic positive regression", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-quality-e2e-"));
    const configFile = join(root, "config.json");
    await writeFile(configFile, `${JSON.stringify(CONFIG)}\n`, { mode: 0o600 });
    await chmod(configFile, 0o600);
    try {
      const { evalCases, holdoutCases } = await seedCorpus(root);
      expect(evalCases.filter((item) => item.disposition === "positive")).toHaveLength(4);
      expect(evalCases.filter((item) => item.disposition === "confirmed_negative")).toHaveLength(6);
      expect(holdoutCases.filter((item) => item.disposition === "positive")).toHaveLength(1);
      expect(holdoutCases.filter((item) => item.disposition === "confirmed_negative")).toHaveLength(2);
      const run = async (set: "eval" | "holdout", mode: "baseline" | "candidate", cases: readonly MaterializedCase[], regression = false) => runObservationCli(["--set", set, "--mode", mode, "--commit", COMMIT, "--config-file", configFile], {
        root, dependencies: {
          runCase: async (qualityCase) => resultFor(qualityCase, regression && qualityCase.disposition === "positive"),
          publish: (observation, attempts) => publishObservation(observation, attempts, root),
        },
      });
      const baselineEval = await run("eval", "baseline", evalCases);
      const candidateEval = await run("eval", "candidate", evalCases);
      const baselineHoldout = await run("holdout", "baseline", holdoutCases);
      const candidateHoldout = await run("holdout", "candidate", holdoutCases);
      const args = ["--baseline-eval", baselineEval.observationId, "--candidate-eval", candidateEval.observationId, "--baseline-holdout", baselineHoldout.observationId, "--candidate-holdout", candidateHoldout.observationId, "--claim", "non-regression"];
      const passLogs: string[] = [];
      expect(await runFeedbackQualityGate(args, { root, io: { stdout: (line) => passLogs.push(line), stderr: (line) => passLogs.push(line) } })).toBe(0);
      const passLog = JSON.parse(passLogs[0]) as Record<string, unknown>;
      expect(Object.keys(passLog).sort()).toEqual(["decisionId", "operation", "reasons", "verdict"]);

      // Keep the corpus digest/config/commit fixed while omitting one reviewed
      // positive from the candidate observation. This exercises the policy's
      // positive-disappearance path instead of a hard-invariant metric path.
      const regressionEval = await observeQualitySet({
        set: "eval", mode: "candidate", commitSha: COMMIT, config: CONFIG,
        corpusSha256: baselineEval.corpusSha256 as `sha256:${string}`, runnerVersion: 2, cases: evalCases.slice(1), root,
        environment: {}, allowedEnvironment: [], promptFingerprint: CONFIG.promptFingerprint,
        modelFingerprint: CONFIG.modelFingerprint, requestFingerprint: CONFIG.requestFingerprint, recorded: CONFIG.recorded,
        dependencies: { runCase: async (qualityCase) => resultFor(qualityCase), publish: (observation, attempts) => publishObservation(observation, attempts, root) },
      });
      const logs: string[] = [];
      expect(await runFeedbackQualityGate(["--baseline-eval", baselineEval.observationId, "--candidate-eval", regressionEval.observationId, "--baseline-holdout", baselineHoldout.observationId, "--candidate-holdout", candidateHoldout.observationId, "--claim", "non-regression"], { root, io: { stdout: (line) => logs.push(line), stderr: (line) => logs.push(line) } })).toBe(1);
      expect(logs.join("\n")).toContain("positive_regression");
      expect(logs.join("\n")).not.toMatch(/feedback-[0-9]|clip-[0-9]|job-[0-9]|user-[0-9]/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
