import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, and why it is not song-gate.test.ts
//
// song-gate.test.ts covers the pure predicate: which transcripts fire and
// which do not, including the five real eval fixtures. This file proves the
// predicate is actually WIRED to a real job - the failure mode
// end-extension-wiring.test.ts's own doc comment names: a detector that is
// correct in isolation but never called, or called after the expensive work
// it exists to skip, passes every test next door while changing nothing in
// production.
//
// So this asserts, against `runAnalyzeStage` with `analyzeHighlightsV2`
// mocked out entirely:
//   - SONG_GATE=on + a song-shaped transcript: analyzeHighlightsV2 is NEVER
//     called (the whole point - a firing gate must cost zero scan/critic
//     calls), the job resolves DONE with noClipsReason NO_USABLE_SPEECH and
//     zero highlights (never FAILED - the billing invariant), and it is
//     routed to "finalize", not "render" - the same path every other
//     NO_USABLE_SPEECH outcome already takes.
//   - SONG_GATE=on + an ordinary transcript: analyzeHighlightsV2 IS called
//     normally, and its result reaches the job unchanged apart from the
//     `telemetry.songGate` note.
//   - SONG_GATE=off (default): analyzeHighlightsV2 is ALWAYS called, even on
//     a song-shaped transcript, and no `songGate` key appears in telemetry -
//     the dark-stage byte-identical requirement, checked directly rather
//     than assumed.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  getStageQueue: vi.fn(),
  queueAdd: vi.fn(),
  jobFind: vi.fn(),
  jobUpdate: vi.fn(),
  analyzeHighlightsV2: vi.fn(),
}));

vi.mock("@clipclap/shared", () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  getStageQueue: mocks.getStageQueue,
  prisma: {
    job: { findUniqueOrThrow: mocks.jobFind, update: mocks.jobUpdate },
  },
}));

vi.mock("../analyze-v2", () => ({
  analyzeHighlightsV2: mocks.analyzeHighlightsV2,
}));

import { runAnalyzeStage } from "../stages/analyze";

/** All-verse: every segment is nothing but a music-note glyph, the pure-♫
 *  shape measured on job cmspy9brs00anuhfjecmby2u2 (spec 2026-08-10 task 8,
 *  `eval-song-gate.ts`). musicTokenShare = 100%, well over the 30% gate. */
function songTranscript() {
  const segments = Array.from({ length: 6 }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 1.5,
    text: "♫",
  }));
  return { text: segments.map((s) => s.text).join(" "), segments, language: "en" };
}

/** Ordinary, non-repeating speech - no music tokens, no repeated lines. Must
 *  NOT fire, and exists so "the gate never fires" cannot pass this suite by
 *  a mutation that hardcodes `fired: false` (that mutation is caught by the
 *  songTranscript() cases instead; this one guards the opposite direction is
 *  reachable at all). */
function speechTranscript() {
  const lines = [
    "Welcome back to the show today.",
    "We have a lot to cover this week.",
    "Let's start with the first story.",
    "That took an unexpected turn quickly.",
    "Thanks for listening, see you next time.",
  ];
  const segments = lines.map((text, i) => ({ start: i * 3, end: i * 3 + 2.5, text }));
  return { text: lines.join(" "), segments, language: "en" };
}

describe("song gate wiring (stages/analyze.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
    vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
    vi.stubEnv("ANALYZE_V2_PCT", "0");
  });

  it("SONG_GATE=on fires on a song transcript WITHOUT ever calling analyzeHighlightsV2", async () => {
    vi.stubEnv("SONG_GATE", "on");
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: songTranscript(),
      transcriptPartial: false,
    });

    await runAnalyzeStage({ jobId: "job1", userId: "u1" });

    // the whole point: a firing gate must cost zero scan/critic calls
    expect(mocks.analyzeHighlightsV2).not.toHaveBeenCalled();

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        status: "ANALYZING",
        highlights: [],
        analyzeEngine: "RECALL_CRITIC",
        noClipsReason: "NO_USABLE_SPEECH",
      }),
    });

    const [, , payload] = mocks.completeJobStep.mock.calls[0];
    expect(payload.noClipsReason).toBe("NO_USABLE_SPEECH");
    expect(payload.telemetry.songGate).toEqual(
      expect.objectContaining({ fired: true })
    );
    expect(payload.telemetry.songGate.signals.musicTokenShare).toBeGreaterThan(0.3);

    // billing invariant: never FAILED
    expect(mocks.jobUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );

    // routed exactly like every other zero-clip outcome: finalize, not render
    expect(mocks.queueAdd).toHaveBeenCalledWith("finalize", {
      jobId: "job1",
      userId: "u1",
    });
    expect(mocks.queueAdd).not.toHaveBeenCalledWith(
      "render",
      expect.anything()
    );
  });

  it("SONG_GATE=on does not fire on an ordinary transcript - analyzeHighlightsV2 still runs, telemetry records the miss", async () => {
    vi.stubEnv("SONG_GATE", "on");
    mocks.jobFind.mockResolvedValue({
      id: "job2",
      transcriptJson: speechTranscript(),
      transcriptPartial: false,
    });
    mocks.analyzeHighlightsV2.mockResolvedValue({
      highlights: [{ start: 0, end: 5, title: "Clip" }],
      noClipsReason: undefined,
      telemetry: { path: "normal" },
      usage: { inputTokens: 10, outputTokens: 5, requests: 1, byModel: {} },
    });

    await runAnalyzeStage({ jobId: "job2", userId: "u1" });

    expect(mocks.analyzeHighlightsV2).toHaveBeenCalledTimes(1);

    const [, , payload] = mocks.completeJobStep.mock.calls[0];
    expect(payload.telemetry.path).toBe("normal");
    expect(payload.telemetry.songGate).toEqual(
      expect.objectContaining({ fired: false })
    );

    expect(mocks.queueAdd).toHaveBeenCalledWith("render", {
      jobId: "job2",
      userId: "u1",
      mode: "clips",
    });
  });

  it("SONG_GATE off (default): analyzeHighlightsV2 runs even on a song transcript, no songGate telemetry - dark-stage byte-identical", async () => {
    // no SONG_GATE stub at all - the documented default
    mocks.jobFind.mockResolvedValue({
      id: "job3",
      transcriptJson: songTranscript(),
      transcriptPartial: false,
    });
    mocks.analyzeHighlightsV2.mockResolvedValue({
      highlights: [],
      noClipsReason: "NO_VIABLE_MOMENTS",
      telemetry: { path: "degenerate" },
      usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} },
    });

    await runAnalyzeStage({ jobId: "job3", userId: "u1" });

    expect(mocks.analyzeHighlightsV2).toHaveBeenCalledTimes(1);

    const [, , payload] = mocks.completeJobStep.mock.calls[0];
    expect(payload.telemetry).toEqual({ path: "degenerate" });
    expect(payload.telemetry.songGate).toBeUndefined();
    // the engine's own (unrelated) reason survives untouched
    expect(payload.noClipsReason).toBe("NO_VIABLE_MOMENTS");
  });

  it("a stray truthy SONG_GATE value ('true', '1') does not arm the gate - exact-literal 'on' only", async () => {
    vi.stubEnv("SONG_GATE", "true");
    mocks.jobFind.mockResolvedValue({
      id: "job4",
      transcriptJson: songTranscript(),
      transcriptPartial: false,
    });
    mocks.analyzeHighlightsV2.mockResolvedValue({
      highlights: [],
      noClipsReason: "NO_VIABLE_MOMENTS",
      telemetry: {},
      usage: { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} },
    });

    await runAnalyzeStage({ jobId: "job4", userId: "u1" });

    expect(mocks.analyzeHighlightsV2).toHaveBeenCalledTimes(1);
  });
});
