import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, and why it is not music-hook.test.ts
//
// music-hook.ts's own suite (task M2) proves selectHookWindows is CORRECT in
// isolation - a pure function, no I/O. This file proves it is actually WIRED
// into stages/analyze.ts's song-gate branch (spec 2026-08-23-music-shorts,
// task M3), mirroring song-gate-wiring.test.ts's own harness and its stated
// reason for existing: a detector that is right in isolation but never
// called, or called after the refusal it should have replaced, passes every
// test next door while changing nothing in production.
//
// So this asserts, against `runAnalyzeStage` with `analyzeHighlightsV2`
// mocked out entirely and `detectSong`/`selectHookWindows` running for
// real (same discipline song-gate-wiring.test.ts uses for detectSong):
//   - MUSIC_SHORTS off (default): a firing song gate refuses exactly like it
//     did before this task existed - byte-identical to a run where the flag
//     is on but the source does not qualify - and neither carries a
//     `telemetry.musicShorts` key.
//   - MUSIC_SHORTS=on + song gate fired + a qualifying single-track source +
//     a real energy envelope on the TRANSCRIBE step row: analyzeHighlightsV2
//     is NEVER called (zero LLM), two highlights ship shaped exactly the way
//     render.ts consumes a Highlight, the SAME job update carries
//     `subtitles: false`, and the job routes to "render" like any other
//     non-empty result.
//   - Source over musicShortsMaxSec (481s > default 480): refusal, even
//     though the gate fired and the flag is on.
//   - Source AT musicShortsMaxSec (480s, the boundary itself): still ships -
//     pins the `<=` (not `<`) comparison.
//   - No signal at all (no repetition, no envelope): selectHookWindows
//     returns [] and the branch falls through to the existing refusal
//     untouched.
//   - A malformed/missing TRANSCRIBE step row degrades to an empty
//     envelope, not a thrown error - and when the transcript carries real
//     lyric repetition, the branch still ships on repetition alone.
//   - A stray truthy MUSIC_SHORTS value ('true') does not arm the branch -
//     exact-literal 'on' only, the same discipline every other flag in
//     analyze-v2/config.ts uses.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  getStageQueue: vi.fn(),
  queueAdd: vi.fn(),
  jobFind: vi.fn(),
  jobUpdate: vi.fn(),
  jobStepFindUnique: vi.fn(),
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
    jobStep: { findUnique: mocks.jobStepFindUnique },
  },
}));

vi.mock("../analyze-v2", () => ({
  analyzeHighlightsV2: mocks.analyzeHighlightsV2,
}));

import { runAnalyzeStage } from "../stages/analyze";

/** All-verse: every segment is nothing but a music-note glyph - fires the
 *  song gate on musicTokenShare alone (song-gate.ts), and carries ZERO
 *  textual repetition evidence for selectHookWindows (normalizeLine strips
 *  the glyph to "", which never counts as a line). Mirrors
 *  song-gate-wiring.test.ts's own songTranscript() fixture, and mirrors the
 *  spec's own Baby Shark case: the class this fixture stands in for is
 *  carried by the ENERGY signal alone, never repetition. */
function pureMusicTranscript() {
  const segments = Array.from({ length: 6 }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 1.5,
    text: "♫",
  }));
  return { text: segments.map((s) => s.text).join(" "), segments, language: "en" };
}

/** Two distinct chorus lines, each repeated once >= 25s after its first
 *  occurrence (MIN_GAP_SEC in music-hook.ts and song-gate.ts alike), spaced
 *  among unique filler lines so lineRepRate clears song-gate's 0.20
 *  threshold (4 of 8 lines repeat = 0.5) while also handing
 *  selectHookWindows real repetition spans to score on with NO energy
 *  envelope at all. */
function repeatingLyricsTranscript() {
  const lines = [
    { start: 0, end: 3, text: "Hold on tonight forever" },
    { start: 10, end: 12, text: "Some filler line here" },
    { start: 40, end: 43, text: "Hold on tonight forever" },
    { start: 50, end: 52, text: "Another filler phrase now" },
    { start: 100, end: 103, text: "Rain drops falling down slow" },
    { start: 110, end: 112, text: "One more filler bit said" },
    { start: 140, end: 143, text: "Rain drops falling down slow" },
    { start: 150, end: 152, text: "Last filler line spoken" },
  ];
  return { text: lines.map((l) => l.text).join(" "), segments: lines, language: "en" };
}

/** A 200-second RMS envelope, quiet (-40) throughout except two 20s peaks
 *  (-5) at [30,50) and [150,170) - far enough apart (>= WINDOW_SEC/2, the
 *  music-hook.ts DISTINCT_REGION_MIN_OVERLAP_SEC) to rank as two separate
 *  top windows, and each aligned to the STEP_SEC=5 grid so it is scored by
 *  an exact-match window rather than a partial-overlap neighbour. */
function twoPeakEnvelope(): number[] {
  const env = new Array(200).fill(-40);
  for (let i = 30; i < 50; i++) env[i] = -5;
  for (let i = 150; i < 170; i++) env[i] = -5;
  return env;
}

function stubBaseEnv() {
  mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
  vi.stubEnv("ANALYZE_ENGINE", "recall-critic");
  vi.stubEnv("ANALYZE_V2_PCT", "0");
  vi.stubEnv("SONG_GATE", "on");
}

/** The analyze-result update (as opposed to the earlier "set status
 *  ANALYZING" update at the top of the stage) - identified the same way
 *  finalize.ts's own tests locate it, by the field only THIS update sets. */
function findAnalyzeResultUpdate() {
  return mocks.jobUpdate.mock.calls.find(
    (call) => call[0].data.analyzeEngine === "RECALL_CRITIC"
  )?.[0];
}

describe("music shorts wiring (stages/analyze.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("MUSIC_SHORTS off (default): refusal is byte-identical to a run where the flag is on but the source doesn't qualify - neither carries a musicShorts telemetry key", async () => {
    async function run(musicShortsEnv: string | undefined, sourceDurationSec: number | undefined) {
      vi.clearAllMocks();
      vi.unstubAllEnvs();
      stubBaseEnv();
      if (musicShortsEnv !== undefined) vi.stubEnv("MUSIC_SHORTS", musicShortsEnv);
      mocks.jobFind.mockResolvedValue({
        id: "job-off",
        transcriptJson: pureMusicTranscript(),
        transcriptPartial: false,
        sourceDurationSec,
      });

      await runAnalyzeStage({ jobId: "job-off", userId: "u1" });

      const update = findAnalyzeResultUpdate();
      const complete = mocks.completeJobStep.mock.calls[0][2];
      // analyzeMs is Date.now()-derived - the only field either side may
      // legitimately differ on between two separate invocations.
      const { analyzeMs: _u, ...updateData } = update.data;
      const { analyzeMs: _c, ...completeData } = complete;
      return { updateData, completeData };
    }

    const withoutFlag = await run(undefined, 200);
    const flagOnNotQualifying = await run("on", undefined);

    expect(withoutFlag.updateData).toEqual(flagOnNotQualifying.updateData);
    expect(withoutFlag.completeData).toEqual(flagOnNotQualifying.completeData);

    expect(withoutFlag.updateData).toEqual(
      expect.objectContaining({
        status: "ANALYZING",
        highlights: [],
        analyzeEngine: "RECALL_CRITIC",
        noClipsReason: "NO_USABLE_SPEECH",
      })
    );
    expect(withoutFlag.updateData.subtitles).toBeUndefined();
    expect(withoutFlag.completeData.telemetry.musicShorts).toBeUndefined();
    expect(flagOnNotQualifying.completeData.telemetry.musicShorts).toBeUndefined();

    // never calls the LLM path, never touches the TRANSCRIBE step row when
    // the branch can't fire in the first place
    expect(mocks.analyzeHighlightsV2).not.toHaveBeenCalled();
    expect(mocks.jobStepFindUnique).not.toHaveBeenCalled();
  });

  it("a stray truthy MUSIC_SHORTS value ('true') does not arm the branch - exact-literal 'on' only", async () => {
    stubBaseEnv();
    vi.stubEnv("MUSIC_SHORTS", "true");
    mocks.jobFind.mockResolvedValue({
      id: "job-stray",
      transcriptJson: pureMusicTranscript(),
      transcriptPartial: false,
      sourceDurationSec: 200,
    });

    await runAnalyzeStage({ jobId: "job-stray", userId: "u1" });

    const update = findAnalyzeResultUpdate();
    expect(update.data.highlights).toEqual([]);
    expect(update.data.noClipsReason).toBe("NO_USABLE_SPEECH");
    expect(mocks.jobStepFindUnique).not.toHaveBeenCalled();
  });

  it("MUSIC_SHORTS=on + song fired + 200s source + a real envelope -> 2 highlights shaped for render.ts, subtitles off in the SAME update, routed to render, telemetry path music-shorts", async () => {
    stubBaseEnv();
    vi.stubEnv("MUSIC_SHORTS", "on");
    mocks.jobFind.mockResolvedValue({
      id: "job-music",
      transcriptJson: pureMusicTranscript(),
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    mocks.jobStepFindUnique.mockResolvedValue({
      outputJson: { energyEnvelope: twoPeakEnvelope() },
    });

    await runAnalyzeStage({ jobId: "job-music", userId: "u1" });

    // zero LLM: the song gate fired, so analyzeHighlightsV2 must never run,
    // music or not
    expect(mocks.analyzeHighlightsV2).not.toHaveBeenCalled();
    // reads the TRANSCRIBE step's own row, not the ANALYZE step's
    expect(mocks.jobStepFindUnique).toHaveBeenCalledWith({
      where: { jobId_step: { jobId: "job-music", step: "TRANSCRIBE" } },
      select: { outputJson: true },
    });

    const update = findAnalyzeResultUpdate();
    expect(update.data.noClipsReason).toBeNull();
    expect(update.data.analyzeEngine).toBe("RECALL_CRITIC");
    expect(update.data.subtitles).toBe(false);

    const highlights = update.data.highlights as Array<Record<string, unknown>>;
    // relies on the CONFIG DEFAULT (musicShortsCount=2), deliberately not
    // stubbed here - a mutation of that default (2 -> 1) must redden this.
    expect(highlights).toHaveLength(2);
    for (const [i, h] of highlights.entries()) {
      // exactly the fields render.ts requires from a Highlight for this
      // task's minimal shape - no extra fields invented, none render
      // ignores added by accident.
      expect(Object.keys(h).sort()).toEqual(
        ["description", "end", "lowQuality", "start", "title"].sort()
      );
      expect(h.title).toBe(`Hook ${i + 1}`);
      expect(h.description).toBe("Chorus/hook segment of this track");
      expect(h.lowQuality).toBe(false);
      expect(typeof h.start).toBe("number");
      expect(typeof h.end).toBe("number");
      expect((h.end as number) > (h.start as number)).toBe(true);
    }

    const complete = mocks.completeJobStep.mock.calls[0][2];
    expect(complete.telemetry.path).toBe("music-shorts");
    expect(complete.telemetry.songGate).toEqual(
      expect.objectContaining({ fired: true })
    );
    expect(complete.telemetry.musicShorts.windows).toHaveLength(2);
    expect(complete.telemetry.musicShorts.envelopeLen).toBe(200);
    // zero LLM cost, stated by the usage object itself
    expect(complete.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
      byModel: {},
    });

    // billing invariant: never FAILED
    expect(mocks.jobUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );

    // a non-empty result rides the EXISTING non-empty-result rails: render,
    // not finalize
    expect(mocks.queueAdd).toHaveBeenCalledWith("render", {
      jobId: "job-music",
      userId: "u1",
      mode: "clips",
    });
    expect(mocks.queueAdd).not.toHaveBeenCalledWith("finalize", expect.anything());
  });

  it("source AT musicShortsMaxSec (480s, the boundary itself) still ships - pins <= over <", async () => {
    stubBaseEnv();
    vi.stubEnv("MUSIC_SHORTS", "on");
    mocks.jobFind.mockResolvedValue({
      id: "job-boundary",
      transcriptJson: pureMusicTranscript(),
      transcriptPartial: false,
      sourceDurationSec: 480,
    });
    mocks.jobStepFindUnique.mockResolvedValue({
      outputJson: { energyEnvelope: twoPeakEnvelope() },
    });

    await runAnalyzeStage({ jobId: "job-boundary", userId: "u1" });

    const update = findAnalyzeResultUpdate();
    expect((update.data.highlights as unknown[]).length).toBe(2);
    expect(update.data.noClipsReason).toBeNull();
    expect(update.data.subtitles).toBe(false);
  });

  it("source over musicShortsMaxSec (481s > default 480) -> refusal even with the gate fired and the flag on", async () => {
    stubBaseEnv();
    vi.stubEnv("MUSIC_SHORTS", "on");
    mocks.jobFind.mockResolvedValue({
      id: "job-over",
      transcriptJson: pureMusicTranscript(),
      transcriptPartial: false,
      sourceDurationSec: 481,
    });

    await runAnalyzeStage({ jobId: "job-over", userId: "u1" });

    const update = findAnalyzeResultUpdate();
    expect(update.data.highlights).toEqual([]);
    expect(update.data.noClipsReason).toBe("NO_USABLE_SPEECH");
    expect(update.data.subtitles).toBeUndefined();
    const complete = mocks.completeJobStep.mock.calls[0][2];
    expect(complete.telemetry.path).toBe("song-gate");
    expect(complete.telemetry.musicShorts).toBeUndefined();
    // never even reaches for the envelope: the duration gate is checked
    // before the DB round-trip
    expect(mocks.jobStepFindUnique).not.toHaveBeenCalled();
    expect(mocks.queueAdd).toHaveBeenCalledWith("finalize", {
      jobId: "job-over",
      userId: "u1",
    });
  });

  it("no signal at all (no repetition, no envelope) -> selectHookWindows returns [], falls through to the existing refusal untouched", async () => {
    stubBaseEnv();
    vi.stubEnv("MUSIC_SHORTS", "on");
    mocks.jobFind.mockResolvedValue({
      id: "job-nosignal",
      transcriptJson: pureMusicTranscript(), // fires the gate, zero rep evidence
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    mocks.jobStepFindUnique.mockResolvedValue({
      outputJson: { energyEnvelope: [] },
    });

    await runAnalyzeStage({ jobId: "job-nosignal", userId: "u1" });

    const update = findAnalyzeResultUpdate();
    expect(update.data.highlights).toEqual([]);
    expect(update.data.noClipsReason).toBe("NO_USABLE_SPEECH");
    expect(update.data.subtitles).toBeUndefined();
    const complete = mocks.completeJobStep.mock.calls[0][2];
    expect(complete.telemetry.path).toBe("song-gate");
    expect(complete.telemetry.musicShorts).toBeUndefined();
  });

  it("a missing/malformed TRANSCRIBE step row degrades to an empty envelope, not a throw - and still ships when the transcript carries real repetition (rep-only)", async () => {
    stubBaseEnv();
    vi.stubEnv("MUSIC_SHORTS", "on");
    mocks.jobFind.mockResolvedValue({
      id: "job-malformed",
      transcriptJson: repeatingLyricsTranscript(),
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    // no row at all (e.g. an old job) - null, not { outputJson: ... }
    mocks.jobStepFindUnique.mockResolvedValue(null);

    await runAnalyzeStage({ jobId: "job-malformed", userId: "u1" });

    const update = findAnalyzeResultUpdate();
    const highlights = update.data.highlights as unknown[];
    expect(highlights.length).toBe(2);
    expect(update.data.subtitles).toBe(false);
    const complete = mocks.completeJobStep.mock.calls[0][2];
    expect(complete.telemetry.path).toBe("music-shorts");
    expect(complete.telemetry.musicShorts.envelopeLen).toBe(0);

    // a SECOND malformed shape - a non-array energyEnvelope - degrades the
    // same way, proven independently rather than assumed from the null case
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    stubBaseEnv();
    vi.stubEnv("MUSIC_SHORTS", "on");
    mocks.jobFind.mockResolvedValue({
      id: "job-malformed-2",
      transcriptJson: repeatingLyricsTranscript(),
      transcriptPartial: false,
      sourceDurationSec: 200,
    });
    mocks.jobStepFindUnique.mockResolvedValue({
      outputJson: { energyEnvelope: "not-an-array" },
    });

    await runAnalyzeStage({ jobId: "job-malformed-2", userId: "u1" });

    const update2 = findAnalyzeResultUpdate();
    expect((update2.data.highlights as unknown[]).length).toBe(2);
    const complete2 = mocks.completeJobStep.mock.calls[0][2];
    expect(complete2.telemetry.musicShorts.envelopeLen).toBe(0);
  });
});
