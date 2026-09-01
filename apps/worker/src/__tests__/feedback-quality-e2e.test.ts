import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { observeQualitySet, loadPrivateCases } from "../feedback-quality/observe";
import { contentId, appendLabelEvent, publishBundle, readBundle } from "../feedback-quality/store";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { runObservationCli } from "../scripts/feedback-quality-observe";
import type { MaterializedCase } from "../feedback-quality/promote";
import type { QualityCaseResult } from "../feedback-quality/types";

async function runProcess(file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(file, [...args], { cwd: options?.cwd, env: options?.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult({ code: code === 0 && /npm ERR! Lifecycle script/.test(stderr) ? 1 : (code ?? 1), stdout, stderr }));
  });
}
const HASH = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;
const COMMIT = "a".repeat(40);
const CONFIG = {
  schemaVersion: 1 as const, runnerVersion: 2, promptFingerprint: HASH("1"), modelFingerprint: HASH("2"), requestFingerprint: HASH("3"),
  recorded: { promptFingerprint: HASH("1"), modelFingerprint: HASH("2"), requestFingerprint: HASH("3") }, envAllowlist: [], engine: {},
};
const TRANSCRIPT = Buffer.from(JSON.stringify({ text: "hello world", segments: [{ start: 0, end: 10, text: "hello world", words: [] }] }));
const EVIDENCE = Buffer.from("private-evidence");
const RECORDED = Buffer.from(JSON.stringify({ recorded: { promptFingerprint: CONFIG.promptFingerprint, modelFingerprint: CONFIG.modelFingerprint, requestFingerprint: CONFIG.requestFingerprint }, result: { highlights: [{ start: 0, end: 10, hookStart: 1, payoffAt: 5, score: 0.9 }], telemetry: { kept: 1, criticVerdicts: 1, omittedDrops: 0, truncatedDrops: 0, refusalDrops: 0, invariantDrops: 0 } } }));

function resultFor(qualityCase: MaterializedCase, regression = false): QualityCaseResult {
  const positive = qualityCase.disposition === "positive";
  return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "ok", metrics: positive
    ? { approvedMomentRetained: regression ? 0 : 1, approvedWindowOverlap: regression ? 0 : 1, emptyResult: regression ? 1 : 0, zeroClipFalseNegative: regression ? 1 : 0 }
    : { defectSeverity: 0 } };
}

function materializedCase(index: number, set: "eval" | "holdout", positive: boolean): MaterializedCase {
  const body = {
    schemaVersion: 1 as const, feedbackId: `feedback-${index}`, clipId: `clip-${index}`, jobId: `job-${index}`, userId: `user-${index}`,
    feedbackUpdatedAt: "2026-08-31T00:00:00.000Z", snapshotSha256: HASH("4"), candidateVersion: HASH("5"), set,
    disposition: positive ? "positive" as const : "confirmed_negative" as const, verdict: positive ? "AS_IS" as const : "EDIT" as const,
    subsystem: "selection" as const, confidence: "high" as const,
    expected: { approvedMoment: positive, completeBoundary: positive, sourceWindow: { start: 0, end: 10 }, visualSamples: [] as const },
    inputs: { transcriptSha256: sha256(TRANSCRIPT), evidenceSha256: sha256(EVIDENCE), sourceSha256: null, sourceDurationSec: 10, recordedResponsesSha256: sha256(RECORDED) },
    replay: { highlight: { start: 0, end: 10, title: `case-${index}`, hookStart: 1, payoffAt: 5 }, subtitleTrack: null, cropPlan: null, renderManifest: null, reframeConfig: null, musicDirection: null, blackTail: null },
  };
  return { ...body, caseVersion: contentId("case", body) };
}

async function seedCorpus(root: string): Promise<void> {
  const all = [...Array.from({ length: 4 }, (_, i) => materializedCase(i, "eval", true)), ...Array.from({ length: 6 }, (_, i) => materializedCase(i + 4, "eval", false)), materializedCase(10, "holdout", true), ...Array.from({ length: 2 }, (_, i) => materializedCase(i + 11, "holdout", false))];
  for (const qualityCase of all) {
    await publishBundle({ kind: "case", id: qualityCase.caseVersion, files: { "case.json": Buffer.from(`${canonicalJson(qualityCase)}\n`), "transcript.json": TRANSCRIPT, "recorded-responses.json": RECORDED, "evidence.mp4": EVIDENCE } }, root);
    await appendLabelEvent({ eventId: `label-${qualityCase.feedbackId}`, action: "label", set: qualityCase.set, caseVersion: qualityCase.caseVersion, feedbackId: qualityCase.feedbackId, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, verdict: qualityCase.verdict }, root);
  }
}

function lastJson(output: string): Record<string, unknown> {
  const line = output.trim().split("\n").reverse().find((item) => item.trim().startsWith("{"));
  if (!line) throw new Error("cli_json_missing");
  return JSON.parse(line) as Record<string, unknown>;
}

describe("feedback quality gate end to end", () => {
  it("runs package-script observe/gate smoke and fails a supported adapter regression", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-quality-e2e-"));
    const configFile = join(root, "config.json");
    await writeFile(configFile, `${JSON.stringify(CONFIG)}\n`, { mode: 0o600 });
    await chmod(configFile, 0o600);
    try {
      await seedCorpus(root);
      const env: NodeJS.ProcessEnv = { ...process.env, QUALITY_ROOT: root };
      delete env.FEEDBACK_QUALITY_ROOT; // observe's executable currently consumes QUALITY_ROOT.
      const npm = "/usr/share/nodejs/npm/bin/npm-cli.js";
      // The public observe CLI function is the supported fixture-adapter seam:
      // it still reads the private corpus and uses the real content-addressed
      // publisher, while avoiding model/ffmpeg work in this deterministic test.
      const runFixture = async (set: "eval" | "holdout", mode: "baseline" | "candidate") => {
        return runObservationCli(["--set", set, "--mode", mode, "--commit", COMMIT, "--config-file", configFile], {
          root,
          dependencies: { runCase: async (qualityCase) => resultFor(qualityCase) },
        });
      };
      const baselineEval = await runFixture("eval", "baseline");
      const candidateEval = await runFixture("eval", "candidate");
      const baselineHoldout = await runFixture("holdout", "baseline");
      const candidateHoldout = await runFixture("holdout", "candidate");
      const gateCommand = (candidateId: string) => ["run", "feedback-quality-gate", "-w", "@clipclap/worker", "--", "--baseline-eval", baselineEval.observationId, "--candidate-eval", candidateId, "--baseline-holdout", baselineHoldout.observationId, "--candidate-holdout", candidateHoldout.observationId, "--claim", "non-regression"];
      const passingGate = await runProcess(process.execPath, [npm, ...gateCommand(candidateEval.observationId)], { cwd: resolve(__dirname, "../../../../"), env, maxBuffer: 4 * 1024 * 1024 });
      expect(passingGate.code).toBe(0);
      const passLog = lastJson(passingGate.stdout);
      expect(passLog).toMatchObject({ operation: "gate", verdict: "pass", reasons: [] });
      const passBundle = await readBundle("decision", passLog.decisionId as string, root);
      const passDecisionText = `${Buffer.from(passBundle.get("decision.json") ?? []).toString("utf8")}\n${Buffer.from(passBundle.get("report.md") ?? []).toString("utf8")}\n${passingGate.stdout}\n${passingGate.stderr}`;
      expect(passDecisionText).not.toMatch(/hello world|private-evidence|OPENAI_API_KEY|model-fingerprint|source-[0-9]/i);

      const syntheticLoaded = await loadPrivateCases("eval", root);
      const synthetic = await observeQualitySet({ set: "eval", mode: "candidate", commitSha: COMMIT, config: CONFIG, corpusSha256: syntheticLoaded.corpusSha256, runnerVersion: 2, cases: syntheticLoaded.cases, root, environment: {}, allowedEnvironment: [], promptFingerprint: CONFIG.promptFingerprint, modelFingerprint: CONFIG.modelFingerprint, requestFingerprint: CONFIG.requestFingerprint, recorded: CONFIG.recorded, dependencies: { runCase: async (qualityCase) => resultFor(qualityCase, qualityCase.disposition === "positive") } });
      const failingGate = await runProcess(process.execPath, [npm, ...gateCommand(synthetic.observationId)], { cwd: resolve(__dirname, "../../../../"), env, maxBuffer: 4 * 1024 * 1024 });
      expect(failingGate.code).toBe(1);
      const failureLog = lastJson(`${failingGate.stdout}\n${failingGate.stderr}`);
      expect(failureLog.reasons).toContain("hard_invariant_regression");
      const serialized = JSON.stringify(failureLog);
      expect(serialized).not.toMatch(/hello world|private-evidence|OPENAI_API_KEY|model-fingerprint|source-[0-9]/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
