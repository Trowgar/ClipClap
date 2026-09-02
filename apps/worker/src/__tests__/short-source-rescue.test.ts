import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { AnalyzeTechnicalError } from "../analyze-v2/critic";
import { SOURCE_FLOOR } from "@clipclap/shared";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

/** Regression coverage for the retired SHORT_SOURCE_RESCUE delivery path. A
 * judged rejection is an honest empty result regardless of the old flag. */

const rescueCfg = loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "on" });

function transcript(): TranscriptionResult {
  const segments: WhisperSegment[] = Array.from({ length: 40 }, (_, i) => {
    const base = i * 5;
    return {
      start: base,
      end: base + 4.5,
      text: `Это предложение номер ${i}.`,
      words: [
        { text: "Это", start: base, end: base + 1 },
        { text: "предложение", start: base + 1.1, end: base + 2.5 },
        { text: "номер", start: base + 2.6, end: base + 3.4 },
        { text: `${i}.`, start: base + 3.5, end: base + 4.5 },
      ],
    };
  });
  return { text: segments.map((s) => s.text).join(" "), segments, language: "ru" };
}

const scanResponse = () => ({
  choices: [{
    message: {
      content: JSON.stringify({
        candidates: [
          { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
        ],
      }),
    },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 100, completion_tokens: 30 },
});

/** The critic REALLY judged the candidate and rejected it. */
const rejectedCriticResponse = (overrides: Record<string, unknown> = {}) => ({
  choices: [{
    message: {
      content: JSON.stringify({
        results: [{
          id: "c0", keep: false, score: 0.3, grounded: true, self_contained: true,
          start_node: 10, payoff_node: 13, end_node: 14,
          hook_start_node: 12, hook_end_node: 13,
          title: "Он назвал номер", description: "Спикер называет номер предложения.",
          title_evidence_nodes: [13], description_evidence_nodes: [13],
          language: "ru",
          ...overrides,
        }],
      }),
    },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 200, completion_tokens: 80 },
});

function client(...responses: any[]) {
  let n = 0;
  return {
    chat: { completions: { create: vi.fn(async () => responses[Math.min(n++, responses.length - 1)]) } },
  } as any;
}

describe("short-source rescue config", () => {
  it("arms only on the exact literal, like every stage switch", () => {
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "on" }).shortSourceRescueEnabled).toBe(true);
    expect(loadAnalyzeConfig({}).shortSourceRescueEnabled).toBe(false);
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "true" }).shortSourceRescueEnabled).toBe(false);
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "1" }).shortSourceRescueEnabled).toBe(false);
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "ON" }).shortSourceRescueEnabled).toBe(false);
  });

  it("defaults the threshold to the bot's own short-notice constant", () => {
    expect(loadAnalyzeConfig({}).shortSourceRescueMaxSec).toBe(SOURCE_FLOOR.shortNoticeSec);
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE_MAX_SEC: "120" }).shortSourceRescueMaxSec).toBe(120);
  });
});

describe("short-source rescue retirement", () => {
  it("keeps a judged keep:false result terminal with the old flag enabled", async () => {
    const c = client(scanResponse(), rejectedCriticResponse());
    const r = await analyzeHighlightsV2(transcript(), {
      client: c,
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: 200,
    });

    expect(r.highlights).toEqual([]);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry).not.toHaveProperty("rescue");
    // Directly pin the terminal invariant: keep:false cannot reach a clip.
    expect(r.highlights).not.toContainEqual(expect.objectContaining({ lowQuality: true }));
    expect(c.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("keeps the normal lane available for a critic keep:true result", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse({ keep: true, score: 0.9 })),
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: 200,
    });

    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(false);
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  it("still fails for an unjudged candidate before any empty return", async () => {
    const scanTwo = {
      choices: [{
        message: {
          content: JSON.stringify({ candidates: [
            { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
            { start_node: 25, end_node: 29, payoff_node: 28, interest: 0.7, type: "story", thread: null },
          ] }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    };

    await expect(analyzeHighlightsV2(transcript(), {
      client: client(scanTwo, rejectedCriticResponse()),
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: 200,
      retryDelayMs: 0,
    })).rejects.toThrow(AnalyzeTechnicalError);
  });
});
