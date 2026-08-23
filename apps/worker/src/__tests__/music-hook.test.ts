import { describe, expect, it } from "vitest";
import { selectHookWindows, snapWindowEdges } from "../analyze-v2/music-hook";

function seg(text: string, start: number, end: number) {
  return { text, start, end };
}

/** Overlap test matching the module's own half-open convention. */
function overlaps(a: { startSec: number; endSec: number }, b: [number, number]) {
  return a.startSec < b[1] && a.endSec > b[0];
}

describe("selectHookWindows - synthetic song (rep + energy agree)", () => {
  // Chorus line repeated three times, >= 25s apart each time (MIN_GAP_SEC),
  // with the first two choruses louder than baseline and the third left at
  // baseline - energy differentiates an otherwise-tied rep score so the
  // top-2 distinct regions are deterministic.
  const chorus = "we are on top of the world tonight";
  const segments = [
    seg("walking down the empty street tonight", 0, 4),
    seg("shadows on the wall keep falling slow", 8, 12),
    seg(chorus, 25, 29),
    seg("counting stars above the silent town", 45, 49),
    seg("waiting for the sun to break the dark", 58, 62),
    seg(chorus, 75, 79),
    seg("running through the fields of gold and rust", 95, 99),
    seg("holding on to nothing but the wind", 108, 112),
    seg(chorus, 125, 129),
  ];
  const durationSec = 145;
  const energyEnvelope: number[] = new Array(durationSec).fill(-30);
  for (let s = 15; s < 35; s++) energyEnvelope[s] = -8; // loudest: around chorus 1
  for (let s = 65; s < 85; s++) energyEnvelope[s] = -14; // loud: around chorus 2
  // chorus 3 (125-129) stays at baseline - no energy boost.

  it("ranks the top window on a chorus, with rep evidence", () => {
    const [top] = selectHookWindows({ segments, energyEnvelope, durationSec }, 2);
    expect(top.rep).toBe(1);
    expect(overlaps(top, [25, 29])).toBe(true); // contains chorus 1
  });

  it("returns two DISTINCT regions for count=2, not two shifts of the same chorus", () => {
    const windows = selectHookWindows({ segments, energyEnvelope, durationSec }, 2);
    expect(windows).toHaveLength(2);
    const [first, second] = windows;
    // no >= half-window overlap between the two returned windows
    const overlap =
      Math.min(first.endSec, second.endSec) - Math.max(first.startSec, second.startSec);
    expect(overlap).toBeLessThan(10);
    expect(overlaps(second, [75, 79])).toBe(true); // the OTHER loud chorus, not a shift of #1
  });
});

describe("selectHookWindows - adjacent-repeat hallucination", () => {
  it("produces zero rep evidence for a short burst of the same junk line every 2s, rides energy alone", () => {
    // Span of the burst (18s) stays under MIN_GAP_SEC(25s), so the greedy
    // distance walk can never find two occurrences of the line far enough
    // apart to count as a reprise - a real Whisper hallucination loop, not
    // a chorus.
    const segments: Array<{ text: string; start: number; end: number }> = [];
    for (let t = 0; t < 20; t += 2) segments.push(seg("uh huh yeah okay", t, t + 1));

    const durationSec = 140;
    const energyEnvelope = new Array(durationSec).fill(-30);
    for (let s = 100; s < 120; s++) energyEnvelope[s] = -5; // one clear loud region, far from the burst

    const [top] = selectHookWindows({ segments, energyEnvelope, durationSec }, 1);
    expect(top.rep).toBe(0);
    expect(overlaps(top, [100, 119])).toBe(true);
  });
});

describe("selectHookWindows - energy-only (Baby Shark class)", () => {
  it("picks the loud region on energy alone when no line repeats at all", () => {
    const segments = [
      seg("baby shark doo doo doo doo doo doo", 0, 3),
      seg("mommy shark doo doo doo doo doo doo", 10, 13),
      seg("daddy shark doo doo doo doo doo doo", 20, 23),
      seg("grandma shark doo doo doo doo doo doo", 90, 93),
      seg("grandpa shark doo doo doo doo doo doo", 100, 103),
      seg("lets go hunt doo doo doo doo doo doo", 110, 113),
    ]; // every line is unique - zero rep evidence regardless of MIN_GAP_SEC
    const durationSec = 140;
    const energyEnvelope = new Array(durationSec).fill(-30);
    for (let s = 90; s < 110; s++) energyEnvelope[s] = -6; // one loud 20s region, no lyric backing

    const [top] = selectHookWindows({ segments, energyEnvelope, durationSec }, 1);
    expect(top.rep).toBe(0);
    expect(overlaps(top, [90, 109])).toBe(true);
  });
});

describe("selectHookWindows - distinct-region rule (the Blinding Lights lesson)", () => {
  it("returns the true runner-up region, not a second shift of the top region's plateau", () => {
    // Region A: one loud 20s plateau (energyZ ~2.60 dead center). Windows
    // adjacent to it (shifted one STEP_SEC either way) still overlap the
    // plateau enough to score ~1.83 - HIGHER than region B's ~1.20 - so
    // without the distinct-region rule, top-2 by raw score would be two
    // overlapping windows over region A, burying region B entirely.
    const durationSec = 200;
    const energyEnvelope = new Array(durationSec).fill(-30);
    for (let s = 40; s < 60; s++) energyEnvelope[s] = -8; // region A
    for (let s = 150; s < 170; s++) energyEnvelope[s] = -18; // region B, genuinely distinct

    const windows = selectHookWindows(
      { segments: [], energyEnvelope, durationSec },
      2
    );
    expect(windows).toHaveLength(2);
    expect(overlaps(windows[0], [40, 60])).toBe(true); // region A wins rank 1
    expect(windows[1].startSec).toBeGreaterThanOrEqual(140); // region B, not a shift of A
    expect(overlaps(windows[1], [150, 170])).toBe(true);
  });
});

describe("selectHookWindows - valley edge snapping", () => {
  it("moves both edges out to a valley within reach", () => {
    const durationSec = 60;
    const energyEnvelope = new Array(durationSec).fill(-20);
    for (let s = 20; s < 40; s++) energyEnvelope[s] = -5; // loud plateau, exactly one grid window
    energyEnvelope[18] = -35; // valley 2s before the plateau starts
    energyEnvelope[42] = -35; // valley 2s after the plateau ends

    const [top] = selectHookWindows(
      { segments: [], energyEnvelope, durationSec },
      1
    );
    expect(top.startSec).toBe(18);
    expect(top.endSec).toBe(42);
  });

  it("keeps the un-snapped edge when the valley would shrink the window under 12s", () => {
    // Direct on snapWindowEdges: at WINDOW_SEC=20 and a 3s snap radius, a
    // window fresh out of selectHookWindows can never legitimately shrink
    // under 12s (worst case 20 - 3 - 3 = 14) - see that constant's comment
    // in music-hook.ts. This exercises the floor directly against a
    // narrower window so the guard has a reachable test today.
    const envelope = new Array(30).fill(-20);
    envelope[13] = -40; // quietest, 3s inside start=10 - would shrink 14s window to 11s
    envelope[25] = -40; // quietest, 1s outside end=24 - widens to 15s, allowed

    const snapped = snapWindowEdges({ startSec: 10, endSec: 24 }, envelope, []);
    expect(snapped.startSec).toBe(10); // rejected: 24 - 13 = 11 < 12
    expect(snapped.endSec).toBe(25); // accepted: 25 - 10 = 15 >= 12
  });

  it("does not move an edge when the envelope is empty", () => {
    const snapped = snapWindowEdges({ startSec: 10, endSec: 30 }, [], []);
    expect(snapped).toEqual({ startSec: 10, endSec: 30 });
  });
});

describe("selectHookWindows - one-token lines never count as rep evidence", () => {
  it("returns [] for a distant-repeated one-token line with no envelope (no signal at all)", () => {
    const segments: Array<{ text: string; start: number; end: number }> = [];
    for (let t = 0; t < 400; t += 40) segments.push(seg("lol", t, t + 1)); // 10x, well >= MIN_GAP_SEC apart

    expect(selectHookWindows({ segments, energyEnvelope: [], durationSec: 400 }, 2)).toEqual([]);
  });

  it("sanity: the same shape with a two-token line DOES produce rep evidence", () => {
    // Proves the [] result above comes from the token-count guard, not
    // from some other reason the harness happens to return [].
    const segments: Array<{ text: string; start: number; end: number }> = [];
    for (let t = 0; t < 400; t += 40) segments.push(seg("lol yeah", t, t + 1));

    const windows = selectHookWindows(
      { segments, energyEnvelope: [], durationSec: 400 },
      2
    );
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].rep).toBeGreaterThan(0);
  });
});

describe("selectHookWindows - no signal at all", () => {
  it("returns [] for empty segments, empty envelope", () => {
    expect(selectHookWindows({ segments: [], energyEnvelope: [], durationSec: 0 }, 2)).toEqual([]);
  });

  it("returns [] for a duration with no lyrics and no envelope even when > 0", () => {
    expect(
      selectHookWindows({ segments: [], energyEnvelope: [], durationSec: 300 }, 2)
    ).toEqual([]);
  });
});
