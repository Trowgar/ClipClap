import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { runCritic } from "../analyze-v2/critic";
import { newUsage } from "../analyze-v2/llm";
import {
  buildOutcomeRecoveryPool,
  buildOutcomeRecoveryTelemetry,
  isOutcomeRecoveryEligible,
  mergeUsage,
} from "../analyze-v2/outcome-recovery";
import type { TranscriptionResult } from "@clipclap/shared";

const baseCfg = loadAnalyzeConfig({
  SCAN_WINDOW_SEC: "600",
  SCAN_OVERLAP_SEC: "10",
  CRITIC_MAX_CANDIDATES: "1",
  PER_WINDOW_MIN_CANDIDATES: "1",
});

function transcript(): TranscriptionResult {
  const segments = Array.from({ length: 40 }, (_, i) => {
    const start = i * 5;
    return {
      start,
      end: start + 4.5,
      text: `Sentence number ${i}.`,
      words: [
        { text: "Sentence", start, end: start + 1 },
        { text: "number", start: start + 1.1, end: start + 2.5 },
        { text: `${i}.`, start: start + 2.6, end: start + 4.5 },
      ],
    };
  });
  return { text: segments.map((segment) => segment.text).join(" "), segments, language: "en" };
}

const scanTwo = () => ({
  choices: [{
    message: { content: JSON.stringify({ candidates: [
      { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.9, type: "story", thread: null },
      { start_node: 20, end_node: 24, payoff_node: 23, interest: 0.8, type: "insight", thread: null },
    ] }) },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 100, completion_tokens: 30,
  },
});

function verdict(id: string, keep: boolean, score = 0.9) {
  return {
    id, keep, score, grounded: true, self_contained: true,
    start_node: id === "c0" ? 10 : 20,
    payoff_node: id === "c0" ? 13 : 23,
    end_node: id === "c0" ? 14 : 24,
    hook_start_node: id === "c0" ? 12 : 22,
    hook_end_node: id === "c0" ? 13 : 23,
    title: keep ? `Sentence number ${id === "c0" ? 13 : 23}.` : "",
    description: keep ? `Sentence number ${id === "c0" ? 13 : 23}.` : "",
    title_evidence_nodes: keep ? [id === "c0" ? 13 : 23] : [],
    description_evidence_nodes: keep ? [id === "c0" ? 13 : 23] : [],
    language: "en",
  };
}

const critic = (rows: unknown[]) => ({
  choices: [{ message: { content: JSON.stringify({ results: rows }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 200, completion_tokens: 80 },
});
const finalizer = () => ({
  choices: [{ message: { content: JSON.stringify({ clips: [] }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 10 },
});

function client(...responses: unknown[]) {
  let index = 0;
  const create = vi.fn(async () => {
    const response = responses[Math.min(index++, responses.length - 1)];
    if (response instanceof Error) throw response;
    return response;
  });
  return { client: { chat: { completions: { create } } } as any, create };
}

function recoveryCfg(mode: "shadow" | "on", extra: Record<string, unknown> = {}) {
  return {
    ...baseCfg,
    outcomeRecoveryMode: mode,
    finalizerEnabled: true,
    ...extra,
  } as typeof baseCfg;
}

describe("outcome recovery wiring", () => {
  it("off is byte-compatible and has no recovery key or call", async () => {
    const harness = client(scanTwo(), critic([verdict("c0", false)]));
    const { client: openai, create } = harness;
    const result = await analyzeHighlightsV2(transcript(), {
      client: openai, cfg: { ...recoveryCfg("on"), outcomeRecoveryMode: "off", finalizerEnabled: false },
      transcriptPartial: false,
    });
    expect(result.highlights).toEqual([]);
    expect(result.telemetry).not.toHaveProperty("outcomeRecovery");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("shadow preserves primary empty output while recording a hit", async () => {
    const harness = client(scanTwo(), critic([verdict("c0", false)]), critic([verdict("c1", true)]), finalizer());
    const { client: openai, create } = harness;
    const result = await analyzeHighlightsV2(transcript(), { client: openai, cfg: recoveryCfg("shadow"), transcriptPartial: false });
    expect(result.highlights).toEqual([]);
    expect(result.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ mode: "shadow", outcome: "shadow_hit" }));
    expect((result.telemetry.outcomeRecovery as any).ranges).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("on ships only the shared-lane survivor", async () => {
    const harness = client(scanTwo(), critic([verdict("c0", false)]), critic([verdict("c1", true)]), finalizer());
    const result = await analyzeHighlightsV2(transcript(), { client: harness.client, cfg: recoveryCfg("on"), transcriptPartial: false });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0].title).toBe("Sentence number 23.");
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ outcome: "shipped" }));
    expect((result.telemetry.outcomeRecovery as any).ranges).toHaveLength(1);
  });

  it("recovery keep:false is a closed rejection and never ships", async () => {
    const harness = client(scanTwo(), critic([verdict("c0", false)]), critic([verdict("c1", false)]));
    const result = await analyzeHighlightsV2(transcript(), { client: harness.client, cfg: recoveryCfg("on", { finalizerEnabled: false }), transcriptPartial: false });
    expect(result.highlights).toEqual([]);
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ outcome: "rejected", recoveryDispositions: { critic_rejected: 1 } }));
    expect(harness.create).toHaveBeenCalledTimes(3);
  });

  it("normal nonempty primary output does not call recovery", async () => {
    const harness = client(scanTwo(), critic([verdict("c0", true)]), finalizer());
    const { client: openai, create } = harness;
    const result = await analyzeHighlightsV2(transcript(), { client: openai, cfg: recoveryCfg("on"), transcriptPartial: false });
    expect(result.highlights).toHaveLength(1);
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ reason: "non_empty", outcome: "not_eligible" }));
    expect(create).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["omission", { results: [] }],
    ["refusal", { refusal: "not applicable" }],
    ["truncation", { truncated: true }],
    ["5xx", new Error("503 upstream")],
  ])("recovery %s makes one critic request and fails closed", async (_name, failure: any) => {
    const response = failure instanceof Error
      ? failure
      : failure.refusal
        ? { choices: [{ message: { refusal: failure.refusal }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }
        : failure.truncated
          ? { choices: [{ message: { content: null }, finish_reason: "length" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }
          : critic([]);
    const harness = client(scanTwo(), critic([verdict("c0", false)]), response);
    const { client: openai, create } = harness;
    const result = await analyzeHighlightsV2(transcript(), { client: openai, cfg: recoveryCfg("on", { finalizerEnabled: false }), transcriptPartial: false });
    expect(result.highlights).toEqual([]);
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ outcome: "failed", reason: "quality_error" }));
    // scanner + primary critic + exactly one recovery critic request
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("finalizer skip is a failed recovery in both modes", async () => {
    for (const mode of ["shadow", "on"] as const) {
      const harness = client(scanTwo(), critic([verdict("c0", false)]), critic([verdict("c1", true)]));
      const result = await analyzeHighlightsV2(transcript(), { client: harness.client, cfg: recoveryCfg(mode, { finalizerEnabled: false }), transcriptPartial: false });
      expect(result.highlights).toEqual([]);
      expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ outcome: "failed", recoveryDispositions: { finalizer_unjudged: 1 } }));
    }
  });

  it.each([
    ["refusal", { choices: [{ message: { refusal: "cannot judge" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }],
    ["truncation", { choices: [{ message: { content: null }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }],
    ["fallback exhaustion", new Error("503 finalizer")],
  ])("finalizer %s is never shipped by recovery", async (_name, finalizerFailure: any) => {
    const harness = client(scanTwo(), critic([verdict("c0", false)]), critic([verdict("c1", true)]), finalizerFailure);
    const result = await analyzeHighlightsV2(transcript(), {
      client: harness.client,
      cfg: recoveryCfg("on"),
      transcriptPartial: false,
      retryDelayMs: 0,
    });
    expect(result.highlights).toEqual([]);
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ outcome: "failed" }));
    expect((result.telemetry.outcomeRecovery as any).recoveryDispositions).toEqual({ finalizer_unjudged: 1 });
  });

  it.each([false, true])( "configured finalizer failure plus %s fallback response is ambiguous", async (malformedFallback) => {
    const cfg = recoveryCfg("on");
    const firstThree = [scanTwo(), critic([verdict("c0", false)]), critic([verdict("c1", true)])];
    let index = 0;
    const create = vi.fn(async (request: any) => {
      const prompt = String(request.messages?.[1]?.content ?? "");
      if (prompt.startsWith("CLIP ")) {
        if (request.model === cfg.finalizerModel) throw new Error("configured finalizer unavailable");
        return malformedFallback
          ? { choices: [{ message: { content: JSON.stringify({ clips: "invalid" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
          : finalizer();
      }
      return firstThree[index++];
    });
    const result = await analyzeHighlightsV2(transcript(), { client: { chat: { completions: { create } } } as any, cfg, transcriptPartial: false, retryDelayMs: 0 });
    expect(result.highlights).toEqual([]);
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ outcome: "failed", recoveryDispositions: { finalizer_unjudged: 1 } }));
  });

  it("a cap-12 recovery critic is one bounded request, never a split or retry", async () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`, startNode: 0, payoffNode: 1, endNode: 1,
      interest: 0.5, type: "story" as const, windowIndex: 0,
    }));
    const nodes = [
      { index: 0, start: 0, end: 1, text: "A sentence.", hasWords: true, trailingStrength: 1, leadingStrength: 1 },
      { index: 1, start: 1, end: 2, text: "Another sentence.", hasWords: true, trailingStrength: 1, leadingStrength: 1 },
    ];
    const rows = candidates.map((candidate) => ({ ...verdict(candidate.id, false), id: candidate.id, start_node: 0, payoff_node: 1, end_node: 1, hook_start_node: 0, hook_end_node: 1 }));
    const harness = client(critic(rows));
    const result = await runCritic(harness.client, newUsage(), nodes, candidates, "en", recoveryCfg("on"), { recovery: true });
    expect(result.verdicts).toHaveLength(12);
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect((harness.create as any).mock.calls[0][1]).toEqual({ maxRetries: 0 });
  });

  it("a cap-12 recovery critic error is one request and no fallback", async () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, startNode: 0, payoffNode: 1, endNode: 1, interest: 0.5, type: "story" as const, windowIndex: 0 }));
    const nodes = [
      { index: 0, start: 0, end: 1, text: "A sentence.", hasWords: true, trailingStrength: 1, leadingStrength: 1 },
      { index: 1, start: 1, end: 2, text: "Another sentence.", hasWords: true, trailingStrength: 1, leadingStrength: 1 },
    ];
    const harness = client(new Error("503"));
    await expect(runCritic(harness.client, newUsage(), nodes, candidates, "en", recoveryCfg("on"), { recovery: true })).rejects.toThrow(/recovery critic request failed/);
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("partial transcripts are ineligible; selected holes remain technical in every mode", async () => {
    const partialHarness = client(scanTwo(), critic([verdict("c0", false)]));
    const { client: partialClient, create } = partialHarness;
    const partial = await analyzeHighlightsV2(transcript(), { client: partialClient, cfg: recoveryCfg("on", { finalizerEnabled: false }), transcriptPartial: true });
    expect(partial.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ reason: "partial_transcript" }));
    expect(create).toHaveBeenCalledTimes(2);

    const withHole = { ...transcript(), missingRanges: [{ start: 50, end: 75, reason: "chunk_failed" }] };
    for (const mode of ["off", "shadow", "on"] as const) {
      const { client: holeClient, create: holeCreate } = client(scanTwo(), critic([verdict("c0", false)]));
      const holeCfg = mode === "off"
        ? { ...baseCfg, outcomeRecoveryMode: "off" as const, finalizerEnabled: false }
        : { ...recoveryCfg(mode), finalizerEnabled: false };
      await expect(analyzeHighlightsV2(withHole, { client: holeClient, cfg: holeCfg, transcriptPartial: false })).rejects.toThrow(/all 1 candidate/);
      expect(holeCreate).toHaveBeenCalledTimes(1);
    }
  });

  it("no-candidate telemetry keeps recovery usage at a fresh zero", async () => {
    const emptyScan = {
      choices: [{ message: { content: JSON.stringify({ candidates: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 4 },
    };
    const harness = client(emptyScan);
    const result = await analyzeHighlightsV2(transcript(), { client: harness.client, cfg: recoveryCfg("on"), transcriptPartial: false });
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ outcome: "no_candidate", addedUsage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} } }));
  });

  it("an empty unselected tail is closed without a recovery request", async () => {
    const oneScan = { ...scanTwo(), choices: [{ ...scanTwo().choices[0], message: { content: JSON.stringify({ candidates: [
      { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.9, type: "story", thread: null },
    ] }) } }] };
    const harness = client(oneScan, critic([verdict("c0", false)]));
    const result = await analyzeHighlightsV2(transcript(), { client: harness.client, cfg: recoveryCfg("on", { finalizerEnabled: false }), transcriptPartial: false });
    expect(result.telemetry.outcomeRecovery).toEqual(expect.objectContaining({ outcome: "no_candidate", reason: "no_unjudged_tail" }));
    expect(harness.create).toHaveBeenCalledTimes(2);
  });

  it("closed eligibility rejects tiny, degenerate, song, and music-short paths", () => {
    const base = { mode: "on" as const, primaryHighlights: [], noClipsReason: "NO_VIABLE_MOMENTS" as const, transcriptPartial: false, missingRangeDrops: 0, unselectedCount: 1 };
    for (const path of ["tiny", "degenerate", "song_gate", "music_short"]) {
      expect(isOutcomeRecoveryEligible({ ...base, path })).toEqual(expect.objectContaining({ eligible: false }));
    }
  });

  it("malformed recovery pool state is an invariant, not a failed outcome", () => {
    expect(() => buildOutcomeRecoveryPool({ candidates: [{ id: "c0" } as any], nodes: [], missingRanges: [], maxCandidates: 1 })).toThrow(/outcome_recovery_input_invariant/);
  });

  it("telemetry keeps every shared quality drop disposition count-only", () => {
    const dispositions = {
      critic_rejected: 1, evidence_rejected: 1, snap_rejected: 1,
      arc_rejected: 1, post_boundary_rejected: 1, standalone_rejected: 1,
      finalizer_rejected: 1,
    };
    const telemetry = buildOutcomeRecoveryTelemetry({
      mode: "shadow", eligible: true, reason: "unjudged_tail", tailSize: 7, poolSize: 7,
      excludedMissingRange: 0, judged: 7, counters: { selectedForFinalizer: 7, finalizerSurvivors: 0 },
      primaryDispositions: {}, recoveryDispositions: dispositions, addedUsage: newUsage(), elapsedMs: 0,
      outcome: "shadow_miss",
    });
    expect(telemetry.recoveryDispositions).toEqual(dispositions);
  });

  it("usage merge and telemetry are additive, bounded, and private", () => {
    const usage = { inputTokens: 1, outputTokens: 2, requests: 1, byModel: { a: { inputTokens: 1, outputTokens: 2, requests: 1 } } };
    const addition = { inputTokens: 3, outputTokens: 4, requests: 1, byModel: { a: { inputTokens: 3, outputTokens: 4, requests: 1 } } };
    mergeUsage(usage, addition);
    mergeUsage(usage, addition);
    expect(usage).toEqual({ inputTokens: 7, outputTokens: 10, requests: 3, byModel: { a: { inputTokens: 7, outputTokens: 10, requests: 3 } } });
    const telemetry = buildOutcomeRecoveryTelemetry({
      mode: "on", eligible: true, reason: "unjudged_tail", tailSize: 1, poolSize: 1,
      excludedMissingRange: 0, judged: 1, counters: { selectedForFinalizer: 1, finalizerSurvivors: 1 },
      primaryDispositions: { not_selected_for_critic: 1 }, recoveryDispositions: { shipped: 1 },
      addedUsage: usage, elapsedMs: 2, outcome: "shipped",
      ranges: [{ startMs: 0, endMs: 1000 }, { startMs: -1, endMs: 4 }],
    });
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toMatch(/title|description|transcript|user|source|candidate-id/i);
    expect(telemetry.ranges).toEqual([{ startMs: 0, endMs: 1000 }]);
  });
});
