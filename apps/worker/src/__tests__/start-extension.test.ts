import { describe, expect, it } from "vitest";
import {
  applyStartExtension,
  extendClipStarts,
  startExtensionWindow,
} from "../analyze-v2/start-extension";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { StartExtensionAttempt } from "../analyze-v2/start-extension";
import type {
  ArcFlags,
  CriticVerdict,
  SentenceNode,
  SnappedClip,
} from "../analyze-v2/types";
import type { TeaserRegion } from "../analyze-v2/teaser";

// ---------------------------------------------------------------------------
// THE CONTRACT THIS FILE EXISTS TO HOLD (spec 2026-08-10 task 3)
//
// extendClipStarts can only ever WIDEN a clip's start, and only BACKWARD, and
// only for a clip whose `_arcFlags` carried a gated `entry.fixStartNode`
// pointer. No failure mode returns a clip that is shorter, missing, reordered,
// or a start that moved forward - and none of them fails the job, because
// this stage never even calls a model (arc-audit already did, and gated its
// own answer once).
//
// Every gate test below asserts by REASON, never by a bare refusal - a test
// that only proves "this was turned down" passes just as happily when the
// wrong gate fired, per feedback_test_matches_default: the fixture has to be
// built so the pointer is otherwise LEGAL and only the gate under test can
// explain the refusal.
// ---------------------------------------------------------------------------

/** count nodes, 2s each, back to back, every one a clean start/end unless the
 *  caller overrides one. `holeBefore`, when given, opens a 12s silent hole
 *  right before that index - 12 > any sceneGapSec this file uses, so it is
 *  always a scene cut. Mirrors end-extension.test.ts's and arc-audit.test.ts's
 *  own `nodes()` helpers - the two-second spacing matches arc-audit.test.ts,
 *  whose gates this stage's own first five re-check. */
function nodes(count: number, holeBefore?: number): SentenceNode[] {
  const out: SentenceNode[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i === holeBefore) t += 12;
    out.push({
      index: i,
      start: t,
      end: t + 2,
      text: `Line ${i}.`,
      hasWords: true,
      trailingStrength: 1,
      leadingStrength: 1,
    });
    t += 2;
  }
  return out;
}

function verdict(id: string, startNode: number, endNode: number): CriticVerdict {
  return {
    id,
    keep: true,
    score: 0.8,
    grounded: true,
    selfContained: true,
    startNode,
    payoffNode: endNode,
    endNode,
    hookStartNode: startNode,
    hookEndNode: endNode,
    title: `title ${id}`,
    description: `description ${id}`,
    titleEvidenceNodes: [startNode],
    descriptionEvidenceNodes: [startNode],
    language: "en",
  };
}

function clip(
  n: SentenceNode[],
  id: string,
  startNode: number,
  endNode: number
): SnappedClip {
  return {
    verdict: verdict(id, startNode, endNode),
    startSec: n[startNode].start,
    endSec: n[endNode].end,
    finalStartNode: startNode,
    finalEndNode: endNode,
    hookStartSec: n[startNode].start,
    hookEndSec: n[endNode].end,
    payoffSec: n[endNode].end,
    shortMoment: false,
  };
}

const cfg = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", START_EXTENSION_WINDOW_SEC: "20" });

/** applyStartExtension's answer as ONE comparable value: the gate that
 *  refused, or "accepted". Every refusal below is asserted through this, the
 *  same discipline end-extension.test.ts's own verdictOf uses. */
const verdictOf = (a: StartExtensionAttempt): string => (a.ok ? "accepted" : a.reason);

const clipOf = (a: StartExtensionAttempt): SnappedClip => {
  if (!a.ok) throw new Error(`expected an accepted widen, got "${a.reason}"`);
  return a.clip;
};

/** A synthetic teaser region: nodes starting before 21s are "inside the
 *  montage". Built by hand rather than through detectTeaserRegion for the
 *  gate-level tests, because applyStartExtension and startExtensionWindow take
 *  a TeaserRegion as a plain argument - the same reasoning end-extension's own
 *  tests construct an ExtensionWindow-shaped SnappedClip by hand rather than
 *  running the whole scanner. extendClipStarts's OWN describe block below
 *  proves the real detectTeaserRegion call is wired in, with real recurring
 *  text. */
const teaserRegion: TeaserRegion = {
  endSec: 21,
  hits: 3,
  hitNodes: [0, 1, 2],
  firstHitStartSec: 0,
  lastHitEndSec: 6,
  originSpreadSec: 0,
};

describe("startExtensionWindow", () => {
  it("stops at the scene boundary even when the time window reaches further", () => {
    const n = nodes(30, 8); // cut right before node 8
    const c = clip(n, "c0", 15, 18);
    expect(startExtensionWindow(c, n, cfg, null).firstNode).toBe(8);
  });

  it("stops at the time window when no scene boundary intervenes", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 15, 18);
    const w = startExtensionWindow(c, n, cfg, null);
    expect(n[15].start - n[w.firstNode].start).toBeLessThanOrEqual(20);
    expect(w.firstNode).toBeLessThan(15);
  });

  it("is empty when the clip already starts at the scene boundary", () => {
    const n = nodes(30, 15); // cut right before node 15, the clip's own start
    const c = clip(n, "c0", 15, 18);
    expect(startExtensionWindow(c, n, cfg, null).firstNode).toBe(15);
  });

  it("honours cfg.startExtensionWindowSec rather than a built-in", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 20, 23);
    const narrow = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", START_EXTENSION_WINDOW_SEC: "9" });
    expect(startExtensionWindow(c, n, narrow, null).firstNode).toBe(16);
    expect(startExtensionWindow(c, n, cfg, null).firstNode).toBe(10);
  });

  // The floor invariant, from the other direction: firstNode may never land
  // AFTER the clip's own start, or the "window" would be an instruction to
  // shrink. A zero window is the tightest case and must read as "no widening
  // possible", not as a negative one.
  it("never reaches past the clip's own start, even with a zero window", () => {
    const zero = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", START_EXTENSION_WINDOW_SEC: "0" });
    for (const n of [nodes(40), nodes(30, 15), nodes(30, 8)]) {
      for (const c of [cfg, zero]) {
        expect(startExtensionWindow(clip(n, "c0", 15, 18), n, c, null).firstNode).toBeLessThanOrEqual(15);
      }
    }
  });

  // THE TEASER REGION - the bound arc-audit's own gateEntryFix never checks,
  // because that gate runs before the clip is anywhere near a shipped set. A
  // node whose start sits inside the montage stops the backward walk right
  // there, even with clock and scene both wide open - the defect the teaser
  // filter exists to prevent is a start pulled INTO the intro montage.
  it("stops at the teaser region even when the clock and the scene rail both allow more", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 15, 18);
    const withoutRegion = startExtensionWindow(c, n, cfg, null);
    expect(withoutRegion.firstNode).toBeLessThan(10); // node 10 (t=20) sits inside the region
    const withRegion = startExtensionWindow(c, n, cfg, teaserRegion);
    // node 10 starts at 20s, inside the region (< 21); node 11 at 22s is not
    expect(n[10].start).toBeLessThan(teaserRegion.endSec);
    expect(n[11].start).toBeGreaterThanOrEqual(teaserRegion.endSec);
    expect(withRegion.firstNode).toBe(11);
  });
});

describe("applyStartExtension", () => {
  it("accepts a legal backward move and returns the widened clip", () => {
    const n = nodes(40);
    const out = clipOf(applyStartExtension(clip(n, "c0", 15, 18), n, 10, cfg, null, []));
    expect(out.finalStartNode).toBe(10);
    expect(out.startSec).toBeLessThan(n[15].start);
  });

  // Kills dropping Number.isInteger. Defence in depth - arc-audit's own
  // gateEntryFix already required this before the pointer could reach
  // ArcFlags.entry.fixStartNode, but this function's total-function promise
  // does not trust a single upstream check.
  it("refuses a proposal that is not a whole node index", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 15, 18);
    for (const bad of [8.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(verdictOf(applyStartExtension(c, n, bad, cfg, null, []))).toBe("not_an_index");
    }
  });

  it("refuses a move that is not strictly backward", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 15, 18);
    expect(verdictOf(applyStartExtension(c, n, 15, cfg, null, []))).toBe("not_backward"); // no-op
    expect(verdictOf(applyStartExtension(c, n, 17, cfg, null, []))).toBe("not_backward"); // forward
  });

  it("refuses an index outside the graph", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 15, 18);
    expect(verdictOf(applyStartExtension(c, n, -1, cfg, null, []))).toBe("outside_graph");
  });

  // A clip whose own start node is corrupted must be refused, never thrown -
  // the same defensive shape as end-extension's clip_end_unusable, folded here
  // into "outside_graph" rather than a ninth reason (see the module comment).
  it("refuses a clip whose own start node is not a real index, rather than throwing", () => {
    const n = nodes(40);
    const stale = { ...clip(n, "c0", 15, 18), finalStartNode: 500 };
    expect(verdictOf(applyStartExtension(stale, n, 10, cfg, null, []))).toBe("outside_graph");
    for (const bad of [-1, 2.5, Number.NaN]) {
      expect(
        verdictOf(applyStartExtension({ ...clip(n, "c0", 15, 18), finalStartNode: bad }, n, 3, cfg, null, []))
      ).toBe("outside_graph");
    }
  });

  it("refuses a move across a scene boundary behind the clip", () => {
    const n = nodes(30, 8); // cut right before node 8
    const c = clip(n, "c0", 15, 18);
    expect(verdictOf(applyStartExtension(c, n, 5, cfg, null, []))).toBe("outside_window");
  });

  it("refuses a pointer further back than startExtensionWindowSec allows", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 20, 23); // node 20 at t=40
    expect(verdictOf(applyStartExtension(c, n, 0, cfg, null, []))).toBe("outside_window"); // t=0, 40s back
  });

  it("admits a pointer exactly on the window boundary", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 20, 23); // t=40
    expect(n[20].start - n[10].start).toBe(20); // node 10 at t=20, exactly 20s back
    expect(verdictOf(applyStartExtension(c, n, 10, cfg, null, []))).toBe("accepted");
  });

  // THE TEASER REGION REFUSAL, named explicitly in the spec: a pointer that is
  // otherwise fully legal (backward, in-graph, within the clock and the scene
  // rail, a clean start) must still be refused when it lands inside the
  // montage - and the SAME call with no region succeeds, proving the region is
  // the only thing standing between the two outcomes (feedback_test_matches_
  // default: the gate has to OVERCOME the accept default).
  it("refuses a pointer that would land the new start inside the teaser region", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 12, 15); // node 12 at t=24
    // node 8 (t=16) is backward, in-graph, well within the 20s clock (8s back),
    // no scene cut anywhere in this fixture, and a clean start by construction
    expect(verdictOf(applyStartExtension(c, n, 8, cfg, null, []))).toBe("accepted");
    // the region covers everything starting before 21s, which includes node 8
    expect(n[8].start).toBeLessThan(teaserRegion.endSec);
    expect(verdictOf(applyStartExtension(c, n, 8, cfg, teaserRegion, []))).toBe("outside_window");
  });

  it("refuses a pointer that is not a clean start, and only for that reason", () => {
    const n = nodes(40);
    n[8] = { ...n[8], leadingStrength: 0.2, text: "mid-sentence continuation." };
    const c = clip(n, "c0", 15, 18);
    expect(verdictOf(applyStartExtension(c, n, 8, cfg, null, []))).toBe("not_clean_start");
    // the node right next to it, untouched, is still accepted
    expect(verdictOf(applyStartExtension(c, n, 9, cfg, null, []))).toBe("accepted");
  });

  // The index gate is NOT made redundant by the seconds gate. Node 8's own
  // `start` is hand-set to sit AFTER the clip's current startSec (minus
  // leadInSec), the nested-timing shape end-extension.test.ts uses on the far
  // side of a clip - so a strictly-earlier NODE produces a NOT-earlier SECOND,
  // and only the seconds gate can catch it.
  it("refuses a backward node whose computed second is not actually earlier", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 12, 15); // startSec = n[12].start = 24
    n[8] = { ...n[8], start: 24.2, end: 26.2 };
    expect(c.startSec).toBe(24);
    // startSecFor(8) = max(min(n[7].end, 24.2), 24.2 - leadInSec(0.15)) = max(16, 24.05) = 24.05
    expect(verdictOf(applyStartExtension(c, n, 8, cfg, null, []))).toBe("no_gain");
  });

  // The exact-equality edge of the same rule: a computed second equal to
  // (never less than) the clip's current startSec is still a no-op.
  it("refuses a move that lands exactly on the clip's current second", () => {
    const n = nodes(40);
    const c = clip(n, "c0", 12, 15); // startSec = n[12].start = 24
    n[8] = { ...n[8], start: 24 + cfg.leadInSec, end: 26 };
    // startSecFor(8) = max(min(n[7].end, 24+leadIn), (24+leadIn) - leadIn) = max(16, 24) = 24
    expect(verdictOf(applyStartExtension(c, n, 8, cfg, null, []))).toBe("no_gain");
  });

  it("refuses a widened clip that would breach maxSec", () => {
    const n = nodes(60);
    const short = loadAnalyzeConfig({
      SCENE_GAP_SEC: "8",
      START_EXTENSION_WINDOW_SEC: "1000",
      CLIP_MAX_SEC: "30",
    });
    const c = clip(n, "c0", 20, 22); // endSec = n[22].end = 46
    // node 5 (t=10) would make the clip 36s long - over the 30s cap
    expect(c.endSec - n[5].start).toBeGreaterThan(short.maxSec);
    expect(verdictOf(applyStartExtension(c, n, 5, short, null, []))).toBe("too_long");
    // and a node that lands exactly on the cap is accepted
    const onCap = n.findIndex((x) => c.endSec - x.start === short.maxSec);
    expect(verdictOf(applyStartExtension(c, n, onCap, short, null, []))).toBe("accepted");
  });

  // NMS COLLISION - the gate end-extension does not carry. Two clips whose
  // widened/unwidened ranges overlap more than 30% of the shorter one are the
  // same moment to a viewer; refusing here is the measured answer to the
  // anaphora lesson (engine-notes §3) - a widened boundary that feeds NMS
  // deleted the very clip it repaired on that occasion, so this stage refuses
  // visibly instead.
  it("refuses a widen that would collide with another clip in the selected set", () => {
    const n = nodes(60);
    const c = clip(n, "c0", 20, 23); // 40-48s, 8s long
    // widening c0 to start at node 15 (30s) makes it 30-48s, 18s long; a
    // neighbour spanning 32-44s overlaps 12s of that - well over 30% of the
    // shorter (the neighbour's own 12s span), which the un-widened c0 (40-48s)
    // never touched at all
    const neighbour = clip(n, "other", 16, 22); // 32-46s... adjust to isolate collision to the widen
    expect(verdictOf(applyStartExtension(c, n, 15, cfg, null, [neighbour]))).toBe("nms_collision");
    // and the same widen, with no neighbour to collide with, is accepted
    expect(verdictOf(applyStartExtension(c, n, 15, cfg, null, []))).toBe("accepted");
  });

  // The whole-object invariant, swept rather than spot-checked: an accepted
  // widen moves the start and NOTHING else. Copy is grounded against
  // [finalStartNode, finalEndNode] before this stage runs, so widening that
  // range is safe and moving anything else in it is not (engine-notes §6).
  it("moves the start backward and changes nothing else, for every legal proposal", () => {
    const n = nodes(40);
    const before = { ...clip(n, "c0", 20, 23), boundaryConfidence: "segment" as const };
    let accepted = 0;
    for (let i = 0; i < 20; i++) {
      const attempt = applyStartExtension(before, n, i, cfg, null, []);
      if (!attempt.ok) continue;
      const out = attempt.clip;
      accepted++;
      expect(out.finalStartNode).toBeLessThan(before.finalStartNode);
      expect(out.startSec).toBeLessThan(before.startSec);
      expect(out.endSec).toBe(before.endSec);
      expect(out.finalEndNode).toBe(before.finalEndNode);
      expect(out.payoffSec).toBe(before.payoffSec);
      expect(out.hookStartSec).toBe(before.hookStartSec);
      expect(out.hookEndSec).toBe(before.hookEndSec);
      expect(out.verdict).toBe(before.verdict);
      expect(out.boundaryConfidence).toBe("segment");
      expect(out.shortMoment).toBe(out.endSec - out.startSec < cfg.targetMinSec);
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it("returns a new clip and leaves the caller's copy alone", () => {
    const n = nodes(40);
    const before = clip(n, "c0", 15, 18);
    const out = clipOf(applyStartExtension(before, n, 10, cfg, null, []));
    expect(out).not.toBe(before);
    expect(before.finalStartNode).toBe(15);
    expect(before.startSec).toBe(n[15].start);
    expect(out.finalStartNode).toBe(10);
  });

  it("recomputes shortMoment against the new duration", () => {
    const n = nodes(40);
    const wasShort = { ...clip(n, "c0", 15, 16), shortMoment: true }; // 30-34s, 4s clip
    // node 8 (t=16) is 14s back - inside the 20s default window
    const out = clipOf(applyStartExtension(wasShort, n, 8, cfg, null, []));
    expect(out.endSec - out.startSec).toBeGreaterThanOrEqual(cfg.targetMinSec);
    expect(out.shortMoment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extendClipStarts - the stage. Pure and synchronous: no model call anywhere
// in this function, so there is no "outage" or "truncation" failure mode to
// test - the only inputs are the clips, the flags map arc-audit produced, and
// config, and the only outputs are the (possibly widened) clips and telemetry.
// ---------------------------------------------------------------------------

const live = loadAnalyzeConfig({
  ARC_AUDIT: "on",
  START_EXTENSION: "on",
  SCENE_GAP_SEC: "8",
  START_EXTENSION_WINDOW_SEC: "20",
});

const flagsFor = (entries: Array<[string, ArcFlags]>): Map<string, ArcFlags> => new Map(entries);

const okFlag = (): ArcFlags => ({
  entry: { ok: true },
  exit: { ok: true },
  standalone: { ok: true },
});

const pointerFlag = (fixStartNode: number): ArcFlags => ({
  entry: { ok: false, defect: "dangling_reference", fixStartNode },
  exit: { ok: true },
  standalone: { ok: true },
});

describe("extendClipStarts - the killswitch", () => {
  it("no-ops when both flags are off", () => {
    const n = nodes(40);
    const input = [clip(n, "c0", 15, 18)];
    const flags = flagsFor([["c0", pointerFlag(5)]]);
    const r = extendClipStarts(input, flags, n, loadAnalyzeConfig({}));
    expect(r.clips).toBe(input);
    expect(r.telemetry).toEqual({ eligible: 0, applied: 0, refused: 0, refusedBy: {}, secondsGained: 0 });
  });

  it("no-ops when only arcAuditEnabled is on", () => {
    const n = nodes(40);
    const input = [clip(n, "c0", 15, 18)];
    const flags = flagsFor([["c0", pointerFlag(5)]]);
    const onlyAudit = loadAnalyzeConfig({ ARC_AUDIT: "on" });
    const r = extendClipStarts(input, flags, n, onlyAudit);
    expect(r.clips).toBe(input);
  });

  // THE PROPERTY THE SPEC NAMES EXPLICITLY: "the dependency must be visible in
  // code, not implied". A non-empty, perfectly legal flags map is handed in
  // alongside startExtensionEnabled alone - if this stage only checked its OWN
  // flag, it would apply the pointer right here. It must not, because
  // arcAuditEnabled is off.
  it("no-ops when only startExtensionEnabled is on, even with a legal pointer already in hand", () => {
    const n = nodes(40);
    const input = [clip(n, "c0", 15, 18)];
    const flags = flagsFor([["c0", pointerFlag(5)]]);
    const onlyStart = loadAnalyzeConfig({ START_EXTENSION: "on", SCENE_GAP_SEC: "8" });
    expect(onlyStart.arcAuditEnabled).toBe(false);
    const r = extendClipStarts(input, flags, n, onlyStart);
    expect(r.clips).toBe(input);
    expect(r.telemetry.eligible).toBe(0);
  });

  it("no-ops on an empty clip list", () => {
    const n = nodes(40);
    const r = extendClipStarts([], flagsFor([]), n, live);
    expect(r.clips).toEqual([]);
  });
});

describe("extendClipStarts - eligibility and application", () => {
  it("counts only clips whose flags carry a gated pointer as eligible", () => {
    const n = nodes(60);
    const withPointer = clip(n, "a", 15, 18);
    const okNoPointer = clip(n, "b", 25, 28); // entry.ok true - not flagged at all
    const noFlagAtAll = clip(n, "c", 35, 38); // never audited
    const flags = flagsFor([
      ["a", pointerFlag(10)],
      ["b", okFlag()],
    ]);
    const r = extendClipStarts([withPointer, okNoPointer, noFlagAtAll], flags, n, live);
    expect(r.telemetry.eligible).toBe(1);
    expect(r.telemetry.applied).toBe(1);
    expect(r.clips[0].finalStartNode).toBe(10);
    // untouched clips come back as the SAME objects, not rebuilt copies
    expect(r.clips[1]).toBe(okNoPointer);
    expect(r.clips[2]).toBe(noFlagAtAll);
  });

  it("applies a legal pointer and reports secondsGained", () => {
    const n = nodes(60);
    const a = clip(n, "a", 15, 18);
    const flags = flagsFor([["a", pointerFlag(10)]]);
    const r = extendClipStarts([a], flags, n, live);
    expect(r.clips[0].finalStartNode).toBe(10);
    expect(r.clips[0].startSec).toBe(n[10].start);
    expect(r.telemetry).toEqual({
      eligible: 1,
      applied: 1,
      refused: 0,
      refusedBy: {},
      secondsGained: a.startSec - n[10].start,
    });
    // the verdict's own startNode is NOT rewritten - finalStartNode is the
    // shipped truth, same policy as end-extension (engine-notes §6)
    expect(r.clips[0].verdict.startNode).toBe(15);
  });

  it("counts a pointer the gates refuse as refused, and keeps the clip byte-identical", () => {
    const n = nodes(60);
    const a = clip(n, "a", 20, 23); // t=40
    const flags = flagsFor([["a", pointerFlag(0)]]); // t=0, 40s back - past the 20s window
    const r = extendClipStarts([a], flags, n, live);
    expect(r.clips[0]).toBe(a);
    expect(r.telemetry).toEqual({
      eligible: 1,
      applied: 0,
      refused: 1,
      refusedBy: { outside_window: 1 },
      secondsGained: 0,
    });
  });

  it("refuses a widen that would collide with another clip actually shipping", () => {
    const n = nodes(60);
    const a = clip(n, "a", 20, 23); // 40-48s
    const neighbour = clip(n, "b", 16, 22); // 32-46s - widening a to 15 (30s) collides
    const flags = flagsFor([["a", pointerFlag(15)]]);
    const r = extendClipStarts([a, neighbour], flags, n, live);
    expect(r.clips[0]).toBe(a); // refused, unchanged
    expect(r.telemetry.refusedBy).toEqual({ nms_collision: 1 });
  });
});

// ---------------------------------------------------------------------------
// The teaser region, wired for real: detectTeaserRegion runs INSIDE
// extendClipStarts (it takes no injectable region, unlike applyStartExtension
// above), so this is the one place proving that wiring rather than the
// gate-level contract alone. Nodes 0/1/2 each carry a distinct five-word
// sentence reproduced verbatim at nodes 40/41/42, 80s away - well past
// TEASER_MIN_GAP_SEC (60s) - which is exactly the shape teaser.ts's own
// module doc describes as the real montage: a run of opening sentences each
// reproducing distant speech. teaserMinHits defaults to 3, so three hits (not
// more) are the minimum that forms a region at all.
// ---------------------------------------------------------------------------

function nodesWithTeaser(): SentenceNode[] {
  const n = nodes(60);
  const hitTexts = [
    "alpha bravo charlie delta echo",
    "foxtrot golf hotel india juliet",
    "kilo lima mike november oscar",
  ];
  for (let i = 0; i < 3; i++) {
    n[i] = { ...n[i], text: hitTexts[i] };
    n[i + 40] = { ...n[i + 40], text: hitTexts[i] };
  }
  return n;
}

describe("extendClipStarts - the teaser region, detected for real", () => {
  it("refuses a pointer landing inside a really-detected teaser region", () => {
    const n = nodesWithTeaser();
    const c = clip(n, "c0", 15, 18); // t=30
    // node 10 (t=20) sits inside the region this transcript actually produces
    // (region ends at lastHitEnd(6) + TEASER_REGION_PAD_SEC(15) = 21s)
    const flags = flagsFor([["c0", pointerFlag(10)]]);
    const r = extendClipStarts([c], flags, n, live);
    expect(r.clips[0]).toBe(c);
    expect(r.telemetry.refusedBy).toEqual({ outside_window: 1 });
  });

  it("accepts a pointer just outside the same detected region", () => {
    const n = nodesWithTeaser();
    const c = clip(n, "c0", 15, 18);
    const flags = flagsFor([["c0", pointerFlag(11)]]); // t=22, outside the 21s region
    const r = extendClipStarts([c], flags, n, live);
    expect(r.clips[0].finalStartNode).toBe(11);
    expect(r.telemetry.applied).toBe(1);
  });
});

describe("the start-extension knob", () => {
  // Exact literal "on", the same discipline as ARC_AUDIT/END_EXTENSION. This
  // stage moves a shipped boundary, so a stray "true" or "1" in an .env must
  // not arm it.
  it("arms the stage only on the exact literal on", () => {
    expect(loadAnalyzeConfig({ START_EXTENSION: "on" }).startExtensionEnabled).toBe(true);
    expect(loadAnalyzeConfig({ START_EXTENSION: "true" }).startExtensionEnabled).toBe(false);
    expect(loadAnalyzeConfig({ START_EXTENSION: "1" }).startExtensionEnabled).toBe(false);
    expect(loadAnalyzeConfig({}).startExtensionEnabled).toBe(false);
  });

  it("defaults startExtensionEnabled to off, independent of arcAuditEnabled", () => {
    const auditOnly = loadAnalyzeConfig({ ARC_AUDIT: "on" });
    expect(auditOnly.arcAuditEnabled).toBe(true);
    expect(auditOnly.startExtensionEnabled).toBe(false);
  });
});
