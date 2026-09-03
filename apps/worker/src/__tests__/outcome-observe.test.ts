import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { requestKey } from "./helpers/replay-client";
import { outcomeFreshnessSha256, type OutcomeCase } from "../feedback-quality/outcome-types";
import { OUTCOME_OBSERVATION_RUNNER_VERSION, fingerprintOutcomeRequest, observeOutcomeCases, publishOutcomeObservation, type OutcomeObservationCase } from "../feedback-quality/outcome-observe";
import { readOutcomeCandidateConfig, runOutcomeObserve } from "../scripts/outcome-observe";

const roots: string[] = [];
const digest = (value: string) => sha256(Buffer.from(value));
const COMMIT = "a".repeat(40);

function recordingBytes(recordings: readonly any[]): Buffer {
  return Buffer.from(recordings.map((recording) => canonicalJson(recording)).join("\n") + (recordings.length ? "\n" : ""));
}

function outcomeCase(transcript: unknown, recordings: readonly any[], overrides: Partial<OutcomeCase> = {}): OutcomeCase {
  const binding = {
    jobIdentitySha256: digest("job"), jobUpdatedAt: "2026-09-02T20:00:00.000Z", reviewedAt: "2026-09-02T20:10:00.000Z", materializedAt: "2026-09-02T20:11:00.000Z",
    analyzeStepSha256: digest("step"), analysisVersion: "core-v4-recovery-v1", engineFingerprint: digest("recorded-engine"), configSha256: digest("recorded-config"),
    transcriptSha256: sha256(Buffer.from(canonicalJson(transcript))), sourceSha256: digest("source"), recordedResponsesSha256: sha256(recordingBytes(recordings)),
  };
  const body = {
    schemaVersion: 1 as const, ...binding, sourceDurationSec: 120, freshnessSha256: outcomeFreshnessSha256(binding), set: "eval" as const,
    disposition: "recoverable_false_negative" as const, confidence: "high" as const, subsystem: "selection" as const,
    expected: { approvedWindows: [{ start: 10, end: 30 }], forbiddenWindows: [{ start: 80, end: 90 }] }, ...overrides,
  };
  delete (body as { caseVersion?: unknown }).caseVersion;
  return { ...body, caseVersion: sha256(canonicalJson(body)) } as OutcomeCase;
}

function artifact(overrides: Partial<Omit<OutcomeObservationCase, "case">> & { caseOverrides?: Partial<OutcomeCase> } = {}): OutcomeObservationCase {
  const transcript = overrides.transcript ?? { text: "PRIVATE TRANSCRIPT", segments: [] };
  const recordedResponses = overrides.recordedResponses ?? [];
  return { case: outcomeCase(transcript, recordedResponses, overrides.caseOverrides), transcript, recordedResponses };
}

function recoveryTelemetry(mode: "shadow" | "on") {
  return {
    version: "core-v4-recovery-v1", mode, eligible: true, reason: "unjudged_tail", tailSize: 2, poolSize: 2,
    excludedMissingRange: 0, judged: 2, counters: { selectedForFinalizer: 1, finalizerSurvivors: 1 },
    primaryDispositions: { not_selected_for_critic: 2 }, recoveryDispositions: { shipped: 1, critic_rejected: 1 },
    addedUsage: { inputTokens: 0, outputTokens: 0, requests: 2, byModel: { critic: { inputTokens: 0, outputTokens: 0, requests: 2 } } },
    elapsedMs: 4, ranges: [{ startMs: 12_000, endMs: 25_000 }], outcome: mode === "shadow" ? "shadow_hit" : "shipped",
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("immutable zero-outcome observations", () => {
  it("binds candidate results to code, engine, corpus, runner and recordings with a closed case shape", async () => {
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "on" as const, outcomeRecoveryMaxCandidates: 6 };
    const observation = await observeOutcomeCases({ mode: "candidate", commitSha: COMMIT, config: cfg, cases: [artifact()] }, {
      analyze: vi.fn(async (_transcript, options) => {
        expect(options.cfg.outcomeRecoveryMode).toBe("on");
        return { highlights: [{ start: 12, end: 25, title: "PRIVATE TITLE" }], telemetry: { outcomeRecovery: recoveryTelemetry("on") }, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } } as never;
      }),
    });
    expect(observation).toMatchObject({
      schemaVersion: 1, mode: "candidate", commitSha: COMMIT, engineFingerprint: expect.stringMatching(/^sha256:/),
      corpusDigest: expect.stringMatching(/^sha256:/), runnerVersion: OUTCOME_OBSERVATION_RUNNER_VERSION, recordedResponsesDigest: expect.stringMatching(/^sha256:/),
      results: [{ caseVersion: artifact().case.caseVersion, disposition: "recoverable_false_negative", shippedWindows: [{ start: 12, end: 25 }], approvedHits: 1,
        forbiddenHits: 0, keepFalseShipped: 0, explicitGateResurrections: 0, candidateCap: 6, criticBatches: 1, noClipsReason: null }],
    });
    expect(Object.keys(observation.results[0]).sort()).toEqual(["approvedHits", "candidateCap", "caseVersion", "criticBatches", "disposition", "explicitGateResurrections", "forbiddenHits", "keepFalseShipped", "noClipsReason", "shippedWindows"]);
    expect(canonicalJson(observation)).not.toContain("PRIVATE");
  });

  it("forces baseline recovery off while candidate uses the supplied V4 configuration", async () => {
    const modes: string[] = [];
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "on" as const };
    const analyze = vi.fn(async (_transcript, options) => {
      modes.push(options.cfg.outcomeRecoveryMode);
      return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: options.cfg.outcomeRecoveryMode === "on" ? { outcomeRecovery: recoveryTelemetry("on") } : {}, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } } as never;
    });
    await observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact()] }, { analyze });
    await observeOutcomeCases({ mode: "candidate", commitSha: COMMIT, config: cfg, cases: [artifact()] }, { analyze });
    expect(modes).toEqual(["off", "on"]);
  });

  it("scores bounded hypothetical windows from a shadow candidate", async () => {
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" as const };
    const observation = await observeOutcomeCases({ mode: "candidate", commitSha: COMMIT, config: cfg, cases: [artifact()] }, {
      analyze: async () => ({ highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: { outcomeRecovery: recoveryTelemetry("shadow") }, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } }) as never,
    });
    expect(observation.results[0]).toMatchObject({ shippedWindows: [{ start: 12, end: 25 }], approvedHits: 1 });
  });

  it("replays exact recorded request bodies and fails closed on missing or drifted requests", async () => {
    const body = { model: "model-a", messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }], temperature: 0.2 };
    const recording = { ...fingerprintOutcomeRequest(body), result: { results: [] } };
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "off" as const };
    const analyze = async (_transcript: unknown, options: any) => {
      await options.client.chat.completions.create(body);
      return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } };
    };
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact({ recordedResponses: [recording] })] }, { analyze: analyze as never })).resolves.toMatchObject({ results: [{ noClipsReason: "NO_VIABLE_MOMENTS" }] });
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact()] }, { analyze: analyze as never })).rejects.toMatchObject({ code: "missing_request" });
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact({ recordedResponses: [{ ...recording, requestFingerprint: digest("drift") }] })] }, { analyze: analyze as never })).rejects.toMatchObject({
      code: "request_fingerprint_drift", requiredLiveLane: { attempts: 3, named: true },
    });
    const changedModel = async (_transcript: unknown, options: any) => {
      await options.client.chat.completions.create({ ...body, model: "model-b" });
      return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } };
    };
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact({ recordedResponses: [recording] })] }, { analyze: changedModel as never })).rejects.toMatchObject({
      code: "live_lane_required", requiredLiveLane: { attempts: 3, named: true },
    });
    const swallowedDrift = async (_transcript: unknown, options: any) => {
      try { await options.client.chat.completions.create({ ...body, model: "model-b" }); } catch { /* mirrors analyzer retry/fallback containment */ }
      return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } };
    };
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact({ recordedResponses: [recording] })] }, { analyze: swallowedDrift as never })).rejects.toMatchObject({ code: "live_lane_required" });
  });

  it("fails closed when exact case, transcript, source or recording bindings drift", async () => {
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "off" as const };
    const analyze = async () => ({ highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } }) as never;
    const original = artifact();
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [{ ...original, transcript: { text: "tampered", segments: [] } }] }, { analyze })).rejects.toMatchObject({ code: "invalid_case" });
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [{ ...original, recordedResponses: [{ ...fingerprintOutcomeRequest({ model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] }), result: {} }] }] }, { analyze })).rejects.toMatchObject({ code: "invalid_case" });
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [{ ...original, case: { ...original.case, sourceSha256: digest("changed-source") } }] }, { analyze })).rejects.toMatchObject({ code: "invalid_case" });
  });

  it("requires exact replay consumption including multiplicity and order", async () => {
    const bodyA = { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "a" }] };
    const bodyB = { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "b" }] };
    const a = { ...fingerprintOutcomeRequest(bodyA), result: {} };
    const b = { ...fingerprintOutcomeRequest(bodyB), result: {} };
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "off" as const };
    const result = { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } } as never;
    const once = async (_t: unknown, options: any) => { await options.client.chat.completions.create(bodyA); return result; };
    const twice = async (_t: unknown, options: any) => { await options.client.chat.completions.create(bodyA); await options.client.chat.completions.create(bodyA); return result; };
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact({ recordedResponses: [a, a] })] }, { analyze: once as never })).rejects.toMatchObject({ code: "recording_not_consumed" });
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact({ recordedResponses: [a] })] }, { analyze: twice as never })).rejects.toMatchObject({ code: "missing_request" });
    await expect(observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact({ recordedResponses: [a, b] })] }, { analyze: async (_t, options) => { await (options.client as any).chat.completions.create(bodyB); return result; } })).rejects.toMatchObject({ code: "request_fingerprint_drift" });
  });

  it("accepts only a named materialized live lane with three independent stable attempts", async () => {
    const body = { model: "live-model", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] };
    const response = { ...fingerprintOutcomeRequest(body), result: {} };
    const deterministicOnly = { ...fingerprintOutcomeRequest({ ...body, model: "must-not-be-used" }), result: {} };
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "on" as const };
    const cases = [artifact({ recordedResponses: [deterministicOnly] })];
    const liveLane = {
      schemaVersion: 1 as const, name: "v4_recovery_live_20260903",
      attempts: [1, 2, 3].map((number) => ({ attemptId: `attempt-${number}`, recordedAt: `2026-09-03T00:0${number}:00.000Z`, cases: [{ caseVersion: cases[0].case.caseVersion, recordedResponses: [response] }] })),
    };
    const analyze = vi.fn(async (_t, options: any) => {
      await options.client.chat.completions.create(body);
      return { highlights: [{ start: 12, end: 25 }], telemetry: { outcomeRecovery: recoveryTelemetry("on") }, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } } as never;
    });
    const observation = await observeOutcomeCases({ mode: "candidate", commitSha: COMMIT, config: cfg, cases, liveLane }, { analyze });
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(observation).toMatchObject({ liveLane: { name: "v4_recovery_live_20260903", attempts: 3, attemptDigests: [expect.stringMatching(/^sha256:/), expect.any(String), expect.any(String)] } });
    await expect(observeOutcomeCases({ mode: "candidate", commitSha: COMMIT, config: cfg, cases, liveLane: { ...liveLane, attempts: liveLane.attempts.slice(0, 2) } }, { analyze })).rejects.toMatchObject({ code: "invalid_live_lane" });
  });

  it("deterministically replays the full analyzer, not a reduced scoring surrogate", async () => {
    const fixtureRoot = join(__dirname, "fixtures", "eval", "sitcom-friends");
    const transcript = JSON.parse(await readFile(join(fixtureRoot, "transcript.json"), "utf8"));
    const responses = JSON.parse(await readFile(join(fixtureRoot, "responses.json"), "utf8")) as Record<string, string>;
    const captured: any[] = [];
    const captureClient = { chat: { completions: { create: async (body: any) => {
      const system = body.messages.find((message: any) => message.role === "system")?.content ?? "";
      const user = body.messages.find((message: any) => message.role === "user")?.content ?? "";
      const recorded = responses[requestKey({ model: body.model, system, user })];
      if (recorded === undefined) throw new Error("fixture request missing");
      const result = JSON.parse(recorded);
      const fingerprints = fingerprintOutcomeRequest(body);
      captured.push({ ...fingerprints, result });
      if (result.__outcome === "refusal") return { choices: [{ message: { content: null, refusal: "recorded refusal" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
      if (result.__outcome === "truncated") return { choices: [{ message: { content: null, refusal: null }, finish_reason: "length" }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
      return { choices: [{ message: { content: recorded, refusal: null }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
    } } } } as any;
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "on" as const };
    const expected = await analyzeHighlightsV2(transcript, { client: captureClient, cfg, sourceDurationSec: 10_000, retryDelayMs: 1 });
    const observation = await observeOutcomeCases({ mode: "candidate", commitSha: COMMIT, config: cfg, cases: [artifact({ caseOverrides: { sourceDurationSec: 10_000 }, transcript, recordedResponses: captured })] });
    expect(observation.results[0].shippedWindows).toEqual(expected.highlights.map(({ start, end }) => ({ start, end })));
  });

  it.each([
    ["unknown recovery telemetry", { highlights: [], telemetry: { outcomeRecovery: { ...recoveryTelemetry("on"), surprise: true } } }, "unknown_telemetry"],
    ["range beyond duration", { highlights: [{ start: 100, end: 121 }], telemetry: { outcomeRecovery: recoveryTelemetry("on") } }, "output_out_of_duration"],
    ["non-finite range", { highlights: [{ start: Number.NaN, end: 20 }], telemetry: { outcomeRecovery: recoveryTelemetry("on") } }, "output_out_of_duration"],
    ["unclosed no-clips reason", { highlights: [], noClipsReason: "PRIVATE REASON", telemetry: { outcomeRecovery: recoveryTelemetry("on") } }, "unknown_telemetry"],
  ])("fails closed on %s", async (_name, result, code) => {
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "on" as const };
    await expect(observeOutcomeCases({ mode: "candidate", commitSha: COMMIT, config: cfg, cases: [artifact()] }, { analyze: async () => ({ ...result, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } }) as never })).rejects.toMatchObject({ code });
  });

  it("publishes one immutable private observation without overwriting a collision", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clipclap-outcome-observe-")); roots.push(parent);
    const root = join(parent, "outcomes");
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "off" as const };
    const observation = await observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact()] }, { analyze: async () => ({ highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } }) as never });
    await expect(publishOutcomeObservation(root, observation, [artifact()])).resolves.toEqual({ status: "committed" });
    const directory = join(root, "observations", observation.observationId);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "results.jsonl"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "results.jsonl"), "utf8")).toBe(`${canonicalJson(observation)}\n`);
    await expect(publishOutcomeObservation(root, observation, [artifact()])).resolves.toEqual({ status: "noop" });
    await chmod(join(directory, "results.jsonl"), 0o644);
    await expect(publishOutcomeObservation(root, observation, [artifact()])).rejects.toMatchObject({ code: "publication_failed" });
  });

  it("rejects a self-hashed observation carrying private or unknown fields", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clipclap-outcome-observe-private-")); roots.push(parent);
    const root = join(parent, "outcomes");
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "off" as const };
    const observation = await observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [artifact()] }, { analyze: async () => ({ highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } }) as never });
    const { observationId: _old, ...body } = observation;
    const poisonedBody = { ...body, privateNote: "PRIVATE NOTE" };
    const poisoned = { ...poisonedBody, observationId: sha256(canonicalJson(poisonedBody)) };
    await expect(publishOutcomeObservation(root, poisoned as never, [artifact()])).rejects.toMatchObject({ code: "publication_failed" });
  });

  it("rejects arbitrary self-hashed metrics and mismatched authoritative corpus at publication", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clipclap-outcome-observe-authority-")); roots.push(parent);
    const root = join(parent, "outcomes");
    const item = artifact();
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "off" as const };
    const observation = await observeOutcomeCases({ mode: "baseline", commitSha: COMMIT, config: cfg, cases: [item] }, { analyze: async () => ({ highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } }) as never });
    const { observationId: _old, ...body } = observation;
    const forgedBody = { ...body, results: [{ ...body.results[0], approvedHits: 99 }] };
    const forged = { ...forgedBody, observationId: sha256(canonicalJson(forgedBody)) };
    await expect(publishOutcomeObservation(root, forged as never, [item])).rejects.toMatchObject({ code: "publication_failed" });
    await expect(publishOutcomeObservation(root, observation, [artifact({ caseOverrides: { sourceSha256: digest("other") } })])).rejects.toMatchObject({ code: "publication_failed" });
  });

  it("reads a complete closed 0600 AnalyzeConfig and verifies its fingerprint", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clipclap-outcome-config-")); roots.push(parent);
    const path = join(parent, "candidate.json");
    const config = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "on" as const };
    const engineFingerprint = sha256(canonicalJson(config));
    await writeFile(path, canonicalJson({ schemaVersion: 1, engineFingerprint, config }), { mode: 0o600 });
    await expect(readOutcomeCandidateConfig(path)).resolves.toEqual(config);
    await writeFile(path, canonicalJson({ schemaVersion: 1, engineFingerprint, config: { outcomeRecoveryMode: "on", outcomeRecoveryMaxCandidates: 6 } }), { mode: 0o600 });
    await expect(readOutcomeCandidateConfig(path)).rejects.toThrow("private_config_invalid");
    await writeFile(path, canonicalJson({ schemaVersion: 1, engineFingerprint: digest("wrong"), config }), { mode: 0o600 });
    await expect(readOutcomeCandidateConfig(path)).rejects.toThrow("private_config_invalid");
    const badEnum = { ...config, visualRecallMode: "PRIVATE_MODE" };
    await writeFile(path, canonicalJson({ schemaVersion: 1, engineFingerprint: sha256(canonicalJson(badEnum)), config: badEnum }), { mode: 0o600 });
    await expect(readOutcomeCandidateConfig(path)).rejects.toThrow("private_config_invalid");
  });

  it("keeps the CLI aggregate-only and requires an explicit candidate config", async () => {
    const stdout = vi.fn(); const stderr = vi.fn();
    const execute = vi.fn(async () => ({ observationId: digest("observation"), mode: "candidate" as const, caseCount: 2 }));
    await expect(runOutcomeObserve(["--mode", "candidate", "--root", "/private/root", "--config-file", "/private/v4.json"], { execute, commitSha: COMMIT, io: { stdout, stderr } })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ operation: "outcome-observe", status: "committed", mode: "candidate", caseCount: 2 }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ root: "/private/root", configFile: "/private/v4.json", commitSha: COMMIT }));
    await expect(runOutcomeObserve(["--mode", "candidate", "--root", "/private/root"], { execute, commitSha: COMMIT, io: { stdout, stderr } })).resolves.toBe(2);
    await expect(runOutcomeObserve(["--mode", "live:v4_lane", "--root", "/private/root", "--config-file", "/private/v4.json", "--live-lane-file", "/private/live.json"], { execute, commitSha: COMMIT, io: { stdout, stderr } })).resolves.toBe(0);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "candidate", liveLaneName: "v4_lane", liveLaneFile: "/private/live.json" }));
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("/private/root");
  });
});
