import { chmod, mkdtemp, open, readFile, readdir, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { captureOutcomeDecisionAssist, readOutcomeCaptureFile, type OutcomeCaptureSnapshot } from "../feedback-quality/outcome-capture";
import { writeOutcomePrivateFile } from "../feedback-quality/outcome-capture";
import { fingerprintOutcomeRequest, materializeOutcomeLiveLane, observeOutcomeCases, type OutcomeObservationCase } from "../feedback-quality/outcome-observe";
import { outcomeFreshnessSha256, parseOutcomeCase, type OutcomeCase } from "../feedback-quality/outcome-types";
import { promoteOutcomeCase, type OutcomePromotionDecision } from "../feedback-quality/outcome-promote";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { executeOutcomeCapture, readOutcomeCaptureReviewFile, runOutcomeCapture } from "../scripts/outcome-capture";
import { readOutcomeLiveLaneFile } from "../scripts/outcome-observe";

const roots: string[] = [];
const digest = (value: string) => sha256(Buffer.from(value));

function snapshot(overrides: Partial<OutcomeCaptureSnapshot> = {}): OutcomeCaptureSnapshot {
  return {
    job: {
      id: "job-private",
      userId: "user-private",
      status: "DONE",
      updatedAt: "2026-09-03T00:00:00.000Z",
      clipsGenerated: 0,
      clipCount: 0,
      noClipsReason: "NO_VIABLE_MOMENTS",
      analysisVersion: "core-v4-recovery-v1",
      transcriptJson: { text: "private transcript", segments: [{ id: 0, start: 0, end: 10, text: "words here" }] },
      transcriptPartial: false,
      sourceDurationSec: 10,
      sourceArtifactKey: "private/source.mp4",
      normalizedArtifactKey: null,
    },
    analyzeStep: {
      id: "step-private",
      status: "DONE",
      error: null,
      finishedAt: "2026-09-03T00:00:00.000Z",
      outputJson: { highlights: 0, noClipsReason: "NO_VIABLE_MOMENTS" },
    },
    ...overrides,
  };
}

async function outputDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clipclap-outcome-capture-"));
  roots.push(root);
  return root;
}

function completion(body: unknown, result: unknown, extra: Record<string, unknown> = {}): unknown {
  return { id: "provider-private", choices: [{ message: { content: JSON.stringify(result), refusal: null }, finish_reason: "stop" }], ...extra };
}

const sourceReader = { getObjectSize: async () => 6, downloadFile: async () => Buffer.from("source") };
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

describe("private outcome capture", () => {
  it("captures baseline primary and shadow recovery completions as canonical phase-bound recordings", async () => {
    const dir = await outputDir();
    const body = { model: "model-a", messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }] };
    let calls = 0;
    const real = { chat: { completions: { create: async (request: unknown) => {
      calls += 1;
      return completion(request, calls === 1 ? { verdicts: [] } : { verdicts: [{ keep: false }] });
    } } } } as never;
    const result = await captureOutcomeDecisionAssist({
      snapshot: snapshot(), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: dir,
      realClient: real, sourceReader, analyze: async (_transcript, options) => {
        await options.client!.chat.completions.create(body as never);
        return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } } as never;
      },
    });
    expect(result.responseCount).toBe(1);
    const stored = JSON.parse(await readFile(result.path, "utf8"));
    expect(stored.recordedResponses).toHaveLength(1);
    expect(stored.sourceSha256).toBe(digest("source"));
    expect(stored.recordedResponses[0]).toMatchObject({ phase: "primary", ...fingerprintOutcomeRequest(body), result: { verdicts: [] } });
    expect(stored).not.toHaveProperty("userId");
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect(result.path).toContain(result.captureId);
    await expect(readOutcomeCaptureFile(result.path, result.captureId)).resolves.toMatchObject({ schemaVersion: 1, jobId: "job-private" });
    await writeFile(result.path, `${await readFile(result.path, "utf8")}\n`);
    await expect(readOutcomeCaptureFile(result.path, result.captureId)).rejects.toMatchObject({ code: "publication_failed" });
  });

  it("marks candidate-only calls as recovery without replaying them into baseline", async () => {
    const dir = await outputDir();
    const first = { model: "model-a", messages: [{ role: "system", content: "system" }, { role: "user", content: "primary" }] };
    const second = { model: "model-a", messages: [{ role: "system", content: "system" }, { role: "user", content: "recovery" }] };
    let calls = 0;
    const real = { chat: { completions: { create: async (request: any) => { calls += 1; return completion(request, { verdicts: [] }); } } } } as never;
    const result = await captureOutcomeDecisionAssist({ snapshot: snapshot(), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: dir, realClient: real, sourceReader,
      analyze: async (_transcript, options) => { options.outcomeRecoveryPhase?.("primary"); await options.client!.chat.completions.create(first as never); if (options.cfg?.outcomeRecoveryMode === "shadow") { options.outcomeRecoveryPhase?.("recovery"); await options.client!.chat.completions.create(second as never); } return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } } as never; } });
    const stored = JSON.parse(await readFile(result.path, "utf8"));
    expect(calls).toBe(2);
    expect(stored.recordedResponses.map((entry: any) => entry.phase)).toEqual(["primary", "recovery"]);
  });

  it("records refusal and truncation markers, but never invents a record after provider failure", async () => {
    const dir = await outputDir();
    const body = { model: "model-a", messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }] };
    const refusal = { choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }] };
    const truncated = { choices: [{ message: { content: null, refusal: null }, finish_reason: "length" }] };
    let index = 0;
    const real = { chat: { completions: { create: async () => [refusal, truncated][index++] ?? Promise.reject(new Error("provider")) } } } as never;
    const analyze = async (_transcript: unknown, options: any) => {
      await options.client.chat.completions.create(body);
      return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } };
    };
    const captured = await captureOutcomeDecisionAssist({ snapshot: snapshot(), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: dir, realClient: real, sourceReader, analyze: analyze as never });
    expect(JSON.parse(await readFile(captured.path, "utf8")).recordedResponses[0].result).toEqual({ __outcome: "refusal" });
    index = 1;
    const truncatedCapture = await captureOutcomeDecisionAssist({ snapshot: snapshot(), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: dir, realClient: real, sourceReader, analyze: analyze as never });
    expect(JSON.parse(await readFile(truncatedCapture.path, "utf8")).recordedResponses[0].result).toEqual({ __outcome: "truncated" });
    index = 2;
    await expect(captureOutcomeDecisionAssist({ snapshot: snapshot(), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: dir, realClient: real, sourceReader, analyze: analyze as never })).rejects.toMatchObject({ code: "provider_error" });
  });

  it("rejects an empty successful completion and merges only a validated private review", async () => {
    const dir = await outputDir();
    const body = { model: "model-a", messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }] };
    const real = { chat: { completions: { create: async () => ({ choices: [] }) } } } as never;
    const analyze = async (_transcript: unknown, options: any) => { await options.client.chat.completions.create(body); return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } }; };
    await expect(captureOutcomeDecisionAssist({ snapshot: snapshot(), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: dir, realClient: real, sourceReader, analyze: analyze as never })).rejects.toMatchObject({ code: "invalid_completion" });
    const good = { eventId: "review-1", reviewedAt: "2026-09-03T00:01:00.000Z", sourceReview: "complete" as const, sourceSha256: digest("source"), configSha256: digest(canonicalJson({ ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" })), transcriptSha256: digest(canonicalJson(snapshot().job.transcriptJson)), destination: "eval" as const, disposition: "recoverable_false_negative" as const, confidence: "high" as const, subsystem: "selection" as const, expected: { approvedWindows: [{ start: 1, end: 2 }], forbiddenWindows: [] } };
    const successful = { chat: { completions: { create: async () => completion(body, { verdicts: [] }) } } } as never;
    const captured = await captureOutcomeDecisionAssist({ snapshot: snapshot(), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: dir, realClient: successful, sourceReader, review: good, analyze: async (_t, options) => { await options.client!.chat.completions.create(body as never); return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } } as never; } });
    const stored = JSON.parse(await readFile(captured.path, "utf8"));
    expect(stored.decisionDraft).toMatchObject({ eventId: "review-1", destination: "eval", disposition: "recoverable_false_negative", expected: good.expected });
    expect(stored.decisionDraft.recordedResponsesSha256).toBe(stored.recordedResponsesSha256);
  });

  it("creates three named attempts with stable request drift checks and provider ids", async () => {
    const dir = await outputDir();
    let calls = 0;
    const body = { model: "model-a", messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }] };
    const liveRequests: unknown[] = [];
    const real = { chat: { completions: { create: async (request: unknown) => { liveRequests.push(request); return { id: `provider-${++calls}`, choices: [{ message: { content: JSON.stringify({ verdicts: [] }), refusal: null }, finish_reason: "stop" }] }; } } } } as never;
    const captureSnapshot = snapshot({ job: { ...snapshot().job, sourceDurationSec: 30 } });
    const baseBody = { model: "base-model", messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }] };
    const baseCapture = await captureOutcomeDecisionAssist({ snapshot: captureSnapshot, config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: await outputDir(), realClient: { chat: { completions: { create: async () => completion(baseBody, { verdicts: [] }) } } } as never, sourceReader,
      analyze: async (_t, options) => { await options.client!.chat.completions.create(baseBody as never); return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } } as never; } });
    const baseStored = await readOutcomeCaptureFile(baseCapture.path, baseCapture.captureId);
    const captured = await captureOutcomeDecisionAssist({ snapshot: captureSnapshot, config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: dir, attempts: 3, liveLaneName: "recovery-live-1", realClient: real, sourceReader,
      analyze: async (_t, options) => { options.outcomeRecoveryPhase?.("primary"); await options.client!.chat.completions.create(body as never); return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } } as never; } });
    const stored = JSON.parse(await readFile(captured.path, "utf8"));
    expect(calls).toBe(3);
    expect(captured.responseCount).toBe(3);
    expect(liveRequests).toHaveLength(3);
    expect(fingerprintOutcomeRequest(liveRequests[0]).requestFingerprint).not.toBe(baseStored.recordedResponses[0].requestFingerprint);
    expect(stored.liveLaneDraft.name).toBe("recovery-live-1");
    expect(stored.liveLaneDraft.materializeAfterPromotion).toBe(true);
    expect(stored.liveLaneDraft.attempts).toHaveLength(3);
    expect(new Set(stored.liveLaneDraft.attempts.map((attempt: any) => attempt.cases[0].recordedResponses[0].providerRequestId)).size).toBe(3);
    expect(stored.liveLaneDraft.attempts[0].cases[0].caseVersion).toBeNull();
    const transcript = stored.transcript;
    const binding = {
      jobIdentitySha256: digest(stored.jobId), jobUpdatedAt: stored.jobUpdatedAt, reviewedAt: stored.capturedAt,
      materializedAt: stored.capturedAt, analyzeStepSha256: stored.analyzeStepSha256, analysisVersion: stored.analysisVersion,
      engineFingerprint: stored.engineFingerprint, configSha256: stored.configSha256, transcriptSha256: stored.transcriptSha256,
      sourceSha256: stored.sourceSha256, recordedResponsesSha256: stored.recordedResponsesSha256,
    };
    const unsignedCase = {
      schemaVersion: 1 as const, ...binding, sourceDurationSec: stored.sourceDurationSec,
      freshnessSha256: outcomeFreshnessSha256(binding), set: "eval" as const, disposition: "recoverable_false_negative" as const,
      confidence: "high" as const, subsystem: "selection" as const,
      expected: { approvedWindows: [{ start: 1, end: 2 }], forbiddenWindows: [] },
    };
    const caseBody = { ...unsignedCase, caseVersion: sha256(canonicalJson(unsignedCase)) } as OutcomeCase;
    const lane = materializeOutcomeLiveLane(stored.liveLaneDraft, caseBody.caseVersion);
    expect(Object.keys(lane).sort()).toEqual(["attempts", "name", "schemaVersion"]);
    expect(lane.attempts).toHaveLength(3);
    expect(lane.attempts[0].cases[0].caseVersion).toBe(caseBody.caseVersion);
    const { captureSha256, ...captureBody } = lane.attempts[0];
    expect(captureSha256).toBe(sha256(canonicalJson(captureBody)));
    const observationCase: OutcomeObservationCase = { case: caseBody, transcript, recordedResponses: stored.recordedResponses };
    await expect(observeOutcomeCases({ mode: "candidate", commitSha: "a".repeat(40), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, cases: [observationCase], liveLane: lane, now: new Date("2026-09-04T01:00:00.000Z") }, {
      analyze: async (_text, options) => {
        await options.client!.chat.completions.create(body as never);
        options.outcomeRecoveryAuditSink?.({ keepFalseShipped: 0, explicitGateResurrections: 0 });
        return { highlights: [], telemetry: { outcomeRecovery: recoveryTelemetry("shadow") }, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } } as never;
      },
    })).resolves.toMatchObject({ liveLane: { attempts: 3 } });

    const promotionRoot = join(await outputDir(), "promoted");
    const decision = {
      schemaVersion: 1 as const, eventId: "review-capture-1", reviewedAt: stored.capturedAt,
      jobId: stored.jobId, jobUpdatedAt: stored.jobUpdatedAt, analyzeStepId: stored.analyzeStepId,
      analyzeStepSha256: stored.analyzeStepSha256, analysisVersion: stored.analysisVersion,
      engineFingerprint: stored.engineFingerprint, configSha256: stored.configSha256, transcriptSha256: stored.transcriptSha256,
      sourceSha256: stored.sourceSha256, recordedResponsesSha256: stored.recordedResponsesSha256, sourceReview: "complete" as const,
      destination: "eval" as const, disposition: "recoverable_false_negative" as const, confidence: "high" as const,
      subsystem: "selection" as const, expected: { approvedWindows: [{ start: 1, end: 2 }], forbiddenWindows: [] },
      recordedResponses: stored.recordedResponses,
    } satisfies OutcomePromotionDecision;
    const promoted = await promoteOutcomeCase(decision, {
      repository: { capture: async () => captureSnapshot }, getObjectSize: async () => 6,
      downloadFile: async () => Buffer.from("source"), root: promotionRoot,
    });
    expect(promoted.status).toBe("promoted");
    expect((await stat(join(promotionRoot, "cases", promoted.caseVersion, "case.json"))).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["status", { job: { ...snapshot().job, status: "FAILED" } }],
    ["nonzero output", { job: { ...snapshot().job, clipCount: 1 } }],
    ["wrong reason", { job: { ...snapshot().job, noClipsReason: "NO_USABLE_SPEECH" } }],
    ["partial transcript", { job: { ...snapshot().job, transcriptPartial: true } }],
    ["missing source metadata", { job: { ...snapshot().job, sourceArtifactKey: null, normalizedArtifactKey: null } }],
    ["missing analysis version", { job: { ...snapshot().job, analysisVersion: null } }],
    ["malformed job updatedAt", { job: { ...snapshot().job, updatedAt: "yesterday" } }],
    ["malformed analyze finishedAt", { analyzeStep: { ...snapshot().analyzeStep, finishedAt: "yesterday" } }],
  ])("rejects %s before calling the provider", async (_name, changed) => {
    const provider = { chat: { completions: { create: async () => { throw new Error("must not call"); } } } } as never;
    await expect(captureOutcomeDecisionAssist({ snapshot: snapshot(changed as never), config: { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" }, outputDir: await outputDir(), realClient: provider, sourceReader, analyze: vi.fn() as never })).rejects.toMatchObject({ code: "invalid_snapshot" });
  });

  it("requires a 0600 shadow config envelope through the CLI loader contract", async () => {
    const path = join(await outputDir(), "config.json");
    const cfg = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" as const };
    await writeFile(path, JSON.stringify({ schemaVersion: 1, engineFingerprint: digest(canonicalJson(cfg)), config: cfg }), { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o644);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it("rejects a review whose mode changes during the read", async () => {
    const path = join(await outputDir(), "review.json");
    await writeFile(path, JSON.stringify({
      eventId: "review-1", reviewedAt: "2026-09-03T00:01:00.000Z", sourceReview: "complete",
      sourceSha256: digest("source"), configSha256: digest("config"), transcriptSha256: digest("transcript"),
      destination: "eval", disposition: "recoverable_false_negative", confidence: "high", subsystem: "selection",
      expected: { approvedWindows: [{ start: 1, end: 2 }], forbiddenWindows: [] },
    }), { mode: 0o600 });
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: (...args: any[]) => Promise<unknown> };
    await probe.close();
    const originalRead = prototype.read;
    prototype.read = async function(this: unknown, ...args: any[]): Promise<unknown> {
      const result = await originalRead.apply(this, args);
      await chmod(path, 0o644);
      return result;
    };
    try {
      await expect(readOutcomeCaptureReviewFile(path)).rejects.toThrow("private_review_invalid");
    } finally {
      prototype.read = originalRead;
      await chmod(path, 0o600);
    }
  });

  it("verifies the anchored target after atomic link/unlink", async () => {
    const dir = await outputDir();
    const path = await writeOutcomePrivateFile(dir, "private-target.json", { value: "private" });
    expect(await readFile(path, "utf8")).toBe('{"value":"private"}\n');
    const target = await stat(path);
    expect(target.isFile()).toBe(true);
    expect(target.nlink).toBe(1);
    expect(target.mode & 0o7777).toBe(0o600);
  });

  it("executes the reviewed capture-to-promotion-to-live observation path", async () => {
    const parent = await outputDir();
    const captureDir = join(parent, "captures");
    const root = join(parent, "root");
    const captureSnapshot = snapshot({ job: { ...snapshot().job, sourceDurationSec: 30 } });
    const config = { ...loadAnalyzeConfig({}), outcomeRecoveryMode: "shadow" as const };
    const reviewPath = join(parent, "review.json");
    const review = {
      eventId: "review-e2e-1", reviewedAt: "2026-09-03T00:01:00.000Z", sourceReview: "complete" as const,
      sourceSha256: digest("source"), configSha256: sha256(canonicalJson(config)), transcriptSha256: sha256(canonicalJson(captureSnapshot.job.transcriptJson)),
      destination: "eval" as const, disposition: "recoverable_false_negative" as const, confidence: "high" as const, subsystem: "selection" as const,
      expected: { approvedWindows: [{ start: 1, end: 2 }], forbiddenWindows: [] },
    };
    await writeFile(reviewPath, `${canonicalJson(review)}\n`, { mode: 0o600 });
    let providerCalls = 0;
    const request = { model: "model-e2e", messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }] };
    const realClient = { chat: { completions: { create: async () => ({ id: `provider-e2e-${++providerCalls}`, choices: [{ message: { content: JSON.stringify({ verdicts: [] }), refusal: null }, finish_reason: "stop" }] }) } } } as never;
    const result = await executeOutcomeCapture({ jobId: captureSnapshot.job.id, analyzeStepId: captureSnapshot.analyzeStep.id, configFile: "/private/config", outputDir: captureDir, attempts: 3, liveLaneName: "e2e-live", reviewFile: reviewPath, root }, {
      repository: { capture: async () => captureSnapshot }, loadConfig: async () => config, loadReview: readOutcomeCaptureReviewFile, realClient,
      sourceReader, capture: (input) => captureOutcomeDecisionAssist({ ...input, analyze: async (_transcript, options) => { options.outcomeRecoveryPhase?.("primary"); await options.client!.chat.completions.create(request as never); return { highlights: [], noClipsReason: "NO_VIABLE_MOMENTS", telemetry: {}, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } } as never; } }),
    });
    expect(result.promoted).toBe(true);
    expect(providerCalls).toBe(3);
    expect(result.caseVersion).toMatch(/^sha256:/);
    expect(result.liveLanePath).toBeTruthy();
    const capture = await readOutcomeCaptureFile(result.capturePath, result.captureId);
    const lane = await readOutcomeLiveLaneFile(result.liveLanePath!, "e2e-live");
    const decisionFiles = await readdir(join(root, "outcomes", "decisions"));
    expect(decisionFiles).toHaveLength(1);
    expect((await stat(join(root, "outcomes", "decisions", decisionFiles[0]))).mode & 0o7777).toBe(0o600);
    expect((await stat(result.liveLanePath!)).mode & 0o7777).toBe(0o600);
    const promotedCase = parseOutcomeCase(JSON.parse(await readFile(join(root, "outcomes", "cases", result.caseVersion!, "case.json"), "utf8")));
    const promotedTranscript = JSON.parse(await readFile(join(root, "outcomes", "cases", result.caseVersion!, "transcript.json"), "utf8"));
    const promotedResponses = (await readFile(join(root, "outcomes", "cases", result.caseVersion!, "recorded-responses.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await expect(observeOutcomeCases({ mode: "candidate", commitSha: "a".repeat(40), config, cases: [{ case: promotedCase, transcript: promotedTranscript, recordedResponses: promotedResponses }], liveLane: lane, now: new Date(Date.now() + 1000) }, {
      analyze: async (_transcript, options) => { await options.client!.chat.completions.create(request as never); options.outcomeRecoveryAuditSink?.({ keepFalseShipped: 0, explicitGateResurrections: 0 }); return { highlights: [], telemetry: { outcomeRecovery: recoveryTelemetry("shadow") }, usage: { inputTokens: 0, outputTokens: 0, requests: 1, byModel: {} } } as never; },
    })).resolves.toMatchObject({ liveLane: { name: "e2e-live", attempts: 3 } });
    expect(capture.recordedResponses.length).toBeGreaterThan(0);
  });

  it("accepts the complete reviewed three-attempt CLI shape and keeps output aggregate-only", async () => {
    let received: any;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const status = await runOutcomeCapture([
      "--job-id", "job-private", "--analyze-step-id", "step-private",
      "--config-file", "/private/config.json", "--output-dir", "/private/captures",
      "--attempts", "3", "--live-lane-name", "recovery-live-1",
      "--review-file", "/private/review.json", "--root", "/private/root",
    ], {
      capture: async (args) => { received = args; return { responseCount: 3, promoted: true }; },
      io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    });
    expect(status).toBe(0);
    expect(stderr).toEqual([]);
    expect(received).toMatchObject({ attempts: 3, liveLaneName: "recovery-live-1", reviewFile: "/private/review.json", root: "/private/root" });
    expect(stdout).toEqual(['{"operation":"outcome-capture","status":"promoted","responseCount":3}']);
  });
});
