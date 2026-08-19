import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { AnalyzeTechnicalError } from "../analyze-v2/critic";
import { SOURCE_FLOOR } from "@clipclap/shared";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

/** Wiring for the SHORT-SOURCE RESCUE (spec 2026-08-19-short-source-rescue):
 *  the same fake-client harness analyze-v2.test.ts uses, pointed at the one
 *  path that file does not cover - a fully-judged empty result on a short
 *  source. */

const cfg = loadAnalyzeConfig({});
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

describe("short-source rescue config", () => {
  it("arms only on the exact literal, like every stage switch", () => {
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "on" }).shortSourceRescueEnabled).toBe(true);
    expect(loadAnalyzeConfig({}).shortSourceRescueEnabled).toBe(false);
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "true" }).shortSourceRescueEnabled).toBe(false);
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "1" }).shortSourceRescueEnabled).toBe(false);
    expect(loadAnalyzeConfig({ SHORT_SOURCE_RESCUE: "ON" }).shortSourceRescueEnabled).toBe(false);
  });

  it("defaults the threshold to the bot's own short-notice constant", () => {
    // The default is a LITERAL in config.ts (that file deliberately imports
    // nothing so it survives every mocked-shared test) - this assertion is
    // what pins it to SOURCE_FLOOR.shortNoticeSec, the same 5 minutes the
    // bot's heads-up copy fires under. If this fails, the two definitions
    // of "short" have drifted apart: fix the literal, not this test.
    expect(loadAnalyzeConfig({}).shortSourceRescueMaxSec).toBe(SOURCE_FLOOR.shortNoticeSec);
    expect(
      loadAnalyzeConfig({ SHORT_SOURCE_RESCUE_MAX_SEC: "120" }).shortSourceRescueMaxSec
    ).toBe(120);
  });
});

describe("short-source rescue wiring", () => {
  it("ships one lowQuality clip when a short source was judged and fully rejected", async () => {
    const c = client(scanResponse(), rejectedCriticResponse());
    const r = await analyzeHighlightsV2(transcript(), {
      client: c,
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(true);
    expect(r.noClipsReason).toBeUndefined();
    expect(r.telemetry.tier).toBe("none"); // truthful: selection found nothing
    expect(r.telemetry.kept).toBe(1);
    expect(r.telemetry.rescue).toMatchObject({
      shipped: true,
      keptByCritic: false,
      verdictId: "c0",
    });
    // The rescue is deterministic and free: scan + critic and NOTHING else.
    expect(c.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("does nothing with the flag off - byte-identical honest empty", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg, // flag off
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  it("stays dark when no sourceDurationSec is passed - the eval-script contract", async () => {
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: rescueCfg,
      transcriptPartial: false,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  it("is STRICTLY under the threshold, matching the bot's isShortSource exactly", async () => {
    // isShortSource (shared plans.ts) is `durationSec < shortNoticeSec` - a
    // 300s source gets no bot notice, so it must get no rescue either. The
    // populations the two describe have to be the same one.
    const at = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: rescueCfg.shortSourceRescueMaxSec,
    });
    expect(at.highlights).toHaveLength(0);
    expect(at.telemetry).not.toHaveProperty("rescue");

    const under = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: rescueCfg.shortSourceRescueMaxSec - 1,
    });
    expect(under.highlights).toHaveLength(1);
    expect(under.telemetry.rescue).toMatchObject({ shipped: true });
  });

  it("stays dark for a zero or missing duration - never 'zero means short'", async () => {
    const zero = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), rejectedCriticResponse()),
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: 0,
    });
    expect(zero.highlights).toHaveLength(0);
    expect(zero.telemetry).not.toHaveProperty("rescue");
  });

  it("never runs when the normal pipeline shipped clips", async () => {
    const keptCritic = rejectedCriticResponse({ keep: true, score: 0.9 });
    const r = await analyzeHighlightsV2(transcript(), {
      client: client(scanResponse(), keptCritic),
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(false);
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  it("keeps PARTIAL_TRANSCRIPT honesty when the rescue cannot realize any verdict", async () => {
    // A verdict the critic really produced (valid node indices - its own
    // invariant filter would eat anything else) that snapNodes cannot
    // realize: a ~110s range with the hook pinned at the start, so the
    // compression walk has nowhere to move and drops it as too_long. The
    // rescue must fail OPEN into the existing honest empty, with its attempt
    // on record.
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
      cfg: rescueCfg,
      transcriptPartial: true,
      sourceDurationSec: 200,
    });
    expect(r.highlights).toHaveLength(0);
    expect(r.noClipsReason).toBe("PARTIAL_TRANSCRIPT");
    expect(r.telemetry.rescue).toEqual({ attempted: 1, snapFailures: 1, compressFailures: 0, shipped: false });
  });

  it("replaces script-mismatched copy with the verbatim snippet, still without an LLM call", async () => {
    const latinCopy = rejectedCriticResponse({ title: "A latin title", description: "A latin description." });
    const c = client(scanResponse(), latinCopy);
    const r = await analyzeHighlightsV2(transcript(), {
      client: c,
      cfg: rescueCfg,
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].title).toMatch(/предложение/);
    expect(r.telemetry.rescue).toMatchObject({ shipped: true, copySource: "snippet" });
    expect(c.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("prod-shaped config: a selected, AUDITED, then downranked-out clip is rescued WITHOUT its stale arc flags", async () => {
    // The live .env runs ARC_AUDIT=on + ARC_DOWNRANK=on + LONG_CLIPS=on, and
    // that combination is the one path where the rescue's input verdict has
    // been through stages the rescue clip itself never ran: keep:true at 0.65
    // clears selection (threshold 0.6), the audit flags TWO standing axes,
    // the downrank's 0.15 penalty pushes it under threshold and drops it -
    // empty exit, rescue re-snaps the SAME id. Its flags in arcFlags describe
    // the audited geometry, not the rescue's, so the shipped highlight must
    // carry NO _arcFlags key at all.
    const prodCfg = loadAnalyzeConfig({
      SHORT_SOURCE_RESCUE: "on",
      ARC_AUDIT: "on",
      ARC_DOWNRANK: "on",
      LONG_CLIPS: "on",
    });
    const keptButWeak = rejectedCriticResponse({ keep: true, score: 0.65 });
    const auditTwoStanding = {
      choices: [{
        message: {
          content: JSON.stringify({
            results: [{
              id: "c0",
              entry: { ok: false, defect: "mid_story", fix_start_node: null },
              exit: { ok: false, defect: "setup_no_payoff", fix_end_node: null },
              standalone: { ok: true, missing: null },
            }],
          }),
          refusal: null,
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 150, completion_tokens: 40 },
    };
    const c = client(scanResponse(), keptButWeak, auditTwoStanding);
    const r = await analyzeHighlightsV2(transcript(), {
      client: c,
      cfg: prodCfg,
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    expect(r.telemetry.arcDownrank).toMatchObject({ dropped: 1 });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].lowQuality).toBe(true);
    expect(r.highlights[0]).not.toHaveProperty("_arcFlags");
    expect(r.telemetry.rescue).toMatchObject({ shipped: true, verdictId: "c0", keptByCritic: true });
    // scan + critic + audit - the rescue itself still spends nothing, and the
    // finalizer skipped on the empty survivor set.
    expect(c.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("never masks a technical failure - unjudged candidates still throw with the flag on", async () => {
    // Two far-apart candidates; the critic answers for only one. The unjudged
    // guard must keep throwing AnalyzeTechnicalError so BullMQ retries -
    // rescue sits strictly after it.
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
        cfg: rescueCfg,
        transcriptPartial: false,
        sourceDurationSec: 200,
        retryDelayMs: 0,
      })
    ).rejects.toThrow(AnalyzeTechnicalError);
  });
});
