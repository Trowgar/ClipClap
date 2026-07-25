import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { AnalyzeTechnicalError } from "../analyze-v2/critic";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

const cfg = loadAnalyzeConfig({});

/** The 40-node transcript below is one window at default settings; shrinking the
 *  window splits it into 4, so "every window died" and "one window died" are
 *  distinguishable outcomes. */
const multiWindowCfg = loadAnalyzeConfig({ SCAN_WINDOW_SEC: "60", SCAN_OVERLAP_SEC: "10" });

/** 40 sentences x ~5s with word timings - enough for one window. */
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

const criticResponse = (score: number) => ({
  choices: [{
    message: {
      content: JSON.stringify({
        results: [{
          id: "c0", keep: true, score, grounded: true, self_contained: true,
          start_node: 10, payoff_node: 13, end_node: 14,
          hook_start_node: 12, hook_end_node: 13,
          title: "Он назвал номер", description: "Спикер называет номер предложения.",
          title_evidence_nodes: [13], description_evidence_nodes: [13],
          language: "ru",
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

describe("analyzeHighlightsV2", () => {
  it("produces a scored, described highlight from scan + critic", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.85)),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(1);
    const h = r.highlights[0];
    expect(h.title).toBe("Он назвал номер");
    expect(h.description).toBe("Спикер называет номер предложения.");
    expect(h.score).toBe(0.85);
    expect(h.language).toBe("ru");
    expect(h.start).toBeLessThan(h.hookStart!);
    expect(h.end).toBeGreaterThanOrEqual(h.payoffAt!);
    expect(h._startNode).toBe(10);
    expect(r.noClipsReason).toBeUndefined();
    expect(r.usage.requests).toBeGreaterThanOrEqual(2);
    expect(r.telemetry.tier).toBe("strong");
  });

  it("degenerate input returns NO_USABLE_SPEECH without any LLM call", async () => {
    const c = client();
    const r = await analyzeHighlightsV2(
      { text: "hi", segments: [{ start: 0, end: 1, text: "hi", words: [{ text: "hi", start: 0, end: 0.5 }] }] },
      { client: c, cfg, transcriptPartial: false }
    );
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_USABLE_SPEECH");
    expect(c.chat.completions.create).not.toHaveBeenCalled();
  });

  it("weak video ships top candidates flagged lowQuality", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.45)),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(true);
    expect(r.telemetry.tier).toBe("weak");
  });

  it("0 viable moments on a partial transcript reports PARTIAL_TRANSCRIPT", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticResponse(0.1)),
      cfg,
      transcriptPartial: true,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("PARTIAL_TRANSCRIPT");
  });

  it("filters candidates crossing missing transcript ranges", async () => {
    const t = transcript();
    t.missingRanges = [{ start: 60, end: 70, reason: "chunk_failed" }]; // nodes 12-13 territory
    const r = await analyzeHighlightsV2(t, {
      client: client(scanResponse(), criticResponse(0.9)),
      cfg,
      transcriptPartial: true,
    });
    // the scanned candidate spans nodes 10-14 (50s-74.5s) which crosses 60-70 -> filtered pre-critic
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("PARTIAL_TRANSCRIPT");
  });

  it("repairs wrong-script copy via repairCopy then snippet fallback", async () => {
    const badCopy = {
      ...JSON.parse(criticResponse(0.9).choices[0].message.content),
    };
    badCopy.results[0].title = "English title on russian clip";
    badCopy.results[0].description = "English description entirely.";
    const criticBad = {
      choices: [{ message: { content: JSON.stringify(badCopy) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };
    // repair call also returns wrong-script copy -> snippet fallback kicks in
    const repairBad = {
      choices: [{ message: { content: JSON.stringify({ title: "Still english", description: "Still english too." }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticBad, repairBad),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(1);
    // snippet fallback = verbatim clip text (cyrillic by construction)
    expect(r.highlights[0].title).toMatch(/предложение/);
    expect(r.telemetry.snippetFallbacks).toBe(1);
  });

  it("widens the range to contain evidence cited just outside the boundary", async () => {
    const verdict = JSON.parse(criticResponse(0.9).choices[0].message.content);
    verdict.results[0].title_evidence_nodes = [8]; // 2 nodes before start_node 10
    const criticWiden = {
      choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticWiden),
      cfg,
      transcriptPartial: false,
    });
    expect(r.telemetry.evidenceWidened).toBe(1);
    expect(r.highlights).toHaveLength(1);
    // the widened start pulled the clip back to node 8's onset (minus lead-in)
    expect(r.highlights[0].start).toBeLessThan(40.2);
    expect(r.highlights[0]._startNode).toBe(8);
  });

  it("drops far-outside evidence with a named gate reason", async () => {
    const verdict = JSON.parse(criticResponse(0.9).choices[0].message.content);
    verdict.results[0].title_evidence_nodes = [4]; // 6 nodes before start_node 10
    const criticBadEvidence = {
      choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), criticBadEvidence),
      cfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.telemetry.evidenceWidened).toBe(0);
    expect(r.telemetry.gateDropReasons).toEqual({ title_evidence_out_of_range: 1 });
    expect(r.telemetry.droppedVerdicts).toEqual([
      { id: "c0", stage: "gate", reason: "title_evidence_out_of_range", score: 0.9 },
    ]);
  });

  it("throws AnalyzeTechnicalError when EVERY scanner window fails", async () => {
    // total OpenAI outage: no window ever answers
    const dead = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw Object.assign(new Error("upstream unavailable"), { status: 503 });
          }),
        },
      },
    } as any;

    const run = analyzeHighlightsV2(transcript(), {
      client: dead,
      cfg: multiWindowCfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    await expect(run).rejects.toThrow(AnalyzeTechnicalError);
    // the message must name the counts so the failed job is diagnosable
    await expect(run).rejects.toThrow(/4\/4 windows/);
  });

  it("does NOT throw when only SOME scanner windows fail", async () => {
    // window 0 is dead, windows 1-3 answer normally -> recall loss, not a failure
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            if (body.model === multiWindowCfg.scanModel) {
              if (user.includes("#0 Это")) {
                throw Object.assign(new Error("upstream unavailable"), { status: 503 });
              }
              return scanResponse();
            }
            return criticResponse(0.85);
          }),
        },
      },
    } as any;

    const r = await analyzeHighlightsV2(transcript(), {
      client,
      cfg: multiWindowCfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r).toBeTruthy();
    expect(r.telemetry.windowsTotal).toBe(4);
    expect(r.telemetry.windowsFailed).toBe(1);
  });

  it("healthy windows returning zero candidates stays a content outcome", async () => {
    const emptyScan = {
      choices: [{ message: { content: JSON.stringify({ candidates: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(emptyScan),
      cfg: multiWindowCfg,
      transcriptPartial: false,
      retryDelayMs: 1,
    });

    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry.windowsFailed).toBe(0);
    expect(r.telemetry.windowsTotal).toBe(4);
  });
});
