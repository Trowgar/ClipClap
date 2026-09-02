import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { contentId, appendLabelEvent, publishBundle, readBundle } from "../feedback-quality/store";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { MaterializedCase } from "../feedback-quality/promote";

async function runProcess(file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(file, [...args], { cwd: options?.cwd, env: options?.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}
const HASH = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;
const COMMIT = "a".repeat(40);
const SECRET_TRANSCRIPT = "TRANSCRIPT_SECRET_DO_NOT_LOG";
const SECRET_SOURCE = "SOURCE_SECRET_DO_NOT_LOG";
const SECRET_MODEL = "MODEL_SECRET_DO_NOT_LOG";
const SECRET_ENV = "ENV_SECRET_DO_NOT_LOG";
const CONFIG = {
  schemaVersion: 1 as const, runnerVersion: 2, promptFingerprint: HASH("1"), modelFingerprint: HASH("2"), requestFingerprint: HASH("3"),
  recorded: { promptFingerprint: HASH("1"), modelFingerprint: HASH("2"), requestFingerprint: HASH("3") }, envAllowlist: ["QUALITY_E2E_SECRET"],
  engine: { analyze: { modelSecretMarker: SECRET_MODEL } },
};
const TRANSCRIPT = Buffer.from(JSON.stringify({ text: SECRET_TRANSCRIPT, segments: [{ start: 0, end: 10, text: SECRET_TRANSCRIPT, words: [] }] }));
const SOURCE = Buffer.from(SECRET_SOURCE);
const EVIDENCE = Buffer.from(`evidence:${SECRET_SOURCE}`);
const RECORDED = Buffer.from(JSON.stringify({ recorded: { promptFingerprint: CONFIG.promptFingerprint, modelFingerprint: CONFIG.modelFingerprint, requestFingerprint: CONFIG.requestFingerprint }, result: { modelSecretMarker: SECRET_MODEL, highlights: [{ start: 0, end: 10, hookStart: 1, payoffAt: 5, score: 0.9 }], telemetry: { kept: 1, criticVerdicts: 1, omittedDrops: 0, truncatedDrops: 0, refusalDrops: 0, invariantDrops: 0 } } }));

function materializedCase(index: number, set: "eval" | "holdout", positive: boolean): MaterializedCase {
  const body = {
    schemaVersion: 1 as const, feedbackId: `feedback-${index}`, clipId: `clip-${index}`, jobId: `job-${index}`, userId: `user-${index}`,
    feedbackUpdatedAt: "2026-08-31T00:00:00.000Z", snapshotSha256: HASH("4"), candidateVersion: HASH("5"), set,
    disposition: positive ? "positive" as const : "confirmed_negative" as const, verdict: positive ? "AS_IS" as const : "EDIT" as const,
    subsystem: "selection" as const, confidence: "high" as const,
    expected: { approvedMoment: positive, completeBoundary: positive, sourceWindow: { start: 0, end: 10 }, visualSamples: [] as const },
    inputs: { transcriptSha256: sha256(TRANSCRIPT), evidenceSha256: sha256(EVIDENCE), sourceSha256: sha256(SOURCE), sourceDurationSec: 10, recordedResponsesSha256: sha256(RECORDED) },
    replay: { highlight: { start: 0, end: 10, title: `case-${index}`, hookStart: 1, payoffAt: 5 }, subtitleTrack: null, cropPlan: null, renderManifest: null, reframeConfig: null, musicDirection: null, blackTail: null },
  };
  return { ...body, caseVersion: contentId("case", body) };
}

async function seedCorpus(root: string): Promise<void> {
  const all = [...Array.from({ length: 4 }, (_, i) => materializedCase(i, "eval", true)), ...Array.from({ length: 6 }, (_, i) => materializedCase(i + 4, "eval", false)), materializedCase(10, "holdout", true), ...Array.from({ length: 2 }, (_, i) => materializedCase(i + 11, "holdout", false))];
  for (const qualityCase of all) {
    await publishBundle({ kind: "case", id: qualityCase.caseVersion, files: { "case.json": Buffer.from(`${canonicalJson(qualityCase)}\n`), "transcript.json": TRANSCRIPT, "recorded-responses.json": RECORDED, "source.mp4": SOURCE, "evidence.mp4": EVIDENCE } }, root);
    await appendLabelEvent({ eventId: `label-${qualityCase.feedbackId}`, action: "label", set: qualityCase.set, caseVersion: qualityCase.caseVersion, feedbackId: qualityCase.feedbackId, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, verdict: qualityCase.verdict }, root);
  }
}

function lastJson(output: string): Record<string, unknown> {
  const line = output.trim().split("\n").reverse().find((item) => item.trim().startsWith("{"));
  if (!line) throw new Error("cli_json_missing");
  return JSON.parse(line) as Record<string, unknown>;
}

describe("feedback quality gate end to end", () => {
  it("runs subprocess observe/gate CLI smoke and fails a supported adapter regression", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-quality-e2e-"));
    const configFile = join(root, "config.json");
    await writeFile(configFile, `${JSON.stringify(CONFIG)}\n`, { mode: 0o600 });
    await chmod(configFile, 0o600);
    try {
      await seedCorpus(root);
      const env: NodeJS.ProcessEnv = { ...process.env, QUALITY_ROOT: root, QUALITY_E2E_SECRET: SECRET_ENV };
      delete env.FEEDBACK_QUALITY_ROOT; // observe's executable currently consumes QUALITY_ROOT.
      const repositoryRoot = resolve(__dirname, "../../../../");
      const pathSeparator = process.platform === "win32" ? ";" : ":";
      const node20Env: NodeJS.ProcessEnv = { ...env, PATH: `${dirname(process.execPath)}${pathSeparator}${env.PATH ?? ""}` };
      const tsx = resolve(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
      const observeModule = resolve(__dirname, "../scripts/feedback-quality-observe.ts");
      const gateModule = resolve(__dirname, "../scripts/feedback-quality-gate.ts");
      // The public observe CLI function is the supported fixture-adapter seam.
      // Run it in a fresh Node process through the local tsx CLI so stdout,
      // stderr, and the real content-addressed publisher are exercised.
      const runFixture = async (set: "eval" | "holdout", mode: "baseline" | "candidate", regression = false) => {
        const adapterScript = [
          `import { readFile } from "node:fs/promises"; import { runObservationCli } from ${JSON.stringify(observeModule)}; import { loadPrivateCases, observeQualitySet } from ${JSON.stringify(resolve(__dirname, "../feedback-quality/observe.ts"))};`,
          `(async () => { const set = process.env.QUALITY_E2E_SET; const mode = process.env.QUALITY_E2E_MODE; const runCase = async (qualityCase) => { const positiveRegression = process.env.QUALITY_E2E_REGRESSION === "1" && qualityCase.feedbackId === "feedback-0"; return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "ok", metrics: qualityCase.disposition === "positive" ? { approvedMomentRetained: positiveRegression ? 0 : 1, approvedWindowOverlap: positiveRegression ? 0 : 1, emptyResult: positiveRegression ? 1 : 0, zeroClipFalseNegative: positiveRegression ? 1 : 0 } : { defectSeverity: 0 } }; }; const result = process.env.QUALITY_E2E_REGRESSION === "1" ? await (async () => { const config = JSON.parse(await readFile(process.env.QUALITY_E2E_CONFIG, "utf8")); const loaded = await loadPrivateCases(set, process.env.QUALITY_ROOT); return observeQualitySet({ set, mode, commitSha: ${JSON.stringify(COMMIT)}, config, corpusSha256: loaded.corpusSha256, runnerVersion: 2, cases: loaded.cases.filter((qualityCase) => qualityCase.feedbackId !== "feedback-0"), root: process.env.QUALITY_ROOT, environment: { QUALITY_E2E_SECRET: process.env.QUALITY_E2E_SECRET }, allowedEnvironment: ["QUALITY_E2E_SECRET"], promptFingerprint: config.promptFingerprint, modelFingerprint: config.modelFingerprint, requestFingerprint: config.requestFingerprint, recorded: config.recorded, dependencies: { runCase } }); })() : await runObservationCli(["--set", set, "--mode", mode, "--commit", ${JSON.stringify(COMMIT)}, "--config-file", process.env.QUALITY_E2E_CONFIG], { root: process.env.QUALITY_ROOT, dependencies: { runCase } }); console.log(JSON.stringify({ observationId: result.observationId, set: result.set, mode: result.mode, caseCount: result.cases.length })); })().catch((error) => { console.error(error instanceof Error ? error.message : "observe_failed"); process.exitCode = 1; });`,
        ].join("\n");
        return runProcess(process.execPath, [tsx, "-e", adapterScript], {
          cwd: repositoryRoot,
          env: { ...node20Env, QUALITY_E2E_SET: set, QUALITY_E2E_MODE: mode, QUALITY_E2E_CONFIG: configFile, ...(regression ? { QUALITY_E2E_REGRESSION: "1" } : {}) },
        });
      };
      const baselineEvalProcess = await runFixture("eval", "baseline");
      const candidateEvalProcess = await runFixture("eval", "candidate");
      const baselineHoldoutProcess = await runFixture("holdout", "baseline");
      const candidateHoldoutProcess = await runFixture("holdout", "candidate");
      for (const processResult of [baselineEvalProcess, candidateEvalProcess, baselineHoldoutProcess, candidateHoldoutProcess]) expect(processResult.code).toBe(0);
      const baselineEval = lastJson(baselineEvalProcess.stdout);
      const candidateEval = lastJson(candidateEvalProcess.stdout);
      const baselineHoldout = lastJson(baselineHoldoutProcess.stdout);
      const candidateHoldout = lastJson(candidateHoldoutProcess.stdout);
      const gateCommand = (candidateId: string) => ["--baseline-eval", baselineEval.observationId as string, "--candidate-eval", candidateId, "--baseline-holdout", baselineHoldout.observationId as string, "--candidate-holdout", candidateHoldout.observationId as string, "--claim", "non-regression"];
      const passingGate = await runProcess(process.execPath, [tsx, gateModule, ...gateCommand(candidateEval.observationId as string)], { cwd: repositoryRoot, env: node20Env });
      expect(passingGate.code).toBe(0);
      const passLog = lastJson(passingGate.stdout);
      expect(passLog).toMatchObject({ operation: "gate", verdict: "pass", reasons: [] });
      const passBundle = await readBundle("decision", passLog.decisionId as string, root);
      const passDecisionText = `${Buffer.from(passBundle.get("decision.json") ?? []).toString("utf8")}\n${Buffer.from(passBundle.get("report.md") ?? []).toString("utf8")}\n${passingGate.stdout}\n${passingGate.stderr}`;
      expect(passDecisionText).not.toMatch(/TRANSCRIPT_SECRET_DO_NOT_LOG|SOURCE_SECRET_DO_NOT_LOG|MODEL_SECRET_DO_NOT_LOG|ENV_SECRET_DO_NOT_LOG|OPENAI_API_KEY|model-fingerprint|source-[0-9]/i);

      // Gate policy names a dropped positive as positive_regression. Keep the
      // source corpus/digest immutable and exercise that result through the
      // lower-level supported fixture adapter (the normal four observations
      // above use the public observe CLI entrypoint).
      const syntheticProcess = await runFixture("eval", "candidate", true);
      expect(syntheticProcess.code).toBe(0);
      const synthetic = lastJson(syntheticProcess.stdout);
      const failingGate = await runProcess(process.execPath, [tsx, gateModule, ...gateCommand(synthetic.observationId as string)], { cwd: repositoryRoot, env: node20Env });
      expect(failingGate.code).toBe(1);
      const failureLog = lastJson(`${failingGate.stdout}\n${failingGate.stderr}`);
      expect(failureLog.reasons).toContain("positive_regression");
      const failureBundle = await readBundle("decision", failureLog.decisionId as string, root);
      const failureText = `${Buffer.from(failureBundle.get("decision.json") ?? []).toString("utf8")}\n${Buffer.from(failureBundle.get("report.md") ?? []).toString("utf8")}\n${failingGate.stdout}\n${failingGate.stderr}`;
      const allOutput = [baselineEvalProcess, candidateEvalProcess, baselineHoldoutProcess, candidateHoldoutProcess, syntheticProcess, passingGate, failingGate].map((item) => `${item.stdout}\n${item.stderr}`).join("\n");
      expect(`${passDecisionText}\n${failureText}\n${allOutput}`).not.toMatch(/TRANSCRIPT_SECRET_DO_NOT_LOG|SOURCE_SECRET_DO_NOT_LOG|MODEL_SECRET_DO_NOT_LOG|ENV_SECRET_DO_NOT_LOG|OPENAI_API_KEY|model-fingerprint|source-[0-9]/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
