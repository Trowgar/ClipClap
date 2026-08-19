import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { resolveAnalysisMode } from "../analyze-v2/mode";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

const cfgOn = loadAnalyzeConfig({ ANALYZE_STREAM_MODE: "on" });
const cfgOff = loadAnalyzeConfig({});

describe("resolveAnalysisMode", () => {
  it("flag off -> always standard, even for a twitch URL that would otherwise match", () => {
    expect(
      resolveAnalysisMode(
        { sourceUrl: "https://www.twitch.tv/somechannel", durationSec: 100, speechSec: 50 },
        cfgOff
      )
    ).toBe("standard");
  });

  it("twitch.tv host -> stream, independent of duration/density", () => {
    // Short duration on purpose: proves the host rule fires BEFORE and
    // WITHOUT the density fallback ever being consulted (spec order 1-2-3).
    expect(
      resolveAnalysisMode(
        { sourceUrl: "https://www.twitch.tv/somechannel", durationSec: 100, speechSec: 90 },
        cfgOn
      )
    ).toBe("stream");
    // Bare apex domain too, not just the www subdomain.
    expect(
      resolveAnalysisMode(
        { sourceUrl: "https://twitch.tv/somechannel", durationSec: 100, speechSec: 90 },
        cfgOn
      )
    ).toBe("stream");
  });

  it("clips.twitch.tv host -> stream", () => {
    expect(
      resolveAnalysisMode(
        { sourceUrl: "https://clips.twitch.tv/SomeClipSlug", durationSec: 60, speechSec: 55 },
        cfgOn
      )
    ).toBe("stream");
  });

  it("youtube.com /live/ path -> stream", () => {
    expect(
      resolveAnalysisMode(
        { sourceUrl: "https://www.youtube.com/live/abc123XYZ", durationSec: 100, speechSec: 90 },
        cfgOn
      )
    ).toBe("stream");
  });

  it("plain youtube watch URL, long + sparse -> stream via the density fallback", () => {
    expect(
      resolveAnalysisMode(
        { sourceUrl: "https://www.youtube.com/watch?v=abc123XYZ", durationSec: 1300, speechSec: 300 },
        cfgOn
      )
    ).toBe("stream");
  });

  it("short sparse source (10 min) -> standard - the 1200s floor gates the density fallback", () => {
    expect(
      resolveAnalysisMode({ durationSec: 600, speechSec: 60 }, cfgOn)
    ).toBe("standard");
  });

  it("dense long source (density 0.8) -> standard", () => {
    expect(
      resolveAnalysisMode({ durationSec: 1300, speechSec: 1040 }, cfgOn)
    ).toBe("standard");
  });

  it("garbage sourceUrl does not throw and still reaches the density fallback", () => {
    expect(() =>
      resolveAnalysisMode(
        { sourceUrl: "not a valid url at all!!!", durationSec: 1300, speechSec: 300 },
        cfgOn
      )
    ).not.toThrow();
    expect(
      resolveAnalysisMode(
        { sourceUrl: "not a valid url at all!!!", durationSec: 1300, speechSec: 300 },
        cfgOn
      )
    ).toBe("stream");
  });

  it("density exactly at the threshold -> standard (strict <, not <=)", () => {
    // 1100 / 2000 === 0.55 exactly in IEEE754 (both are exact integers and
    // the quotient is exactly representable), the same double
    // cfg.streamDensityMax's default parses to - a genuine boundary case,
    // not a rounding accident.
    expect(1100 / 2000).toBe(cfgOn.streamDensityMax);
    expect(
      resolveAnalysisMode({ durationSec: 2000, speechSec: 1100 }, cfgOn)
    ).toBe("standard");
  });
});

describe("loadAnalyzeConfig - stream mode knobs", () => {
  it("defaults: flag off, documented knob values", () => {
    const cfg = loadAnalyzeConfig({});
    expect(cfg.streamModeEnabled).toBe(false);
    expect(cfg.streamDensityMax).toBe(0.55);
    expect(cfg.streamCriticMaxCandidates).toBe(80);
    expect(cfg.streamMinCandidateSec).toBe(12);
  });

  it("exact-literal flag - only the literal \"on\" enables it", () => {
    expect(loadAnalyzeConfig({ ANALYZE_STREAM_MODE: "on" }).streamModeEnabled).toBe(true);
    expect(loadAnalyzeConfig({ ANALYZE_STREAM_MODE: "true" }).streamModeEnabled).toBe(false);
    expect(loadAnalyzeConfig({ ANALYZE_STREAM_MODE: "1" }).streamModeEnabled).toBe(false);
    expect(loadAnalyzeConfig({ ANALYZE_STREAM_MODE: "ON" }).streamModeEnabled).toBe(false);
  });

  it("knob overrides", () => {
    const cfg = loadAnalyzeConfig({
      STREAM_DENSITY_MAX: "0.4",
      STREAM_CRITIC_MAX_CANDIDATES: "100",
      STREAM_MIN_CANDIDATE_SEC: "20",
    });
    expect(cfg.streamDensityMax).toBe(0.4);
    expect(cfg.streamCriticMaxCandidates).toBe(100);
    expect(cfg.streamMinCandidateSec).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Wiring: analyzeHighlightsV2 actually threads sourceUrl/speechSec through to
// resolveAnalysisMode and publishes the result under not-a-key discipline.
// Harness mirrors analyze-v2.test.ts's fake-client pattern.
// ---------------------------------------------------------------------------

/** `nodeCount` sentences x ~5s with word timings - the same shape
 *  analyze-v2.test.ts's own `transcript()` uses, parameterized so the dense-
 *  transcript wiring test can scale it past the 1200s density-fallback floor
 *  without changing the per-node structure the scanner/critic mocks below
 *  were written against. */
function transcript(nodeCount: number): TranscriptionResult {
  const segments: WhisperSegment[] = Array.from({ length: nodeCount }, (_, i) => {
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

describe("analyzeHighlightsV2 - stream mode wiring", () => {
  it("flag on + twitch sourceUrl -> telemetry.analysisMode is 'stream'", async () => {
    const r = await analyzeHighlightsV2(transcript(40), {
      client: client(scanResponse(), criticResponse(0.85)),
      cfg: cfgOn,
      transcriptPartial: false,
      sourceUrl: "https://www.twitch.tv/somechannel",
    });
    expect(r.telemetry.analysisMode).toBe("stream");
  });

  it("flag off -> no analysisMode key at all, even with a twitch sourceUrl", async () => {
    const r = await analyzeHighlightsV2(transcript(40), {
      client: client(scanResponse(), criticResponse(0.85)),
      cfg: cfgOff,
      transcriptPartial: false,
      sourceUrl: "https://www.twitch.tv/somechannel",
    });
    expect("analysisMode" in r.telemetry).toBe(false);
  });

  it("flag on + no sourceUrl + a dense long transcript -> telemetry.analysisMode is 'standard'", async () => {
    // 170 nodes x 4.5s speech = 765s of real speechSec against a supplied
    // sourceDurationSec of 1300s (> the 1200s floor): density 765/1300 ≈
    // 0.59, above cfg.streamDensityMax (0.55), so the density fallback must
    // NOT fire. SCAN_WINDOW_SEC widened so this stays one scan window (one
    // scan call), matching the two-response client below.
    const cfg = loadAnalyzeConfig({
      ANALYZE_STREAM_MODE: "on",
      SCAN_WINDOW_SEC: "10000",
      SCAN_OVERLAP_SEC: "10",
    });
    const r = await analyzeHighlightsV2(transcript(170), {
      client: client(scanResponse(), criticResponse(0.85)),
      cfg,
      transcriptPartial: false,
      sourceDurationSec: 1300,
    });
    expect(r.telemetry.analysisMode).toBe("standard");
  });
});
