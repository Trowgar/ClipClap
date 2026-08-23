import { describe, expect, it } from "vitest";
import {
  guardDarkEdges,
  selectHookWindows,
  shiftWindowAwayFromDark,
  snapWindowEdges,
} from "../analyze-v2/music-hook";

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

// ---------------------------------------------------------------------------
// task R2 (spec 2026-08-23-music-shorts): WINDOW SHIFT + EDGE GUARD, both
// driven by a per-second luma envelope, both applied around the existing
// energy-valley snap (WINDOW SHIFT before it, EDGE GUARD after it).
// ---------------------------------------------------------------------------

describe("selectHookWindows - WINDOW SHIFT (dark-luma avoidance)", () => {
  it("shifts the window off an interior dark band onto the one +-5s offset that fully clears it", () => {
    const durationSec = 60;
    const energyEnvelope = new Array(durationSec).fill(-20);
    for (let s = 20; s < 40; s++) energyEnvelope[s] = -5; // loud plateau -> top window [20,40)

    const lumaEnvelope = new Array(durationSec).fill(200); // bright everywhere...
    for (let s = 22; s < 25; s++) lumaEnvelope[s] = 10; // ...except a 3s dark band near the window's own start

    // Without luma the window sits at [20,40), straddling the dark band -
    // the plain valley-edge-snap test elsewhere in this file confirms
    // [20,40) is exactly where the energy envelope alone would place it.
    // Every offset in [-5,+4] still overlaps the band by 1-8s; +5 is the
    // ONLY offset in range that clears it entirely (window becomes
    // [25,45), band [22,25) now falls entirely before it).
    const [top] = selectHookWindows(
      { segments: [], energyEnvelope, lumaEnvelope, durationSec },
      1
    );

    expect(top.startSec).toBe(25);
    expect(top.endSec).toBe(45);
    expect(top.darkSeconds).toBe(0);
  });

  it("is a no-op when lumaEnvelope is empty or absent - byte-identical to the pre-R2 window", () => {
    const durationSec = 60;
    const energyEnvelope = new Array(durationSec).fill(-20);
    for (let s = 20; s < 40; s++) energyEnvelope[s] = -5;

    const noLumaKey = selectHookWindows({ segments: [], energyEnvelope, durationSec }, 1);
    const emptyLuma = selectHookWindows(
      { segments: [], energyEnvelope, lumaEnvelope: [], durationSec },
      1
    );

    expect(emptyLuma).toEqual(noLumaKey);
    // The pre-R2 energy-valley snap ALREADY nudges startSec from the raw
    // 20 to 19 here (index 19 is baseline -20dB, quieter than the -5dB
    // plateau at 20-39, and nearer to the edge than any other -20 second
    // in range) - not a task R2 behaviour, just what snapWindowEdges was
    // already doing; asserted here as the concrete "today" baseline this
    // no-op test is pinned against.
    expect(noLumaKey[0].startSec).toBe(19);
    expect(noLumaKey[0].endSec).toBe(40);
    // no darkSeconds key at all - not even `undefined` spelled out - so a
    // caller that never heard of task R2 sees the exact pre-R2 shape.
    expect(Object.prototype.hasOwnProperty.call(noLumaKey[0], "darkSeconds")).toBe(false);
  });

  it("shiftWindowAwayFromDark never proposes a shift outside [0, durationSec]", () => {
    const luma = new Array(30).fill(10); // dark everywhere, so every in-range shift ties at 0 dark headroom... actually all equally dark
    const window = { startSec: 0, endSec: 20 };
    const shifted = shiftWindowAwayFromDark(window, luma, 20, []);
    // durationSec == the window's own end: no positive shift is legal
    // (would exceed 20), no negative shift is legal (would go below 0) -
    // offset 0 is the only legal candidate, dark or not.
    expect(shifted).toEqual({ startSec: 0, endSec: 20 });
  });

  it("shiftWindowAwayFromDark never proposes a shift that crowds an already-finalized window", () => {
    // Dark band [20,23) at the window's own start; shifts +3/+4/+5 would
    // each clear it completely (dark=0) but each also lands within
    // DISTINCT_REGION_MIN_OVERLAP_SEC(10s) of the finalized window at
    // [33,53) - all three rejected. The best LEGAL candidate is +2
    // (dark=1, not fully clean, but the closest legal offset gets there
    // before the crowding boundary at +3).
    const luma = new Array(80).fill(200);
    for (let s = 20; s < 23; s++) luma[s] = 10;
    const window = { startSec: 20, endSec: 40 };
    const finalized = [{ startSec: 33, endSec: 53 }];
    const shifted = shiftWindowAwayFromDark(window, luma, 80, finalized);
    expect(shifted).toEqual({ startSec: 22, endSec: 42 });
  });
});

describe("guardDarkEdges (EDGE GUARD, applied after shift + energy-valley snap)", () => {
  it("nudges an opening AND closing dark edge inward, up to the 3s cap", () => {
    const luma = new Array(50).fill(10); // dark throughout
    const guarded = guardDarkEdges({ startSec: 20, endSec: 40 }, luma);
    // 20s span, floor is 12s - three 1s nudges on each edge only shrinks it
    // to 14s, well clear of the floor, so the 3s CAP is what stops it here,
    // not the floor (that is the next test's job).
    expect(guarded).toEqual({ startSec: 23, endSec: 37 });
  });

  it("stops a nudge at the 12s floor even though the 3s cap would allow more", () => {
    const luma = new Array(40).fill(10);
    for (let s = 15; s < 40; s++) luma[s] = 200; // bright from 15 on - only the OPENING edge is dark
    // 13s window: one nudge (10 -> 11) leaves 12s (the floor, still legal);
    // a second nudge (11 -> 12) would leave 11s, under the floor, so the
    // guard must stop after exactly one step despite the 3s cap allowing
    // up to three.
    const guarded = guardDarkEdges({ startSec: 10, endSec: 23 }, luma);
    expect(guarded).toEqual({ startSec: 11, endSec: 23 });
  });

  it("does nothing when the edge is already bright", () => {
    const luma = new Array(40).fill(200);
    const guarded = guardDarkEdges({ startSec: 10, endSec: 30 }, luma);
    expect(guarded).toEqual({ startSec: 10, endSec: 30 });
  });

  it("is a no-op against an empty envelope", () => {
    const guarded = guardDarkEdges({ startSec: 10, endSec: 30 }, []);
    expect(guarded).toEqual({ startSec: 10, endSec: 30 });
  });
});

describe("selectHookWindows - EDGE GUARD integration", () => {
  it("cleans up a dark opening edge that WINDOW SHIFT alone could not fully clear", () => {
    const durationSec = 60;
    // Flat energy, no rep evidence anywhere: every STEP_SEC grid window
    // ties at score 0, so the stable sort keeps window [0,20) (w0=0) as
    // the chosen top window - a fixed, known starting point for this test.
    const energyEnvelope = new Array(durationSec).fill(-20);
    // An 8s dark band at the very start (0-7): WINDOW SHIFT can only move
    // this window POSITIVELY (it already starts at 0), and within its
    // +-5s radius the least-dark achievable offset is +5 (window [5,25)),
    // which still leaves 3 dark seconds (5,6,7) sitting right at the new
    // opening edge - too wide for the shift alone, but exactly within
    // EDGE_GUARD_MAX_NUDGE_SEC(3), so only the guard (applied after the
    // shift) can finish the job.
    const lumaEnvelope = new Array(durationSec).fill(200);
    for (let s = 0; s < 8; s++) lumaEnvelope[s] = 10;

    const [top] = selectHookWindows(
      { segments: [], energyEnvelope, lumaEnvelope, durationSec },
      1
    );

    expect(top.startSec).toBe(8);
    expect(top.endSec).toBe(25);
    expect(top.darkSeconds).toBe(0);
  });
});
