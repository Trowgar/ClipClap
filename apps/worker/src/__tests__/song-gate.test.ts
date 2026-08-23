import { describe, expect, it } from "vitest";
import type { WhisperSegment } from "@clipclap/shared";
import {
  computeSongSignals,
  detectSong,
  LINE_REP_RATE_THRESHOLD,
  MUSIC_TOKEN_SHARE_THRESHOLD,
} from "../analyze-v2/song-gate";
import { FIXTURES_DIR, loadFixture } from "./helpers/eval-fixture";

/** Pure-♫ shape, measured on job cmspy9brs00anuhfjecmby2u2 (spec 2026-08-10
 *  task 8, `eval-song-gate.ts`): every segment is literally a music-note
 *  glyph, no words at all. */
function pureMusicSegments(n = 6): WhisperSegment[] {
  return Array.from({ length: n }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 1.5,
    text: "♫",
  }));
}

/** Sung-as-words shape, measured on cmsp6e9sg0096uhfj33smi7kd: Whisper
 *  transcribes the lyrics as ordinary capitalized text, no note glyph
 *  anywhere - a chorus recurring verbatim is the only signal available. */
function chorusSegments(): WhisperSegment[] {
  const lines = [
    "I let you get too close",
    "Just to wake up alone",
    "I'd let the world go",
    "Let the world go for you",
    "I let you get too close",
    "Just to wake up alone",
    "I'd let the world go",
    "Let the world go for you",
    "One line that never repeats",
  ];
  return lines.map((text, i) => ({ start: i * 4, end: i * 4 + 3, text }));
}

/** Ordinary conversation: five distinct sentences, no repeats, no music
 *  tokens. Exists so a mutation that hardcodes `fired: true` is caught here
 *  rather than only by omission (memory feedback_test_matches_default: a
 *  test whose only expectation is the tie-break default proves nothing -
 *  this asserts the NEGATIVE path is reachable on real-shaped input too). */
function ordinarySpeechSegments(): WhisperSegment[] {
  const lines = [
    "Welcome back to the show today.",
    "We have a lot to cover this week.",
    "Let's start with the first story.",
    "That took an unexpected turn quickly.",
    "Thanks for listening, see you next time.",
  ];
  return lines.map((text, i) => ({ start: i * 3, end: i * 3 + 2.5, text }));
}

describe("detectSong - synthetic cases", () => {
  it("fires on a pure ♫ transcript (musicTokenShare signal)", () => {
    const result = detectSong(pureMusicSegments());
    expect(result.signals.musicTokenShare).toBe(1);
    expect(result.signals.musicTokenShare).toBeGreaterThan(
      MUSIC_TOKEN_SHARE_THRESHOLD
    );
    expect(result.fired).toBe(true);
  });

  it("fires on a synthetic chorus-repeat transcript (lineRepRate signal)", () => {
    const result = detectSong(chorusSegments());
    // 8 of 9 lines recur (4 distinct lines x 2), 1 is unique -> 8/9 = 0.888..
    expect(result.signals.lineRepRate).toBeCloseTo(8 / 9, 5);
    expect(result.signals.lineRepRate).toBeGreaterThan(LINE_REP_RATE_THRESHOLD);
    expect(result.signals.musicTokenShare).toBe(0);
    expect(result.fired).toBe(true);
  });

  it("does NOT fire on ordinary, non-repeating speech", () => {
    const result = detectSong(ordinarySpeechSegments());
    expect(result.signals.musicTokenShare).toBe(0);
    expect(result.signals.lineRepRate).toBe(0);
    expect(result.fired).toBe(false);
  });

  it("an empty transcript does not fire (no tokens, no lines - both shares are 0/0 by convention)", () => {
    const result = detectSong([]);
    expect(result.signals.musicTokenShare).toBe(0);
    expect(result.signals.lineRepRate).toBe(0);
    expect(result.fired).toBe(false);
  });

  it("normalizes case and punctuation before comparing lines (chorus signal survives re-punctuation)", () => {
    const segments: WhisperSegment[] = [
      { start: 0, end: 2, text: "Let it go!" },
      { start: 2, end: 4, text: "let it go" },
      { start: 4, end: 6, text: "LET IT GO." },
      { start: 6, end: 8, text: "A line that is different" },
    ];
    const result = detectSong(segments);
    // all three "let it go" variants collide -> 3/4 repeated
    expect(result.signals.lineRepRate).toBeCloseTo(3 / 4, 5);
    expect(result.fired).toBe(true);
  });
});

describe("detectSong - does NOT fire on the five real eval fixtures", () => {
  const FIXTURE_NAMES = [
    "podcast-answer-arc",
    "podcast-ecology",
    "podcast-nuclear",
    "sitcom-friends",
    "creator-challenge",
  ];

  for (const name of FIXTURE_NAMES) {
    it(`fixture "${name}"`, () => {
      const fixture = loadFixture(name, FIXTURES_DIR);
      const result = detectSong(fixture.transcript.segments);
      expect(result.fired).toBe(false);
    });
  }
});

describe("computeSongSignals - the same function eval-song-gate.ts imports", () => {
  it("segCount matches the input length regardless of content", () => {
    const signals = computeSongSignals(pureMusicSegments(6));
    expect(signals.segCount).toBe(6);
  });

  it("a mixed transcript (some music tokens, no repeats) reports both signals independently", () => {
    const segments: WhisperSegment[] = [
      { start: 0, end: 1, text: "♫" },
      { start: 1, end: 3, text: "A completely unique line" },
      { start: 3, end: 5, text: "Another line, also unique" },
    ];
    const signals = computeSongSignals(segments);
    // 1 music token out of (1 + 4 + 4) = 9 tokens
    expect(signals.musicTokenShare).toBeCloseTo(1 / 9, 5);
    expect(signals.lineRepRate).toBe(0);
  });
});

/** Whisper's stutter shape, measured on a real production job 2026-08-23
 *  (job of telegramId 6519253646, a 36-minute Hindi conversation from
 *  YouTube): the transcript is complete - 688 segments, 11,041 characters,
 *  coverage 1.000 - but 252 of those segments normalise to the single
 *  character "3", plus 13 to "i" and a handful to one Devanagari letter.
 *  That junk alone carried lineRepRate to 0.473 and the gate refused the
 *  whole video as NO_USABLE_SPEECH. The user got zero clips from a
 *  perfectly transcribed video, and then tried to buy a plan anyway.
 *
 *  A chorus is a PHRASE. One token repeated is noise - the same class of
 *  no-textual-evidence line the empty-string rule already excludes. */
function whisperStutterSegments(): WhisperSegment[] {
  const segs: WhisperSegment[] = [];
  let t = 0;
  // 250 junk one-token segments, exactly the observed shape.
  for (let i = 0; i < 250; i++) {
    segs.push({ start: t, end: t + 1, text: "3" });
    t += 1;
  }
  // 340 distinct sentences of real speech, none repeated.
  for (let i = 0; i < 340; i++) {
    segs.push({
      start: t,
      end: t + 3,
      text: `यह एक अलग वाक्य है संख्या ${i} और यह दोहराया नहीं जाता`,
      });
    t += 3;
  }
  return segs;
}

describe("the repetition signal ignores lines too short to be a chorus", () => {
  it("does not refuse a fully transcribed conversation padded with one-token junk", () => {
    const signals = computeSongSignals(whisperStutterSegments());
    expect(signals.lineRepRate).toBeLessThan(LINE_REP_RATE_THRESHOLD);
    expect(detectSong(whisperStutterSegments()).fired).toBe(false);
  });

  it("still fires on a real chorus, whose lines are phrases", () => {
    expect(detectSong(chorusSegments()).fired).toBe(true);
  });
});
