import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { AnalyzeTechnicalError } from "../analyze-v2/critic";
import { SOURCE_FLOOR } from "@clipclap/shared";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

/** Wiring for MID-SOURCE RESCUE (spec
 *  2026-08-25-mid-rescue-and-stream-resolver-v2, part 1): the same
 *  fake-client harness short-source-rescue.test.ts uses, pointed at the
 *  widened [shortSourceRescueMaxSec, rescueMidMaxSourceSec) window. The
 *  invariant under test throughout: rescue is reachable ONLY when the final
 *  kept set is EMPTY - the trigger case is "Ben trades" (tg 6987955255),
 *  795s, critic judged 11 candidates, kept c3 at 0.58, arc-downrank dropped
 *  it -> 0 clips. */

const cfg = loadAnalyzeConfig({});
const midCfg = loadAnalyzeConfig({ RESCUE_MID_SOURCE: "on" });
const shortCfg = loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "on" });
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

/** The critic REALLY judged the candidate and rejected it - the exact
 *  population the rescue exists for. */
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

describe("mid-source rescue config", () => {
  it("arms only on the exact literal, like every stage switch", () => {
    expect(loadAnalyzeConfig({ RESCUE_MID_SOURCE: "on" }).rescueMidSourceEnabled).toBe(true);
    expect(loadAnalyzeConfig({}).rescueMidSourceEnabled).toBe(false);
    expect(loadAnalyzeConfig({ RESCUE_MID_SOURCE: "true" }).rescueMidSourceEnabled).toBe(false);
    expect(loadAnalyzeConfig({ RESCUE_MID_SOURCE: "1" }).rescueMidSourceEnabled).toBe(false);
    expect(loadAnalyzeConfig({ RESCUE_MID_SOURCE: "ON" }).rescueMidSourceEnabled).toBe(false);
  });

  it("defaults the ceiling to 1200s (20 minutes), independent of the short ceiling", () => {
    expect(loadAnalyzeConfig({}).rescueMidMaxSourceSec).toBe(1200);
    expect(
      loadAnalyzeConfig({ RESCUE_MID_MAX_SOURCE_SEC: "900" }).rescueMidMaxSourceSec
    ).toBe(900);
  });
});

describe("mid-source rescue wiring", () => {
  it("keeps the mid rescue byte-equivalent while safe-end shadow observes its winner", async () => {
    const control = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: midCfg,
      transcriptPartial: false,
      sourceDurationSec: 795,
    });
    const observed = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: { ...midCfg, safeEndAuditMode: "shadow" },
      transcriptPartial: false,
      sourceDurationSec: 795,
    });

    expect(observed.highlights).toEqual(control.highlights);
    expect(observed.telemetry.rescue).toEqual(control.telemetry.rescue);
    expect(observed.telemetry.safeEndAudit).toMatchObject({
      rescue: { summary: "selected", realizable: 1, selected: 1, records: [expect.objectContaining({ selectedState: "selected" })] },
    });
    expect(observed.highlights[0]).not.toHaveProperty("_arcFlags");
  });

  // (b) kept=0 + 795s source + flag on -> exactly one lowQuality highlight.
  it("ships one lowQuality clip for the 795s trigger case when judged and fully rejected", async () => {
    const c = client(scanResponse(), rejectedCriticResponse());
    const r = await analyzeHighlightsV2(transcript(), {
      client: c,
      cfg: midCfg,
      transcriptPartial: false,
      sourceDurationSec: 795,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(true);
    expect(r.noClipsReason).toBeUndefined();
    expect(r.telemetry.kept).toBe(1);
    expect(r.telemetry.rescue).toMatchObject({
      shipped: true,
      keptByCritic: false,
      verdictId: "c0",
      tier: "mid",
    });
    // Deterministic and free, same as the short rescue: scan + critic only.
    expect(c.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  // (a) kept=1 + mid-length source + flag on -> no rescue, identical to today.
  it("never runs when the normal pipeline shipped a real clip on a mid-length source", async () => {
    const keptCritic = rejectedCriticResponse({ keep: true, score: 0.9 });
    const c = client(scanResponse(), keptCritic);
    const r = await analyzeHighlightsV2(transcript(), {
      client: c,
      cfg: midCfg,
      transcriptPartial: false,
      sourceDurationSec: 795,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(false);
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  // (c) kept=0 + 1500s source + flag on -> no rescue (ceiling).
  it("stays dark past the 1200s ceiling even fully rejected and flag on", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: midCfg,
      transcriptPartial: false,
      sourceDurationSec: 1500,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  it("is STRICTLY under its own ceiling, mirroring the short rescue's discipline", async () => {
    const at = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: midCfg,
      transcriptPartial: false,
      sourceDurationSec: midCfg.rescueMidMaxSourceSec,
    });
    expect(at.highlights).toHaveLength(0);
    expect(at.telemetry).not.toHaveProperty("rescue");

    const under = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: midCfg,
      transcriptPartial: false,
      sourceDurationSec: midCfg.rescueMidMaxSourceSec - 1,
    });
    expect(under.highlights).toHaveLength(1);
    expect(under.telemetry.rescue).toMatchObject({ shipped: true, tier: "mid" });
  });

  it("starts exactly at the short ceiling - 300s is mid-eligible, not short-eligible", async () => {
    // isShortSource (shared plans.ts) is strictly-under 300; the short rescue
    // already excludes 300 itself (short-source-rescue.test.ts's own "STRICTLY
    // under" test). The mid window picks up exactly where short leaves off, so
    // the two ceilings partition [0, 1200) with no gap and no overlap.
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: midCfg,
      transcriptPartial: false,
      sourceDurationSec: SOURCE_FLOOR.shortNoticeSec,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.telemetry.rescue).toMatchObject({ shipped: true, tier: "mid" });
  });

  // (d) flag off -> 300s+ behavior byte-identical; the SHORT_SOURCE_RESCUE
  // flag alone must not reach into the mid window, and vice versa.
  it("does nothing for a mid-length source with only SHORT_SOURCE_RESCUE on", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: shortCfg, // SHORT_SOURCE_RESCUE=on, RESCUE_MID_SOURCE unset (off)
      transcriptPartial: false,
      sourceDurationSec: 795,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  it("does nothing with both flags at default (off) - byte-identical honest empty", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg, // both flags off
      transcriptPartial: false,
      sourceDurationSec: 795,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  it("still rescues a short source when both flags are on, tagged tier short", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: bothCfg,
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.telemetry.rescue).toMatchObject({ shipped: true, tier: "short" });
  });

  it("records tier: mid on a FAILED rescue attempt too, distinguishable from a failed short one", async () => {
    // Mirrors short-source-rescue.test.ts's "keeps PARTIAL_TRANSCRIPT honesty"
    // case: a verdict the critic really produced that snapNodes cannot
    // realize (~110s range, hook pinned at the start, compression walk has
    // nowhere to move) - the rescue fails OPEN into the honest empty, but its
    // attempt is on record and must say WHICH tier attempted it.
    const scanLong = {
      choices: [{
        message: {
          content: JSON.stringify({
            candidates: [
              { start_node: 0, end_node: 22, payoff_node: 22, interest: 0.8, type: "story", thread: null },
            ],
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    };
    const unsnappable = rejectedCriticResponse({
      start_node: 0, payoff_node: 22, end_node: 22,
      hook_start_node: 1, hook_end_node: 2,
      title_evidence_nodes: [22], description_evidence_nodes: [22],
    });
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanLong, unsnappable),
      cfg: midCfg,
      transcriptPartial: true,
      sourceDurationSec: 795,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("PARTIAL_TRANSCRIPT");
    expect(r.telemetry.rescue).toEqual({
      attempted: 1, snapFailures: 1, compressFailures: 0, shipped: false, tier: "mid",
    });
  });

  it("stays dark for a zero or missing duration in mid mode too", async () => {
    const zero = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: midCfg,
      transcriptPartial: false,
      sourceDurationSec: 0,
    });
    expect(zero.highlights).toHaveLength(0);
    expect(zero.telemetry).not.toHaveProperty("rescue");

    const missing = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: midCfg,
      transcriptPartial: false,
    });
    expect(missing.highlights).toHaveLength(0);
    expect(missing.telemetry).not.toHaveProperty("rescue");
  });

  // (e) the unjudged guard still precedes rescue for mid sources.
  it("never masks a technical failure - unjudged candidates still throw with the mid flag on", async () => {
    const scanTwo = {
      choices: [{
        message: {
          content: JSON.stringify({
            candidates: [
              { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
              { start_node: 25, end_node: 29, payoff_node: 28, interest: 0.7, type: "story", thread: null },
            ],
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    };
    await expect(
      analyzeHighlightsV2(transcript(), {
        client: client(scanTwo, rejectedCriticResponse()),
        cfg: midCfg,
        transcriptPartial: false,
        sourceDurationSec: 795,
        retryDelayMs: 0,
      })
    ).rejects.toThrow(AnalyzeTechnicalError);
  });
});
