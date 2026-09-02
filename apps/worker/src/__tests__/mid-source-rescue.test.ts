import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

/** Regression coverage for the retired MID_SOURCE rescue delivery path. A
 * judged rejection remains an honest empty result in the widened window. */

const bothCfg = loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "on", RESCUE_MID_SOURCE: "on" });

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

describe("mid-source rescue config retirement", () => {
  it("ignores dead rescue env knobs and leaves V4 recovery dark", () => {
    const cfg = loadAnalyzeConfig({
      SHORT_SOURCE_RESCUE: "on",
      RESCUE_MID_SOURCE: "on",
      RESCUE_MID_MAX_SOURCE_SEC: "900",
    });
    expect(cfg.outcomeRecoveryMode).toBe("off");
    expect(cfg.outcomeRecoveryMaxCandidates).toBe(6);
  });
});

describe("mid-source rescue retirement", () => {
  it("keeps a judged keep:false result terminal with both old flags enabled", async () => {
    const c = client(scanResponse(), rejectedCriticResponse());
    const r = await analyzeHighlightsV2(transcript(), {
      client: c,
      cfg: bothCfg,
      transcriptPartial: false,
      sourceDurationSec: 795,
    });

    expect(r.highlights).toEqual([]);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry).not.toHaveProperty("rescue");
    // Directly pin the terminal invariant: keep:false cannot reach a clip.
    expect(r.highlights).not.toContainEqual(expect.objectContaining({ lowQuality: true }));
    expect(c.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("keeps the normal lane available in the mid-source window", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse({ keep: true, score: 0.9 })),
      cfg: bothCfg,
      transcriptPartial: false,
      sourceDurationSec: 795,
    });

    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(false);
    expect(r.telemetry).not.toHaveProperty("rescue");
  });
});
