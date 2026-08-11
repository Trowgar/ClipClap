import { describe, expect, it, vi } from "vitest";
import {
  applyExtension,
  extendClipEnds,
  extensionMaxOutputTokens,
  extensionWindow,
} from "../analyze-v2/end-extension";
import { EXTENSION_SYSTEM, buildExtensionUser } from "../analyze-v2/prompts";
import { END_EXTENSION_SCHEMA } from "../analyze-v2/schemas";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import type { AnalyzeConfig } from "../analyze-v2/config";
import type { ExtensionAttempt } from "../analyze-v2/end-extension";
import type { ArcFlags, CriticVerdict, SentenceNode, SnappedClip } from "../analyze-v2/types";

// ---------------------------------------------------------------------------
// THE CONTRACT THIS FILE EXISTS TO HOLD
//
// The stage can only ever IMPROVE the set it was handed. No failure mode - not
// an outage, not a refusal, not a malformed payload, not a defect in the module
// itself - returns a clip that is worse, shorter, missing or reordered, and none
// of them fails the job. An end moves forward or it does not move.
//
// Every test below is a way of stating that, and the gates are asserted BY THE
// REASON they fire, never by a bare refusal: a test that only proves "this was
// turned down" passes just as happily when the wrong gate turned it down.
//
// ---------------------------------------------------------------------------
// HOW THE SUITE WAS BUILT, for whoever changes it
//
// It was built by attacking itself. The ten cases the plan sketched were written
// before the code existed, and of the 29 mutations of this module and its knobs
// that ran against them, NINETEEN survived - including deleting the opaque-node
// gate, the clean-end gate and the maxSec gate outright. Every case below names
// the mutation it kills, because a gate nobody can prove fires is worse than no
// gate: it buys false confidence.
//
// Two warnings for whoever runs the next matrix over this file.
//
// A mutant that FAILS TO APPLY is an error, never a kill. One here had its
// find-string go stale against a return that grew multi-line, and a summary
// that subtracted survivors from the total published it as a kill. Check the
// error count before trusting the score.
//
// TWO mutations are EQUIVALENT, both run and confirmed to survive rather than
// assumed to:
//   - starting the window loop at `from` rather than `from + 1`. `last` is
//     already `from` and the deadline is at or after nodes[from].end for any
//     non-negative window, so the extra iteration can only re-assign what is
//     there (checked over 20000 random graphs).
//   - carrying the accumulated counters out of the catch instead of resetting
//     them. Nothing between the first counter and the end of the map can throw,
//     so the two returns are identical today; the reset is what keeps that true
//     if something throwing is ever added there.
// Three OTHERS were called equivalent and were not. The in-graph gate is killed
// below by a clip carrying a stale end node. The `: null` branch that had no
// effect is gone entirely now that the seconds arithmetic is snap's endSecFor.
// And applyExtension's maxSec gate was called a dead backstop for exactly as
// long as the window BROKE on maxSec - the same edit that made the gate
// unreachable also lost every legal end behind an over-long node, and the fix
// made the gate reachable again. A gate that looks unreachable is worth
// re-deriving rather than filing: the argument for its deadness was the bug.
// ---------------------------------------------------------------------------

const cfg = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", END_EXTENSION_WINDOW_SEC: "25" });

/** Window wide enough that maxSec, not the window, is the binding gate. */
const cfgWide = loadAnalyzeConfig({
  SCENE_GAP_SEC: "8",
  END_EXTENSION_WINDOW_SEC: "1000",
});

function nodes(count: number, holeBefore?: number): SentenceNode[] {
  const out: SentenceNode[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i === holeBefore) t += 12;
    out.push({
      index: i,
      start: t,
      end: t + 2,
      text: `line ${i}.`,
      hasWords: true,
      trailingStrength: 1,
      leadingStrength: 1,
    });
    t += 2;
  }
  return out;
}

function verdict(): CriticVerdict {
  return {
    id: "c0", keep: true, score: 0.8, grounded: true, selfContained: true,
    startNode: 2, payoffNode: 5, endNode: 5, hookStartNode: 3, hookEndNode: 5,
    title: "t", description: "d", titleEvidenceNodes: [4],
    descriptionEvidenceNodes: [4], language: "en",
  };
}

function clip(n: SentenceNode[]): SnappedClip {
  return {
    verdict: verdict(),
    startSec: n[2].start, endSec: n[5].end,
    finalStartNode: 2, finalEndNode: 5,
    hookStartSec: n[3].start, hookEndSec: n[5].end,
    payoffSec: n[5].end, shortMoment: false,
  };
}

/** applyExtension's answer as ONE comparable value: the gate that refused, or
 *  "accepted". Every refusal below is asserted through this, so a case cannot
 *  quietly pass because a different gate turned the proposal down - which is
 *  exactly how the plan's own maxSec case passed while maxSec was deletable. */
const verdictOf = (a: ExtensionAttempt): string => (a.ok ? "accepted" : a.reason);

const clipOf = (a: ExtensionAttempt): SnappedClip => {
  if (!a.ok) throw new Error(`expected an accepted extension, got "${a.reason}"`);
  return a.clip;
};

describe("extensionWindow", () => {
  it("stops at the scene boundary even when the time window reaches further", () => {
    const n = nodes(20, 8);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(7);
  });

  it("stops at the time window when no scene boundary intervenes", () => {
    const n = nodes(40);
    const w = extensionWindow(clip(n), n, cfg);
    expect(n[w.lastNode].end - n[5].end).toBeLessThanOrEqual(25);
    expect(w.lastNode).toBeGreaterThan(5);
  });

  it("is empty when the clip already ends at the scene boundary", () => {
    const n = nodes(20, 6);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(5);
  });

  // Kills `end > deadline` -> `end >= deadline`. A node ending exactly ON the
  // limit is inside it - "may look 25s past the end" reads inclusive. Nothing
  // measured hangs on the 0.0s difference, but the branch has to be pinned so
  // it cannot flip silently while the window knob is being tuned.
  it("admits a node that ends exactly on the deadline", () => {
    const n = nodes(40);
    const tight = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", END_EXTENSION_WINDOW_SEC: "24" });
    expect(n[17].end - n[5].end).toBe(24);
    expect(extensionWindow(clip(n), n, tight).lastNode).toBe(17);
  });

  // Kills `break` -> `continue`. A clip is a CONTIGUOUS range: node 9 cannot be
  // reached without also playing node 8, so a single node whose end overruns
  // the deadline closes the window for everything after it. `continue` skips
  // the long node and keeps collecting short ones behind it, which offers the
  // model an end that drags the clip 80s past a 25s window. Ends can overrun
  // their successor's start for real - word timings nest, see the `max, not
  // last` comment on `end:` in buildSentenceGraph.
  it("stops at a node that overruns the deadline, even when shorter ones follow", () => {
    const n = nodes(40);
    n[8] = { ...n[8], end: 100 };
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(7);
  });

  // Kills a hardcoded window: the knob has to reach the loader, not a literal.
  it("honours cfg.endExtensionWindowSec rather than a built-in", () => {
    const n = nodes(40);
    const narrow = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", END_EXTENSION_WINDOW_SEC: "9" });
    expect(extensionWindow(clip(n), n, narrow).lastNode).toBe(9);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(17);
  });

  // The window is measured from the end node's LAST WORD, not from clip.endSec,
  // so the tail hold is not charged against it: the hold is silence, and "25
  // seconds further" has to mean 25 seconds of further material. Node 18 here
  // ends inside the tail hold's worth of slack - admitted by the wrong
  // reference point, refused by the right one.
  it("measures the window from the last word, not from the tail-hold silence", () => {
    const n = nodes(40);
    n[18] = { ...n[18], end: 37.2 };
    const held = { ...clip(n), endSec: n[5].end + cfg.tailHoldSec };
    expect(n[18].end).toBeGreaterThan(n[5].end + cfg.endExtensionWindowSec);
    expect(n[18].end).toBeLessThan(held.endSec + cfg.endExtensionWindowSec);
    expect(extensionWindow(held, n, cfg).lastNode).toBe(17);
  });

  // The ceiling invariant, from the other direction: lastNode may never land
  // BEFORE the clip's own end, or the "window" would be an instruction to
  // shorten. A zero window is the tightest case and must read as "no extension
  // possible", not as a negative one.
  it("never reaches back before the clip's own end, even with a zero window", () => {
    const zero = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", END_EXTENSION_WINDOW_SEC: "0" });
    for (const n of [nodes(40), nodes(20, 6), nodes(20, 8), nodes(7)]) {
      for (const c of [cfg, zero, cfgWide]) {
        expect(extensionWindow(clip(n), n, c).lastNode).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

describe("applyExtension", () => {
  it("accepts a legal forward move and returns the widened clip", () => {
    const n = nodes(40);
    const out = clipOf(applyExtension(clip(n), n, 8, cfg));
    expect(out.finalEndNode).toBe(8);
    expect(out.endSec).toBeGreaterThan(n[5].end);
  });

  it("refuses a move that shortens the clip", () => {
    const n = nodes(40);
    expect(verdictOf(applyExtension(clip(n), n, 4, cfg))).toBe("not_forward");
  });

  it("refuses a no-op", () => {
    const n = nodes(40);
    expect(verdictOf(applyExtension(clip(n), n, 5, cfg))).toBe("not_forward");
  });

  it("refuses a move across a scene boundary", () => {
    const n = nodes(20, 8);
    expect(verdictOf(applyExtension(clip(n), n, 10, cfg))).toBe("outside_window");
  });

  it("refuses an index outside the graph", () => {
    const n = nodes(40);
    expect(verdictOf(applyExtension(clip(n), n, 999, cfg))).toBe("outside_graph");
  });

  // Kills dropping Number.isInteger. A model that answers 8.5 - or a NaN from a
  // parsed empty string - must be refused, not indexed into the graph: nodes[8.5]
  // is undefined and every gate after it reads a property off it.
  it("refuses a proposal that is not a whole node index", () => {
    const n = nodes(40);
    for (const bad of [8.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(verdictOf(applyExtension(clip(n), n, bad, cfg))).toBe("not_an_index");
    }
  });

  // Kills dropping the in-graph gate, which the window gate does NOT cover.
  // Paired with the forward-only gate, this is the only thing proving the
  // CLIP's own end node is real before extensionWindow reads
  // nodes[finalEndNode].end - without it a stale end node throws a TypeError
  // out of a stage Task 3 calls once per shipped clip and that must never throw.
  it("refuses a clip whose own end node is not a real index, rather than throwing", () => {
    const n = nodes(40);
    const stale = { ...clip(n), finalEndNode: 500 };
    expect(verdictOf(applyExtension(stale, n, 501, cfg))).toBe("outside_graph");
    expect(verdictOf(applyExtension(stale, n, 30, cfg))).toBe("not_forward");
    // and from below, which the gate pairing above proves nothing about: each
    // of these reaches undefined inside extensionWindow - -1 and NaN on
    // nodes[from].end, 2.5 inside sceneEndAfter - and a stage documented as
    // never throwing has to answer null instead
    for (const bad of [-1, 2.5, Number.NaN]) {
      expect(verdictOf(applyExtension({ ...clip(n), finalEndNode: bad }, n, 3, cfg))).toBe(
        "clip_end_unusable"
      );
    }
  });

  // The lower bound is `< 0`, not `<= 0`: a clip ending on the FIRST node is a
  // real clip and must still be extendable. Nothing else in the suite would
  // notice that gate tightening by one.
  it("still extends a clip that ends on node 0", () => {
    const n = nodes(40);
    const first: SnappedClip = {
      ...clip(n),
      startSec: n[0].start, endSec: n[0].end,
      finalStartNode: 0, finalEndNode: 0,
      hookStartSec: n[0].start, hookEndSec: n[0].end, payoffSec: n[0].end,
    };
    expect(clipOf(applyExtension(first, n, 1, cfg)).finalEndNode).toBe(1);
  });

  // Kills `> nodes.length - 1` -> `>=`. The last node in the graph is a legal
  // end - it is where every clip at the end of a video has to stop - and the
  // bounds gate must reject only what is genuinely outside. Also kills dropping
  // endSecFor's last-node guard (nodes[len] is undefined and reading .start off
  // it throws) and tailHoldSec -> 0: with nothing after it, the last node gets
  // the full tail hold and no bleed cap.
  it("accepts the last node in the graph and holds the full tail there", () => {
    const n = nodes(10);
    const out = clipOf(applyExtension(clip(n), n, 9, cfg));
    expect(out.finalEndNode).toBe(9);
    expect(out.endSec).toBeCloseTo(n[9].end + cfg.tailHoldSec, 6);
  });

  // Kills `> lastNode` -> `>= lastNode`, on BOTH branches of the window, which
  // is the pair the scene rail's contract turns on: the window is the tighter
  // of the scene cut and the clock, and whichever one is tighter must be
  // reachable and the node past it refused. If only one branch were covered the
  // other could disappear without a red test.
  it("accepts exactly the last node the scene allows and refuses the next", () => {
    const n = nodes(20, 8);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(7);
    expect(clipOf(applyExtension(clip(n), n, 7, cfg)).finalEndNode).toBe(7);
    expect(verdictOf(applyExtension(clip(n), n, 8, cfg))).toBe("outside_window");
  });

  it("accepts exactly the last node the clock allows and refuses the next", () => {
    const n = nodes(40);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(17);
    expect(clipOf(applyExtension(clip(n), n, 17, cfg)).finalEndNode).toBe(17);
    expect(verdictOf(applyExtension(clip(n), n, 18, cfg))).toBe("outside_window");
  });

  // The tightest crossing: the node immediately after the cut. A window loop
  // that ran one index too far would hand the clip the first line of an
  // unrelated scene, which is the single thing the scene rail exists to stop.
  it("refuses the very first node on the far side of a cut", () => {
    const n = nodes(20, 6);
    expect(verdictOf(applyExtension(clip(n), n, 6, cfg))).toBe("outside_window");
  });

  // Kills dropping the hasWords gate. trailingStrength stays 1 so the node
  // still passes isCleanEnd - opacity has to be the ONLY reason this is
  // refused. An opaque node's timings are segment-level, not word-level (music,
  // laughter, crosstalk), so ending a clip on one puts the boundary at a coarse
  // Whisper edge; snapNodes walks BACK off opaque ends for the same reason, and
  // this stage must not walk onto one.
  it("refuses an opaque node as the new end", () => {
    const n = nodes(40);
    n[8] = { ...n[8], hasWords: false };
    expect(verdictOf(applyExtension(clip(n), n, 8, cfg))).toBe("opaque_end");
  });

  // Kills dropping the isCleanEnd gate. Node 8 keeps its words, so the clean-end
  // test is the only thing that can refuse it: a weak trailing boundary followed
  // by a node that does not open cleanly is a mid-clause cut ("...искала ты его
  // потому,"), and extending onto one trades a short clip for a broken one.
  it("refuses an end that leaves the sentence open", () => {
    const n = nodes(40);
    n[8] = { ...n[8], trailingStrength: 0.2 };
    n[9] = { ...n[9], leadingStrength: 0.2, text: "and then." };
    expect(verdictOf(applyExtension(clip(n), n, 8, cfg))).toBe("no_clean_end");
    // and the node before it, which IS a clean end, is still accepted - the
    // gate must refuse this node, not the whole neighbourhood
    expect(clipOf(applyExtension(clip(n), n, 7, cfg)).finalEndNode).toBe(7);
  });

  // maxSec is a ceiling on the end INDEX, so it lives in the window and the
  // refusal past it is "outside_window" - the node is never offered in the first
  // place. A clip landing EXACTLY on the cap is inside it. Only a time window
  // wide enough to let the clip reach 90s tests this at all; the plan's own
  // maxSec case used a 25s window, so its proposal was already out of the window
  // and the length cap could be deleted while it stayed green.
  it("stops the window at maxSec, accepting a clip that lands exactly on it", () => {
    const n = nodes(200);
    const c = clip(n);
    expect(extensionWindow(c, n, cfgWide).lastNode).toBe(46);
    expect(clipOf(applyExtension(c, n, 46, cfgWide)).endSec - c.startSec).toBe(
      cfgWide.maxSec
    );
    expect(verdictOf(applyExtension(c, n, 47, cfgWide))).toBe("outside_window");
  });

  // ---------------------------------------------------------------------------
  // The long-clip ceiling (spec 2026-08-10 task 5, item 4). `blessed` defaults
  // to `false` on both extensionWindow and applyExtension, so every test in
  // this file that predates task 5 (none of which passes it) already proves
  // today's ceiling is unchanged. UNLIKE start-extension.ts's own gate, this
  // one is genuinely reachable in production: end-extension's self-motivated
  // path (`endExtensionEnabled`) offers every clip with a non-empty window
  // regardless of its arc-audit flags, so a blessed clip - including one the
  // long-clip policy already shipped wide - can legally reach here.
  // ---------------------------------------------------------------------------
  const longCfg = loadAnalyzeConfig({
    SCENE_GAP_SEC: "8",
    END_EXTENSION_WINDOW_SEC: "1000",
    LONG_CLIPS: "on",
    LONG_CLIP_MAX_SEC: "150",
  });

  it("keeps today's 90s ceiling when the clip is not blessed, even with LONG_CLIPS on", () => {
    const n = nodes(200);
    const c = clip(n);
    expect(extensionWindow(c, n, longCfg).lastNode).toBe(46); // same 46 as cfgWide above
    expect(clipOf(applyExtension(c, n, 46, longCfg)).endSec - c.startSec).toBe(longCfg.maxSec);
    expect(verdictOf(applyExtension(c, n, 47, longCfg))).toBe("outside_window");
  });

  it("raises the window and the gate to longClipMaxSec for a blessed clip", () => {
    const n = nodes(200);
    const c = clip(n);
    const window = extensionWindow(c, n, longCfg, true);
    expect(window.lastNode).toBe(76); // n[76].end(154) - c.startSec(4) = 150
    expect(window.lastNode).toBeGreaterThan(46); // strictly past the unblessed ceiling
    expect(clipOf(applyExtension(c, n, 76, longCfg, true)).endSec - c.startSec).toBe(
      longCfg.longClipMaxSec
    );
    expect(verdictOf(applyExtension(c, n, 77, longCfg, true))).toBe("outside_window");
    // and the SAME node 77 proposal, without `blessed`, is refused for the
    // exact same reason it always was - the ceiling change is per-call, not
    // a global relaxation of maxSec
    expect(verdictOf(applyExtension(c, n, 77, longCfg))).toBe("outside_window");
  });

  // maxSec SKIPS where the deadline BREAKS, and this case is why. The shipped
  // clip is cut at its END node, so an intervening node never lengthens it: node
  // 40 carries a word running to 300s while node 41 closes at 84s, comfortably
  // inside the 90s cap. Breaking there made the window stricter than the gate it
  // mirrors - the clip lost every end from 40 to 46 and, when the over-long node
  // fell early enough, dropped out of the prompt altogether.
  //
  // Built by hand and it has to be: no shipped clip on any of the four fixtures
  // ends on a node whose nested end overruns its successor, so the harness is
  // blind to this by construction (engine-notes §5).
  it("steps over a node that overruns maxSec and keeps the ends behind it", () => {
    const n = nodes(200);
    n[40] = { ...n[40], end: 300 };
    const c = clip(n);
    expect(n[41].end - c.startSec).toBeLessThan(cfgWide.maxSec);
    expect(extensionWindow(c, n, cfgWide).lastNode).toBe(46);
    expect(clipOf(applyExtension(c, n, 41, cfgWide)).finalEndNode).toBe(41);
    expect(clipOf(applyExtension(c, n, 46, cfgWide)).finalEndNode).toBe(46);
    // and the one node that really would breach the cap is refused by the gate,
    // BY ITS OWN REASON - it is inside the offered run, not past the ceiling
    expect(verdictOf(applyExtension(c, n, 40, cfgWide))).toBe("too_long");
  });

  // The same shape one step worse: the over-long node sits immediately after the
  // clip's end, so a window that stopped there would report "nothing follows"
  // and the clip would never reach the prompt at all. Nine legal ends, measured
  // on the reviewer's construction, turn into zero.
  it("still offers a clip whose very next node overruns maxSec", () => {
    const n = nodes(60);
    n[35] = { ...n[35], end: 92 };
    const c: SnappedClip = {
      ...clip(n),
      startSec: n[0].start,
      endSec: n[34].end,
      finalStartNode: 0,
      finalEndNode: 34,
      hookStartSec: n[0].start,
      hookEndSec: n[34].end,
      payoffSec: n[34].end,
    };
    expect(n[35].end).toBeLessThan(n[34].end + cfg.endExtensionWindowSec); // inside the clock
    expect(n[35].end - c.startSec).toBeGreaterThan(cfg.maxSec); // over the cap
    expect(extensionWindow(c, n, cfg).lastNode).toBe(44);
    expect(clipOf(applyExtension(c, n, 36, cfg)).endSec).toBe(n[36].end);
    expect(verdictOf(applyExtension(c, n, 35, cfg))).toBe("too_long");
  });

  // Kills dropping endSecFor's bleed cap. The tail hold is silence to breathe
  // in, never a licence to play the next speaker's first word. Here node 9
  // starts the instant node 8 ends, so the whole 0.3s hold has to be given up.
  it("never lets the tail hold bleed into the next line", () => {
    const n = nodes(40);
    const out = clipOf(applyExtension(clip(n), n, 8, cfg));
    expect(out.endSec).toBe(n[9].start);
  });

  // Kills dropping endSecFor's last-word clamp. Word timings nest, so a node
  // can end AFTER its successor starts; the bleed cap must never then cut the
  // last word of the very line the clip is being extended to.
  it("never cuts the last word of the new end node", () => {
    const n = nodes(40);
    n[8] = { ...n[8], end: 19 };
    const out = clipOf(applyExtension(clip(n), n, 8, cfg));
    expect(out.endSec).toBe(19);
  });

  // Kills mutating the input in place. The plan's "keeps the payoff, hook and
  // start untouched" compared the RESULT against an object that in-place
  // mutation had already changed, so it passed for a function that overwrites
  // its argument; the sweep below replaces it. Clips are handed around by
  // reference between stages - an acceptance must not reach back into the
  // caller's copy.
  it("returns a new clip and leaves the caller's copy alone", () => {
    const n = nodes(40);
    const before = clip(n);
    const out = clipOf(applyExtension(before, n, 8, cfg));
    expect(out).not.toBe(before);
    expect(before.finalEndNode).toBe(5);
    expect(before.endSec).toBe(n[5].end);
    expect(out.finalEndNode).toBe(8);
  });

  // The never-shorten rule in SECONDS, not just in node index. A later node can
  // still END earlier when word timings nest - node 5 here runs to 16.0 because
  // one of its words does, while node 6 ends at 14.0 - and a proposal that
  // moves the index forward while moving the clock backward passes every index
  // gate. It would cut 2s off a clip that is already too short, and here it
  // would drop the payoff (16.0) outside the clip entirely.
  it("refuses a move that would end the clip earlier in seconds", () => {
    const n = nodes(40);
    n[5] = { ...n[5], end: 16 };
    const c = clip(n);
    expect(c.endSec).toBe(16);
    expect(verdictOf(applyExtension(c, n, 6, cfg))).toBe("no_gain");
  });

  // The index gate is NOT made redundant by the seconds gate, and this is the
  // case that proves it. Node 3 runs to 30.0 because one of its words does, so
  // proposing it moves the end BACKWARD by two nodes while moving the clock
  // forward by 18s: it passes the seconds gate on the way out. The result would
  // be a clip whose node range no longer contains its own titleEvidenceNodes
  // (node 4 here), which is the copy-degrading shape this stage is built never
  // to produce (engine-notes §6, "boundaries are code-owned").
  it("refuses an earlier node even when its nested timings would end later", () => {
    const n = nodes(40);
    n[3] = { ...n[3], end: 30 };
    const c = clip(n);
    expect(c.verdict.titleEvidenceNodes).toContain(4);
    expect(verdictOf(applyExtension(c, n, 3, cfg))).toBe("not_forward");
  });

  // The same gate at its own boundary: proposing the node the clip already ends
  // on is a no-op, even when re-running the tail-hold arithmetic would land
  // 0.3s later than the endSec the clip is carrying. Silence past the last word
  // is not an extension, and a stage that reported one here would inflate every
  // "clips extended" number Task 3 measures itself by.
  it("refuses the current end node even when the tail hold would grow", () => {
    const n = nodes(20, 6);
    const c = clip(n);
    expect(n[6].start - n[5].end).toBeGreaterThan(cfg.tailHoldSec);
    expect(verdictOf(applyExtension(c, n, 5, cfg))).toBe("not_forward");
  });

  // The other half of the seconds rule: a proposal that moves the index forward
  // but adds no time is a no-op and is refused like any other. Node 6 here is
  // nested entirely inside the clip's existing span (11.0-12.0, clip ends at
  // 12.0) and node 7 opens the instant it closes, so accepting it would widen
  // the node range while changing nothing a viewer hears.
  it("refuses a move that adds no seconds at all", () => {
    const n = nodes(40);
    n[6] = { ...n[6], start: 11, end: 12 };
    n[7] = { ...n[7], start: 12 };
    const c = clip(n);
    expect(c.endSec).toBe(12);
    expect(verdictOf(applyExtension(c, n, 6, cfg))).toBe("no_gain");
  });

  // boundaryConfidence is derived from the PAYOFF's opacity and the end snap
  // landed on, and this stage moves neither into opacity: it refuses opaque
  // ends outright and never touches the payoff, so the value passes through.
  // The tempting edit is to recompute it beside shortMoment and endsOnQuestion
  // three lines away - and that would silently promote a segment-confidence
  // clip to word-confidence, in a field that ships as the `_boundaryConfidence`
  // diagnostic.
  it("carries boundaryConfidence through untouched - the end moved, the payoff did not", () => {
    const n = nodes(40);
    const segment = { ...clip(n), boundaryConfidence: "segment" as const };
    expect(clipOf(applyExtension(segment, n, 8, cfg)).boundaryConfidence).toBe("segment");
  });

  // The gate refuses opaque nodes as the NEW end; it says nothing about the end
  // a clip arrives with. snap keeps an opaque end whenever the payoff is opaque
  // itself - 2 of the 12 shipped sitcom-friends clips end that way - and moving
  // such a clip onto a word-bearing end is the one case where this stage makes a
  // boundary sharper rather than later. boundaryConfidence still reads "segment"
  // afterwards, and correctly: it describes the payoff, which has not moved.
  it("extends a clip OFF an opaque end onto a word-bearing one", () => {
    const n = nodes(40);
    n[5] = { ...n[5], hasWords: false, text: "[laughter]" };
    const opaqueEnd = { ...clip(n), boundaryConfidence: "segment" as const };
    const out = clipOf(applyExtension(opaqueEnd, n, 8, cfg));
    expect(out.finalEndNode).toBe(8);
    expect(out.boundaryConfidence).toBe("segment");
  });

  // The whole-object invariant, swept rather than spot-checked: across every
  // proposal this fixture admits, an accepted extension moves the end and
  // NOTHING else. Copy is grounded against [finalStartNode, finalEndNode]
  // before this stage runs, so widening that range is safe and moving anything
  // else in it is not (engine-notes §6, "boundaries are code-owned").
  it("moves the end forward and changes nothing else, for every legal proposal", () => {
    const n = nodes(40);
    const before = { ...clip(n), boundaryConfidence: "segment" as const };
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const attempt = applyExtension(before, n, i, cfg);
      if (!attempt.ok) continue;
      const out = attempt.clip;
      accepted++;
      expect(out.finalEndNode).toBeGreaterThan(before.finalEndNode);
      expect(out.endSec).toBeGreaterThan(before.endSec);
      expect(out.startSec).toBe(before.startSec);
      expect(out.finalStartNode).toBe(before.finalStartNode);
      expect(out.payoffSec).toBe(before.payoffSec);
      expect(out.hookStartSec).toBe(before.hookStartSec);
      expect(out.hookEndSec).toBe(before.hookEndSec);
      expect(out.verdict).toBe(before.verdict);
      expect(out.boundaryConfidence).toBe("segment");
      // the two fields that DO move are the two derived from the end
      expect(out.shortMoment).toBe(out.endSec - out.startSec < cfg.targetMinSec);
      expect(out.endsOnQuestion).toBe(false);
    }
    expect(accepted).toBe(12); // nodes 6..17, the whole window
  });

  // shortMoment is a verdict on LENGTH and this stage changes the length. It is
  // persisted onto the highlight (index.ts, toHighlight), so a carried-forward
  // `true` would file a 14s clip as a fragment.
  it("recomputes shortMoment against the new duration", () => {
    const n = nodes(40);
    const wasShort = { ...clip(n), shortMoment: true };
    const out = clipOf(applyExtension(wasShort, n, 8, cfg));
    expect(out.endSec - out.startSec).toBeGreaterThanOrEqual(cfg.targetMinSec);
    expect(out.shortMoment).toBe(false);
  });

  // And it uses snap's definition of short, strictly under the target, so the
  // same clip carries the same flag whichever stage last set its end. A clip
  // landing exactly on the target is not short.
  it("calls a clip exactly on the target not short, as snap does", () => {
    const n = nodes(40);
    const exact = loadAnalyzeConfig({
      SCENE_GAP_SEC: "8",
      END_EXTENSION_WINDOW_SEC: "25",
      CLIP_TARGET_MIN_SEC: "14",
    });
    const out = clipOf(applyExtension(clip(n), n, 8, exact));
    expect(out.endSec - out.startSec).toBe(exact.targetMinSec);
    expect(out.shortMoment).toBe(false);
  });

  // endsOnQuestion names the clip's LAST sentence. Reaching the answer to a
  // question the clip ended on is one of the beats this stage exists to reach,
  // so the flag has to move with the end - in both directions.
  it("recomputes endsOnQuestion from the new end node", () => {
    const n = nodes(40);
    const asked = { ...clip(n), endsOnQuestion: true };
    expect(clipOf(applyExtension(asked, n, 8, cfg)).endsOnQuestion).toBe(false);

    n[8] = { ...n[8], text: "line 8?" };
    expect(clipOf(applyExtension(clip(n), n, 8, cfg)).endsOnQuestion).toBe(true);
  });
});

describe("the end-extension knobs", () => {
  // Exact literal "on", the same discipline as REFRAME_STREAM. This stage is
  // the only one that lets a model move a shipped boundary, so a stray "true"
  // or "1" in an .env must NOT arm it.
  it("arms the stage only on the exact literal on", () => {
    expect(loadAnalyzeConfig({ END_EXTENSION: "on" }).endExtensionEnabled).toBe(true);
    expect(loadAnalyzeConfig({ END_EXTENSION: "true" }).endExtensionEnabled).toBe(false);
    expect(loadAnalyzeConfig({ END_EXTENSION: "1" }).endExtensionEnabled).toBe(false);
    expect(loadAnalyzeConfig({}).endExtensionEnabled).toBe(false);
  });

  it("defaults the window to 25s and reads the override", () => {
    expect(loadAnalyzeConfig({}).endExtensionWindowSec).toBe(25);
    expect(
      loadAnalyzeConfig({ END_EXTENSION_WINDOW_SEC: "40" }).endExtensionWindowSec,
    ).toBe(40);
  });

  // The hint-driven switch (task 4) - independent of END_EXTENSION and its own
  // exact-literal discipline, for the same reason: it also arms a path that
  // renders a model-visible pointer into a real user's job.
  it("arms the hint-driven path only on the exact literal on, independent of END_EXTENSION", () => {
    expect(loadAnalyzeConfig({ END_EXTENSION_HINTS: "on" }).endExtensionHintsEnabled).toBe(true);
    expect(loadAnalyzeConfig({ END_EXTENSION_HINTS: "true" }).endExtensionHintsEnabled).toBe(
      false
    );
    expect(loadAnalyzeConfig({ END_EXTENSION_HINTS: "1" }).endExtensionHintsEnabled).toBe(false);
    expect(loadAnalyzeConfig({}).endExtensionHintsEnabled).toBe(false);
    // Setting one does not arm the other - the separability the spec requires.
    const hintsOnly = loadAnalyzeConfig({ END_EXTENSION_HINTS: "on" });
    expect(hintsOnly.endExtensionEnabled).toBe(false);
    const selfOnly = loadAnalyzeConfig({ END_EXTENSION: "on" });
    expect(selfOnly.endExtensionHintsEnabled).toBe(false);
  });
});

describe("END_EXTENSION_SCHEMA", () => {
  // Strict mode rejects a schema whose `required` omits any property, and the
  // API rejects it with a 400 - which this stage treats as an outage: it falls
  // back to the second model, gets the same 400, and ships every clip
  // unextended. There is no louder symptom, so the invariant is asserted here
  // rather than discovered by a stage that silently stopped working.
  it("lists every property as required, as strict mode demands", () => {
    const item = END_EXTENSION_SCHEMA.schema.properties.results.items;
    expect(END_EXTENSION_SCHEMA.strict).toBe(true);
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
    expect(END_EXTENSION_SCHEMA.schema.additionalProperties).toBe(false);
    expect([...END_EXTENSION_SCHEMA.schema.required]).toEqual(
      Object.keys(END_EXTENSION_SCHEMA.schema.properties)
    );
  });

  // Field ORDER is load-bearing here, unlike in the other schemas: structured
  // output decodes in schema order, so `reason` before `extend` and `end_node`
  // is what makes the model name the beat before it commits to a decision and an
  // index. Move it to the end and the field survives while its whole purpose
  // does not - a rationalisation written after the fact instead of a reason
  // arrived at before it. The test above deliberately sorts, so only this one
  // holds the order.
  it("decodes reason before the decision it is supposed to precede", () => {
    const item = END_EXTENSION_SCHEMA.schema.properties.results.items;
    expect(Object.keys(item.properties)).toEqual(["id", "reason", "extend", "end_node"]);
    expect([...item.required]).toEqual(["id", "reason", "extend", "end_node"]);
    // and the prompt asks for them in the order the schema will decode them, so
    // the model is never told to answer in one order and parsed in another
    const asked = EXTENSION_SYSTEM.slice(
      EXTENSION_SYSTEM.indexOf("For each clip, in this order:")
    );
    const at = ["id", "reason", "extend", "end_node"].map((f) => asked.indexOf(f));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });
});

// ---------------------------------------------------------------------------
// The prompt lives in prompts.ts, next to every other prompt in the engine. Its
// tests live HERE, next to the gates, because the only property worth asserting
// about it is an AGREEMENT between the two files: an index the block offers and
// applyExtension refuses is a question the model cannot answer usefully, and
// neither file can be tested for that alone.
// ---------------------------------------------------------------------------

/** A clip whose critic verdict disagrees with the range that shipped - which is
 *  the normal case after snap moves a boundary, and the only fixture that can
 *  tell `finalStartNode` from `verdict.startNode`. */
function snappedClip(
  n: SentenceNode[],
  startNode: number,
  endNode: number,
  id = "c0"
): SnappedClip {
  const next = endNode + 1 < n.length ? n[endNode + 1] : null;
  return {
    verdict: {
      ...verdict(),
      id,
      // deliberately NOT the final range - the widest one the graph allows, so
      // that reading the clip's text off the verdict instead of off
      // finalStartNode/finalEndNode shows the whole transcript and is visible
      startNode: 0,
      endNode: n.length - 1,
      payoffNode: endNode,
      hookStartNode: startNode,
      hookEndNode: endNode,
      titleEvidenceNodes: [startNode],
    },
    startSec: n[startNode].start,
    endSec: Math.max(
      Math.min(n[endNode].end + cfg.tailHoldSec, next ? next.start : Infinity),
      n[endNode].end
    ),
    finalStartNode: startNode,
    finalEndNode: endNode,
    hookStartSec: n[startNode].start,
    hookEndSec: n[endNode].end,
    payoffSec: n[endNode].end,
    shortMoment: false,
  };
}

/** The indices the block actually OFFERS, read back out of the rendered text
 *  the way the model reads them. A regex rather than a substring test on
 *  purpose: `not.toContain("#8")` is also satisfied by "#80" and quietly stops
 *  proving anything the moment a fixture grows past ten nodes. */
function offeredIndices(block: string): number[] {
  return [...block.matchAll(/^ {2}#(\d+)/gm)].map((m) => Number(m[1]));
}

describe("buildExtensionUser", () => {
  const windowFor = (c: SnappedClip, n: SentenceNode[]) => extensionWindow(c, n, cfg);

  it("shows the clip's own text and the candidate nodes with indices", () => {
    const n = nodes(40);
    const c = clip(n);
    const user = buildExtensionUser(c, n, windowFor(c, n));
    expect(user).toContain("CLIP c0");
    expect(user).toContain("#5");
    expect(user).toContain("#6");
    expect(user).toContain("line 6.");
  });

  // Kills an off-by-one in EITHER direction on the candidate loop, which the
  // plan's `not.toContain("#8")` could not: the window here ends at 7, and both
  // a loop that stops early and one that runs past the scene cut leave that
  // assertion green while changing the set of ends the model may pick from.
  it("offers exactly the nodes inside the window - no more, no fewer", () => {
    const n = nodes(20, 8);
    const c = clip(n);
    expect(windowFor(c, n).lastNode).toBe(7);
    expect(offeredIndices(buildExtensionUser(c, n, windowFor(c, n)))).toEqual([5, 6, 7]);

    const wide = nodes(40);
    const cw = clip(wide);
    expect(offeredIndices(buildExtensionUser(cw, wide, windowFor(cw, wide)))).toEqual(
      [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
    );
  });

  // The agreement that matters, stated as one property: every index the block
  // prints is an index the gates will take. A renderer that printed `#${i + 1}`
  // would still look plausible to a reader and would offer lastNode + 1, which
  // applyExtension refuses - so the extension would be lost exactly when the
  // model reached for the last beat in the window.
  it("offers only indices applyExtension accepts", () => {
    const n = nodes(40);
    const c = clip(n);
    const offered = offeredIndices(buildExtensionUser(c, n, windowFor(c, n)));
    expect(offered.length).toBeGreaterThan(1);
    for (const i of offered.slice(1)) {
      expect(verdictOf(applyExtension(c, n, i, cfg))).toBe("accepted");
    }
    // and the first entry is the clip's own end, which is a no-op by design
    expect(offered[0]).toBe(c.finalEndNode);
    expect(verdictOf(applyExtension(c, n, offered[0], cfg))).toBe("not_forward");
  });

  // The empty window is a legal answer, not an error - a clip already ending at
  // a scene cut produces it - and the block has to say so, or the model is
  // handed a one-line list with no explanation and a schema demanding an index.
  // The list is not a menu: a clip is a contiguous range, so choosing #12 plays
  // #9, #10 and #11 too. That sentence is the only thing telling the model the
  // beats in between are a cost, and without it "is there a stronger beat later"
  // and "is the whole stretch worth watching" are different questions with the
  // same answer format.
  it("tells the model the lines in between play too", () => {
    const n = nodes(40);
    const c = clip(n);
    const header = buildExtensionUser(c, n, windowFor(c, n))
      .split("\n")
      .find((l) => l.startsWith("CANDIDATE ENDINGS"))!;
    expect(header).toContain("LAST line to include");
    expect(header).toContain("plays too");
    // and in the rules, where the mechanic is stated once for the whole batch.
    // It is the MECHANIC only: a prompt that also argued the lines in between
    // are a cost would discourage the reach this stage exists for - the ends it
    // is chasing are 17 to 55 seconds and many lines away.
    expect(EXTENSION_SYSTEM).toContain("not a menu");
    expect(EXTENSION_SYSTEM).toContain("playing EVERY line between the current end");
  });

  it("renders the empty-window case as an instruction to refuse", () => {
    const n = nodes(20, 6);
    const c = clip(n);
    expect(windowFor(c, n).lastNode).toBe(c.finalEndNode);
    const user = buildExtensionUser(c, n, windowFor(c, n));
    expect(offeredIndices(user)).toEqual([5]);
    expect(user).toContain("nothing follows inside this scene");
    expect(user).toContain("extend: false");
  });

  // Kills reading the range off verdict.startNode/verdict.endNode, which is the
  // critic's PROPOSAL - snap moves boundaries, so on this fixture that mistake
  // would show the model the whole graph as "what the clip contains" and ask it
  // to extend a clip it has already been told runs to the end.
  it("takes the clip's own text from the range that shipped, not the verdict's", () => {
    const n = nodes(12);
    const c = snappedClip(n, 3, 6);
    const user = buildExtensionUser(c, n, windowFor(c, n));
    const contains = user.split("\n")[1];
    expect(contains).toBe("WHAT IT CONTAINS: line 3. line 4. line 5. line 6.");
    expect(user).toContain("currently ends at node #6");
  });

  // Kills dropping the hasWords filter. An opaque node's text is Whisper's
  // segment-level guess at music or crosstalk; pasting it into "what the clip
  // contains" tells the model the clip says words no viewer will hear.
  it("skips opaque nodes in the clip's own text", () => {
    const n = nodes(12);
    n[4] = { ...n[4], hasWords: false, text: "[laughter]" };
    const c = snappedClip(n, 3, 6);
    const contains = buildExtensionUser(c, n, windowFor(c, n)).split("\n")[1];
    expect(contains).toBe("WHAT IT CONTAINS: line 3. line 5. line 6.");
  });

  // ---------------------------------------------------------------------------
  // AUDIT NOTE (spec 2026-08-10 task 4). Two properties, both pinned literally
  // rather than by substring: the exact wording a hinted clip gets, and the
  // exact BYTE-IDENTITY an unhinted clip keeps - the property that lets every
  // fixture recorded before this task keep replaying without a re-record.
  // ---------------------------------------------------------------------------

  it("renders the AUDIT NOTE for a hinted clip with the defect and node pinned", () => {
    const n = nodes(40);
    const c = clip(n);
    const window = windowFor(c, n);
    const user = buildExtensionUser(c, n, window, { defect: "mid_thought", fixEndNode: 9 });
    const lines = user.split("\n");
    // exact position: right after WHAT IT CONTAINS, before the blank line that
    // introduces CANDIDATE ENDINGS - "one labeled line after its WHAT IT
    // CONTAINS block" (spec).
    expect(lines[1]).toMatch(/^WHAT IT CONTAINS:/);
    expect(lines[2]).toBe(
      "AUDIT NOTE: a per-clip audit of the finished cut judged this clip's final " +
        "thought incomplete (mid_thought); the line that completes it may be #9."
    );
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("CANDIDATE ENDINGS - the LAST line to include. Everything between the " +
      "current end and your choice plays too. Keep the current end by choosing it:");
  });

  // A gated hint can in principle carry no defect (arc-audit.ts's readExit
  // permits `defect: null` independently of `fixEndNode` - see arc-audit.ts's
  // row-parsing comment). The note must still render something readable rather
  // than "(undefined)" or "(null)".
  it("falls back to a readable placeholder when a hinted clip carries no defect", () => {
    const n = nodes(40);
    const c = clip(n);
    const user = buildExtensionUser(c, n, windowFor(c, n), { fixEndNode: 9 });
    expect(user).toContain("incomplete (unspecified); the line that completes it may be #9.");
  });

  // THE PROPERTY THIS PARAMETER EXISTS TO PROTECT. `hint` defaults to
  // undefined, so a 3-argument call - exactly how every line of this file
  // before task 4 called it, and exactly how a fixture recorded before task 4
  // exists - must produce the SAME string as an explicit `hint: undefined`,
  // and neither may ever mention the audit. Asserted by full string equality,
  // not a substring check, so an accidental whitespace or ordering change
  // anywhere in the block is caught here even if no other test happens to
  // read that exact byte.
  it("renders byte-identical to the pre-task-4 block when no hint is given", () => {
    const n = nodes(40);
    const c = clip(n);
    const window = windowFor(c, n);
    const legacy = buildExtensionUser(c, n, window);
    const explicit = buildExtensionUser(c, n, window, undefined);
    expect(explicit).toBe(legacy);
    expect(legacy).not.toContain("AUDIT NOTE");
    expect(legacy.split("\n")[2]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extendClipEnds - the stage. Its promise is unusual and every test below is a
// way of stating it: it can only ever IMPROVE the set it was handed. There is
// no failure mode in which a clip comes back worse, shorter, missing, or in a
// different order, and no failure mode in which the job fails.
// ---------------------------------------------------------------------------

const armed = loadAnalyzeConfig({
  SCENE_GAP_SEC: "8",
  END_EXTENSION_WINDOW_SEC: "25",
  END_EXTENSION: "on",
});

const ok = (results: unknown[]) => ({
  choices: [{ message: { content: JSON.stringify({ results }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 900, completion_tokens: 200 },
});

const raw = (content: string) => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 900, completion_tokens: 200 },
});

const truncated = () => ({
  choices: [{ message: { content: null }, finish_reason: "length" }],
  usage: { prompt_tokens: 900, completion_tokens: 1 },
});

const refusal = () => ({
  choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 900, completion_tokens: 1 },
});

const boom = () => {
  throw Object.assign(new Error("503"), { status: 503 });
};

function seqClient(handlers: Array<(body: any) => any>) {
  let n = 0;
  const create = vi.fn(async (body: any) => {
    const h = handlers[Math.min(n, handlers.length - 1)];
    n += 1;
    return h(body);
  });
  return { chat: { completions: { create } } } as any;
}

const bodies = (client: any): any[] =>
  client.chat.completions.create.mock.calls.map((c: any[]) => c[0]);

const userOf = (client: any, call = 0): string => bodies(client)[call].messages[1].content;

/** One extend:true row. `reason` is required by the schema and ignored by the
 *  code, so it is here to keep the fixture honest rather than to be asserted. */
const row = (id: string, endNode: number, over: Record<string, unknown> = {}) => ({
  id,
  extend: true,
  end_node: endNode,
  reason: "the reaction lands here",
  ...over,
});

// `arcFlags` defaults to an empty map - the mechanical update task 4's signature
// change forces on every call site in this file that does not care about hints
// (spec 2026-08-10 task 4: "an empty-map argument"). Every existing test below
// calls `run` with its original arity and gets the pre-task-4 behavior back
// unchanged; only the new arc-audit-hints tests pass a populated map.
const run = (
  client: any,
  clips: SnappedClip[],
  graph: SentenceNode[],
  config = armed,
  usage = newUsage(),
  arcFlags: Map<string, ArcFlags> = new Map()
) => extendClipEnds(client, usage, clips, arcFlags, graph, config, { retryDelayMs: 1 });

/** Silences the failure logging llm.ts and this stage emit on purpose, so a
 *  suite that exercises every outage path stays readable. */
function quiet() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  };
}

describe("extendClipEnds - when it must not call at all", () => {
  // The killswitch, asserted on the CALL and not on the output. Every other
  // failure path in this file also returns the input unchanged, so an
  // output-only assertion would pass for a stage that spends a model call on
  // every job while the switch reads "off".
  it("makes no request when the stage is not armed", async () => {
    const n = nodes(40);
    const client = seqClient([() => ok([row("c0", 8)])]);
    const input = [clip(n)];
    const r = await run(client, input, n, cfg);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(r.clips).toBe(input);
    expect(r.telemetry).toEqual({
      offered: 0,
      proposed: 0,
      applied: 0,
      refused: 0,
      refusedBy: {},
      contradicted: 0,
      secondsGained: 0,
      fallbackModelUsed: false,
      skipped: "disabled",
    });
  });

  it("makes no request for an empty set", async () => {
    const client = seqClient([() => ok([])]);
    const r = await run(client, [], nodes(40));
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(r.clips).toEqual([]);
  });

  // A clip with nowhere to go is not a question: the only end it could name is
  // the one it already has. Asking anyway would spend a call, and would invite
  // a model that has been told to choose an index to invent one.
  it("makes no request when no clip has anywhere to go", async () => {
    const n = nodes(20, 6);
    const client = seqClient([() => ok([row("c0", 8)])]);
    const r = await run(client, [clip(n)], n);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(r.telemetry.offered).toBe(0);
  });

  // The offer filter, from the other side: a clip whose window is empty is left
  // out of the prompt while its neighbours are still asked about. `>` rather
  // than `>=` is what makes that true, and nothing else in the suite would
  // notice the difference.
  it("offers only the clips that have somewhere to go", async () => {
    const n = nodes(40, 30);
    const withRoom = snappedClip(n, 2, 5, "a");
    const atCut = snappedClip(n, 26, 29, "b");
    const client = seqClient([() => ok([])]);
    const r = await run(client, [withRoom, atCut], n);
    expect(r.telemetry.offered).toBe(1);
    expect(userOf(client)).toContain("CLIP a");
    expect(userOf(client)).not.toContain("CLIP b");
  });
});

describe("extendClipEnds - the request it makes", () => {
  it("asks once for the whole set, on the critic model, under the extension schema", async () => {
    const n = nodes(60);
    const clips = [snappedClip(n, 2, 5, "a"), snappedClip(n, 20, 23, "b"), snappedClip(n, 38, 41, "c")];
    const client = seqClient([() => ok([])]);
    await run(client, clips, n);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    const body = bodies(client)[0];
    expect(body.model).toBe(armed.criticModel);
    expect(body.messages[0].content).toBe(EXTENSION_SYSTEM);
    expect(body.response_format.json_schema.name).toBe("end_extension");
    // reasoning_effort is invisible to the fixture request hash and is the
    // dominant term in token spend - eval-fingerprint.ts exists because of it.
    expect(body.reasoning_effort).toBe(armed.reasoningEffort);
    // one prompt, three blocks - not three prompts
    expect(userOf(client).split("\n\n---\n\n")).toHaveLength(3);
  });

  // Kills sizing the budget off clips.length rather than the number actually
  // asked about, and kills a hardcoded cap. Truncation here costs the WHOLE
  // stage - there is no split and no retry - so the cap has to track the ask.
  it("sizes the output budget by the clips it actually offered", async () => {
    const n = nodes(40, 30);
    const clips = [snappedClip(n, 2, 5, "a"), snappedClip(n, 26, 29, "b")];
    const client = seqClient([() => ok([])]);
    await run(client, clips, n);
    expect(bodies(client)[0].max_completion_tokens).toBe(extensionMaxOutputTokens(1));
    expect(extensionMaxOutputTokens(1)).toBeLessThan(extensionMaxOutputTokens(2));
    expect(extensionMaxOutputTokens(0)).toBeGreaterThan(0);
  });

  // Kills handing callJsonSchema a fresh usage object. The tokens this stage
  // spends are billed to the job, and settleFreeLedger prices the free tier off
  // exactly this record (types.ts, LlmUsage) - a stage that spends invisibly
  // understates every job it runs on.
  it("charges its tokens to the caller's usage, per model", async () => {
    const n = nodes(40);
    const usage = newUsage();
    const client = seqClient([() => ok([])]);
    await run(client, [clip(n)], n, armed, usage);
    expect(usage.requests).toBe(1);
    expect(usage.inputTokens).toBe(900);
    expect(usage.byModel[armed.criticModel].requests).toBe(1);
  });
});

describe("extendClipEnds - applying what came back", () => {
  it("moves the end of the clip the model named and leaves the rest alone", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a");
    const b = snappedClip(n, 20, 23, "b");
    const client = seqClient([() => ok([row("a", 8)])]);
    const r = await run(client, [a, b], n);

    expect(r.clips.map((c) => c.verdict.id)).toEqual(["a", "b"]);
    expect(r.clips[0].finalEndNode).toBe(8);
    expect(r.clips[0].endSec).toBe(n[8].end);
    // untouched clips come back as the SAME objects, not rebuilt copies
    expect(r.clips[1]).toBe(b);
    expect(a.finalEndNode).toBe(5);
    expect(r.telemetry).toEqual({
      offered: 2,
      proposed: 1,
      applied: 1,
      refused: 0,
      refusedBy: {},
      contradicted: 0,
      secondsGained: n[8].end - a.endSec,
      fallbackModelUsed: false,
    });
    // the whole point of `skipped`: absent means the stage ran to completion,
    // and this is the only shape in the suite where that is true
    expect(r.telemetry.skipped).toBeUndefined();
  });

  // The gates own the decision, and a proposal they refuse must cost nothing
  // but a telemetry line. Node 30 is past the 25s window; the clip comes back
  // byte-identical, not merely equal.
  it("counts a proposal the gates refuse as refused, and keeps the clip", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a");
    const client = seqClient([() => ok([row("a", 30)])]);
    const r = await run(client, [a], n);
    expect(r.clips[0]).toBe(a);
    expect(r.telemetry.proposed).toBe(1);
    expect(r.telemetry.refused).toBe(1);
    expect(r.telemetry.applied).toBe(0);
    expect(r.telemetry.secondsGained).toBe(0);
    expect(r.telemetry.refusedBy).toEqual({ outside_window: 1 });
  });

  // The full arithmetic on a mixed batch, which is the only shape that can tell
  // the four counters apart. `applied + refused` equals the proposals that
  // named a real clip; the gap up to `proposed` is the model inventing one.
  it("keeps the four counters straight on a mixed batch", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a");
    const b = snappedClip(n, 20, 23, "b");
    const c = snappedClip(n, 38, 41, "c");
    const client = seqClient([
      () =>
        ok([
          row("a", 8), // legal - accepted
          row("b", 99), // outside the graph - refused by the gates
          row("c", 41, { extend: false }), // an honest refusal from the model
          row("zzz", 8), // a clip that does not exist
        ]),
    ]);
    const r = await run(client, [a, b, c], n);

    expect(r.telemetry.offered).toBe(3);
    expect(r.telemetry.proposed).toBe(3);
    expect(r.telemetry.applied).toBe(1);
    expect(r.telemetry.refused).toBe(1);
    expect(r.telemetry.applied + r.telemetry.refused).toBe(2);
    expect(r.telemetry.secondsGained).toBeCloseTo(n[8].end - a.endSec, 6);
    expect(r.clips.map((x) => x.finalEndNode)).toEqual([8, 23, 41]);
  });

  // Kills `+=` -> `=` on secondsGained, and kills measuring the wrong pair: the
  // clips here are 14s each and gain 6s each, so a mutant summing durations
  // reports 28 where the truth is 12.
  it("adds up the seconds it gained across every accepted clip", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a");
    const c = snappedClip(n, 38, 41, "c");
    const client = seqClient([() => ok([row("a", 8), row("c", 44)])]);
    const r = await run(client, [a, c], n);
    expect(r.telemetry.applied).toBe(2);
    expect(r.telemetry.secondsGained).toBeCloseTo(
      n[8].end - a.endSec + (n[44].end - c.endSec),
      6
    );
    expect(r.telemetry.secondsGained).toBeCloseTo(12, 6);
  });

  // An extend:false row is not a proposal and must not be counted as one, or
  // every "how often did the model want to extend" number this stage is judged
  // by would be the number of clips offered.
  it("ignores an extend:false echo of the current end", async () => {
    const n = nodes(40);
    const a = clip(n);
    const client = seqClient([() => ok([row("c0", 5, { extend: false })])]);
    const r = await run(client, [a], n);
    expect(r.clips[0]).toBe(a);
    expect(r.telemetry.proposed).toBe(0);
    expect(r.telemetry.refused).toBe(0);
  });

  // Same for a row that says extend:true and names an end that is already the
  // clip's own: a no-op the gates refuse, counted honestly as a refusal.
  it("counts an extend:true no-op as refused rather than applied", async () => {
    const n = nodes(40);
    const a = clip(n);
    const client = seqClient([() => ok([row("c0", 5)])]);
    const r = await run(client, [a], n);
    expect(r.clips[0]).toBe(a);
    expect(r.telemetry.proposed).toBe(1);
    expect(r.telemetry.refused).toBe(1);
  });

  // Node 0 is a real index and a real refusal. `if (!proposed)` instead of
  // `proposed === undefined` would treat it as no answer at all and lose the
  // refusal from telemetry - the one number that would tell an operator the
  // model is answering with nonsense.
  it("treats a proposal of node 0 as an answer, and refuses it", async () => {
    const n = nodes(40);
    const client = seqClient([() => ok([row("c0", 0)])]);
    const r = await run(client, [clip(n)], n);
    expect(r.telemetry.proposed).toBe(1);
    expect(r.telemetry.refused).toBe(1);
  });

  // A clip the prompt never mentioned can still be named by a model, and the
  // gates - not bookkeeping - are what refuse it: its window is empty, so every
  // proposal for it is out of range.
  it("refuses a proposal for a clip that was never offered", async () => {
    const n = nodes(40, 30);
    const atCut = snappedClip(n, 26, 29, "b");
    const client = seqClient([() => ok([row("b", 31)])]);
    const r = await run(client, [atCut], n);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(r.clips[0]).toBe(atCut);
  });

  // ...and when a call DID happen, that refusal is filed under the model's
  // fault, not the gate's. Both are true of clip b - the window is empty AND it
  // was never in the prompt - and only the second is worth acting on, so
  // "outside_window" here would inflate the exact histogram an operator reads to
  // decide whether the gates are too strict.
  it("files a proposal for a clip that was never shown as not_offered", async () => {
    const n = nodes(40, 30);
    const offeredClip = snappedClip(n, 2, 5, "a");
    const atCut = snappedClip(n, 26, 29, "b");
    const client = seqClient([() => ok([row("b", 31)])]);
    const r = await run(client, [offeredClip, atCut], n);
    expect(userOf(client)).not.toContain("CLIP b");
    expect(r.telemetry.refused).toBe(1);
    expect(r.telemetry.refusedBy).toEqual({ not_offered: 1 });
  });

  // The histogram is the whole point of naming the reasons: a `refused` count
  // that is climbing says the model and the gates disagree, and only the split
  // says which prompt edit would fix it - marking opaque lines and explaining
  // clean ends are different repairs. Three clips, three different gates, one
  // batch.
  it("splits refusals by the gate that fired", async () => {
    const n = nodes(60);
    n[26] = { ...n[26], hasWords: false, text: "[laughter]" };
    n[44] = { ...n[44], trailingStrength: 0.2 };
    n[45] = { ...n[45], leadingStrength: 0.2, text: "and then." };
    const a = snappedClip(n, 2, 5, "a");
    const b = snappedClip(n, 20, 23, "b");
    const c = snappedClip(n, 38, 41, "c");
    const client = seqClient([
      () => ok([row("a", 30), row("b", 26), row("c", 44)]),
    ]);
    const r = await run(client, [a, b, c], n);
    expect(r.telemetry.refused).toBe(3);
    expect(r.telemetry.refusedBy).toEqual({
      outside_window: 1,
      opaque_end: 1,
      no_clean_end: 1,
    });
    expect(r.clips).toEqual([a, b, c]);
  });

  // A histogram that cannot count past one is not a histogram: "the model picked
  // a laugh track once" and "it did so on every clip in the job" are the same
  // reading under an overwrite, and they are the difference between leaving the
  // prompt alone and rewriting it.
  it("counts repeats of one reason rather than flagging it once", async () => {
    const n = nodes(60);
    n[8] = { ...n[8], hasWords: false, text: "[laughter]" };
    n[26] = { ...n[26], hasWords: false, text: "[laughter]" };
    const a = snappedClip(n, 2, 5, "a");
    const b = snappedClip(n, 20, 23, "b");
    const client = seqClient([() => ok([row("a", 8), row("b", 26)])]);
    const r = await run(client, [a, b], n);
    expect(r.telemetry.refused).toBe(2);
    expect(r.telemetry.refusedBy).toEqual({ opaque_end: 2 });
  });

  // Two rows about one clip is a model that does not have one answer. Neither
  // last-write-wins nor first-write-wins is defensible, so the proposal is
  // dropped - and both mutants are killed here, because either would extend.
  it("drops a proposal the model contradicted itself about", async () => {
    const n = nodes(40);
    const a = clip(n);
    const client = seqClient([() => ok([row("c0", 8), row("c0", 9)])]);
    const r = await run(client, [a], n);
    expect(r.clips[0]).toBe(a);
    expect(r.telemetry.proposed).toBe(0);
    expect(r.telemetry.applied).toBe(0);
    expect(r.telemetry.refused).toBe(0);
    // and it is COUNTED, or a self-contradicting model looks exactly like a
    // model that answered nothing - the same blindness `skipped` exists to end
    expect(r.telemetry.contradicted).toBe(1);
  });

  it("drops a proposal a later row withdrew", async () => {
    const n = nodes(40);
    const a = clip(n);
    const client = seqClient([() => ok([row("c0", 8), row("c0", 5, { extend: false })])]);
    const r = await run(client, [a], n);
    expect(r.clips[0]).toBe(a);
    expect(r.telemetry.proposed).toBe(0);
    expect(r.telemetry.contradicted).toBe(1);
  });

  // Three rows about one clip is still ONE clip contradicted - the counter names
  // clips, not rows, so it can be read against `offered` without division. And
  // two contradicted clips must read 2: a counter that cannot pass 1 is a
  // boolean wearing a number, the same defect the histogram test above guards
  // against, and "the model doubled back on one clip" and "on the whole batch"
  // are the difference between noise and a broken prompt.
  it("counts contradicted clips, once each and more than one", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a");
    const b = snappedClip(n, 20, 23, "b");
    const one = seqClient([() => ok([row("a", 8), row("a", 9), row("a", 10)])]);
    expect((await run(one, [a, b], n)).telemetry.contradicted).toBe(1);

    const both = seqClient([
      () => ok([row("a", 8), row("a", 9), row("b", 26), row("b", 27)]),
    ]);
    const r = await run(both, [a, b], n);
    expect(r.telemetry.contradicted).toBe(2);
    expect(r.telemetry.proposed).toBe(0);
    expect(r.clips[0]).toBe(a);
    expect(r.clips[1]).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// `skipped` is the field that separates "the stage never ran" from "the stage
// ran and declined". Without it those two emit identical zeros, and they are
// opposite findings: one is a bug or an outage, the other is the stage working
// as designed. finalizeClips carries finalizerSkipped for the same reason, and
// the console.warn this stage emits is not a substitute - a degradation that
// only reaches a log line is one nobody notices (job cmscht6rp001xq41s5rhjx6q0).
// ---------------------------------------------------------------------------
describe("extendClipEnds - saying why nothing happened", () => {
  const n = nodes(60);
  const twoClips = () => [snappedClip(n, 2, 5, "a"), snappedClip(n, 20, 23, "b")];

  it("says nothing at all when the stage ran to completion", async () => {
    const client = seqClient([() => ok([row("a", 8)])]);
    const r = await run(client, twoClips(), n);
    expect(r.telemetry.skipped).toBeUndefined();
    expect(r.telemetry.applied).toBe(1);
  });

  // THE distinction: a model that read every clip and declined every one emits
  // the same four zeros as an outage, and must not be reported as one.
  it("stays silent when the model declined every clip - that is not a skip", async () => {
    const client = seqClient([
      () => ok([row("a", 5, { extend: false }), row("b", 23, { extend: false })]),
    ]);
    const r = await run(client, twoClips(), n);
    expect(r.telemetry.skipped).toBeUndefined();
    expect(r.telemetry.offered).toBe(2);
    expect(r.telemetry.proposed).toBe(0);
    expect(r.telemetry.applied).toBe(0);
    expect(r.telemetry.refused).toBe(0);
  });

  it("names the killswitch", async () => {
    const r = await run(seqClient([() => ok([])]), twoClips(), n, cfg);
    expect(r.telemetry.skipped).toBe("disabled");
  });

  it("names an empty offer set", async () => {
    const graph = nodes(20, 6);
    const r = await run(seqClient([() => ok([])]), [clip(graph)], graph);
    expect(r.telemetry.skipped).toBe("no_window");
    expect(r.telemetry.offered).toBe(0);
  });

  it("names the call's own failure kind", async () => {
    for (const [handler, kind] of [
      [refusal, "refusal"],
      [truncated, "truncated"],
    ] as const) {
      const r = await run(seqClient([handler]), twoClips(), n);
      expect(r.telemetry.skipped).toBe(kind);
    }
  });

  it("names a hard error after the fallback model failed too", async () => {
    const spies = quiet();
    const r = await run(seqClient([boom]), twoClips(), n);
    expect(r.telemetry.skipped).toBe("error");
    expect(r.telemetry.fallbackModelUsed).toBe(true);
    spies.error.mockRestore();
    spies.warn.mockRestore();
  });

  // A payload with no results ARRAY is the fifth outcome that used to collapse
  // onto the honest all-decline above: same zeros, no skip reason, and the
  // comment that used to sit here claimed `proposed: 0` told them apart when the
  // all-decline case emits exactly that. It does not; the reason does.
  it("names a payload it could not read", async () => {
    for (const body of ['{"nope":1}', "null", '{"results":{"a":8}}']) {
      const r = await run(seqClient([() => raw(body)]), twoClips(), n);
      expect(r.telemetry.skipped).toBe("unreadable");
      expect(r.telemetry.proposed).toBe(0);
    }
  });

  // But rows it CAN read and finds nothing usable in are an answer, not a skip:
  // the array was there and the stage walked it. That is a model fault, and the
  // pair of assertions below is the only place the two are contrasted directly.
  it("stays silent on rows it could read and found nothing in", async () => {
    const r = await run(
      seqClient([() => ok([{ id: "a", extend: "yes", end_node: 8, reason: "x" }])]),
      twoClips(),
      n
    );
    expect(r.telemetry.skipped).toBeUndefined();
    expect(r.telemetry.proposed).toBe(0);
  });

  // The catch resets the counters as finalizeClips does, keeping only what was
  // asked: an `applied` accumulated before a throw would describe a set that
  // never shipped.
  it("names an exception and keeps only what was asked", async () => {
    const spies = quiet();
    const graph = nodes(40);
    graph[6] = { ...graph[6], text: undefined as unknown as string };
    const r = await run(seqClient([() => ok([row("c0", 8)])]), [clip(graph)], graph);
    expect(r.telemetry.skipped).toBe("exception");
    expect(r.telemetry.applied).toBe(0);
    expect(r.telemetry.secondsGained).toBe(0);
    spies.error.mockRestore();
    spies.warn.mockRestore();
  });
});

/** Nothing this stage claims to HANDLE may reach the outer catch. Every
 *  malformed payload below returns the input set either way, so without this
 *  the whole class of "the guard is gone and the try/catch is swallowing a
 *  TypeError" reads as green - which is how three of these mutants first
 *  survived. */
function expectNoCrash(warn: ReturnType<typeof vi.spyOn>) {
  expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(
    "end-extension threw"
  );
}

describe("extendClipEnds - it never throws and never loses a clip", () => {
  const inputSurvives = async (
    handler: (body: any) => any,
    graph = nodes(60),
    clips?: SnappedClip[]
  ) => {
    const spies = quiet();
    try {
      const set = clips ?? [snappedClip(graph, 2, 5, "a"), snappedClip(graph, 20, 23, "b")];
      const client = seqClient([handler]);
      const r = await run(client, set, graph);
      expect(r.clips).toHaveLength(set.length);
      for (const [i, c] of set.entries()) expect(r.clips[i]).toBe(c);
      expect(r.telemetry.applied).toBe(0);
      expect(r.telemetry.secondsGained).toBe(0);
      expectNoCrash(spies.warn);
      return r;
    } finally {
      spies.error.mockRestore();
      spies.warn.mockRestore();
    }
  };

  it("ships the set unchanged when the API fails on both models", async () => {
    const r = await inputSurvives(boom);
    expect(r.telemetry.fallbackModelUsed).toBe(true);
  });

  it("ships the set unchanged when the model refuses", async () => {
    const r = await inputSurvives(refusal);
    expect(r.telemetry.fallbackModelUsed).toBe(false);
  });

  it("ships the set unchanged when the answer is truncated", async () => {
    const r = await inputSurvives(truncated);
    expect(r.telemetry.fallbackModelUsed).toBe(false);
  });

  it("ships the set unchanged when the payload has no results at all", async () => {
    const r = await inputSurvives(() => raw('{"nope":1}'));
    expect(r.telemetry.proposed).toBe(0);
  });

  // JSON.parse("null") is a legal parse, so `data` itself can be null - and
  // `data.results` on it is a TypeError inside a function documented never to
  // throw.
  it("ships the set unchanged when the payload parses to null", async () => {
    await inputSurvives(() => raw("null"));
  });

  it("ships the set unchanged when results is not an array", async () => {
    await inputSurvives(() => raw('{"results":{"a":8}}'));
  });

  // Every unreadable row carries a DISTINCT id, which is what makes the
  // assertion below sharp: a row that slipped through any one of these checks
  // would land in the map under its own key and show up in `proposed`. Reusing
  // one id would let the duplicate rule delete the evidence and pass a suite
  // that proves nothing - it did, for two of these mutants.
  it("ignores rows it cannot read, whatever shape they arrive in", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a");
    const b = snappedClip(n, 20, 23, "b");
    const spies = quiet();
    const client = seqClient([
      () =>
        ok([
          null,
          "nonsense",
          42,
          [],
          { extend: true, end_node: 8 }, // no id
          { id: 42, extend: true, end_node: 8 }, // id is not a string
          row("s1", "8" as unknown as number), // end_node is a string
          row("s2", null as unknown as number), // end_node is null
          { id: "s3", extend: true, reason: "x" }, // end_node absent
          { id: "s4", end_node: 26, reason: "x" }, // extend absent
          { id: "s5", extend: "yes", end_node: 8, reason: "x" }, // extend is a string
          { id: "s6", extend: 1, end_node: 8, reason: "x" }, // extend is a number
        ]),
    ]);
    const r = await run(client, [a, b], n);
    expect(r.clips[0]).toBe(a);
    expect(r.clips[1]).toBe(b);
    expect(r.telemetry.proposed).toBe(0);
    expectNoCrash(spies.warn);
    spies.error.mockRestore();
    spies.warn.mockRestore();
  });

  // A clip carrying an end node that is not a real index would throw inside
  // extensionWindow, which is partial by design. The stage skips it BEFORE
  // building a prompt from it - and the point of the test is the other clip:
  // one stale clip must not cost the whole job its extensions, which is exactly
  // what relying on the outer catch would do.
  it("skips a clip whose own end node is not real, and still extends the others", async () => {
    const n = nodes(60);
    const good = snappedClip(n, 2, 5, "a");
    const stale = { ...snappedClip(n, 20, 23, "b"), finalEndNode: 500 };
    const negative = { ...snappedClip(n, 38, 41, "c"), finalEndNode: -1 };
    const fractional = { ...snappedClip(n, 38, 41, "d"), finalEndNode: 2.5 };
    const notANumber = { ...snappedClip(n, 38, 41, "e"), finalEndNode: Number.NaN };
    // exactly one past the top of the graph - the bound is `nodes.length - 1`,
    // and `nodes.length` is the value an off-by-one lets through into
    // nodes[from].end
    const justPast = { ...snappedClip(n, 38, 41, "f"), finalEndNode: n.length };
    const broken = [stale, negative, fractional, notANumber, justPast];
    const client = seqClient([() => ok([row("a", 8), row("b", 501), row("c", 3)])]);
    const r = await run(client, [good, ...broken], n);

    expect(r.telemetry.offered).toBe(1);
    expect(userOf(client)).not.toContain("CLIP b");
    expect(r.clips[0].finalEndNode).toBe(8);
    for (const [i, c] of broken.entries()) expect(r.clips[i + 1]).toBe(c);
  });

  // The lower bound is `< 0`, not `<= 0`. A clip ending on the FIRST node is a
  // real clip - snap produces one whenever the video opens on the moment - and
  // it must still be offered and still be extendable.
  it("offers a clip that ends on node 0", async () => {
    const n = nodes(40);
    const first = snappedClip(n, 0, 0, "a");
    const client = seqClient([() => ok([row("a", 3)])]);
    const r = await run(client, [first], n);
    expect(r.telemetry.offered).toBe(1);
    expect(r.clips[0].finalEndNode).toBe(3);
  });

  // Belt and braces, and the only test that reaches the outer catch: a graph
  // whose node carries no text at all makes prompt rendering throw. The stage
  // still has to ship the clips every earlier gate approved.
  it("ships the set unchanged when rendering the prompt throws", async () => {
    const spies = quiet();
    const n = nodes(40);
    n[6] = { ...n[6], text: undefined as unknown as string };
    const a = clip(n);
    const client = seqClient([() => ok([row("c0", 8)])]);
    const r = await run(client, [a], n);
    expect(r.clips[0]).toBe(a);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(spies.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "end-extension threw"
    );
    spies.error.mockRestore();
    spies.warn.mockRestore();
  });
});

describe("extendClipEnds - the fallback model", () => {
  it("degrades to the fallback model on a hard error, and applies its answer", async () => {
    const spies = quiet();
    const n = nodes(40);
    const models: string[] = [];
    const client = seqClient([
      (body) => {
        models.push(body.model);
        if (body.model === armed.criticModel) boom();
        return ok([row("c0", 8)]);
      },
    ]);
    const r = await run(client, [clip(n)], n);
    expect(models.at(-1)).toBe(armed.criticModelFallback);
    expect(new Set(models.slice(0, -1))).toEqual(new Set([armed.criticModel]));
    expect(r.telemetry.fallbackModelUsed).toBe(true);
    expect(r.clips[0].finalEndNode).toBe(8);
    spies.error.mockRestore();
    spies.warn.mockRestore();
  });

  // A refusal and a truncation are answers ABOUT THIS REQUEST - llm.ts has
  // already spent its retry budget on anything transient - so re-asking a
  // second model doubles the wall clock of a stage whose failure is free.
  it("does not change models on a refusal or a truncation", async () => {
    for (const handler of [refusal, truncated]) {
      const n = nodes(40);
      const client = seqClient([handler]);
      const r = await run(client, [clip(n)], n);
      expect(bodies(client).map((b) => b.model)).toEqual([armed.criticModel]);
      expect(r.telemetry.fallbackModelUsed).toBe(false);
    }
  });

  // The stage name is in the announcement because "the critic fell back" and
  // "the end-extension fell back" need different responses, and because this
  // line is the only place an operator sees it at all - telemetry lives inside
  // a JSON blob on a JobStep row, which is exactly how job
  // cmscht6rp001xq41s5rhjx6q0 went unnoticed.
  it("announces the fallback, naming the stage and both models", async () => {
    const spies = quiet();
    const n = nodes(40);
    const client = seqClient([
      (body) => (body.model === armed.criticModel ? boom() : ok([])),
    ]);
    await run(client, [clip(n)], n);
    const announcements = spies.error.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("FALLBACK MODEL IN USE"));
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toContain("end-extension");
    expect(announcements[0]).toContain(armed.criticModel);
    expect(announcements[0]).toContain(armed.criticModelFallback);
    spies.error.mockRestore();
    spies.warn.mockRestore();
  });

  it("says nothing about a fallback on the ordinary path", async () => {
    const spies = quiet();
    const n = nodes(40);
    await run(seqClient([() => ok([row("c0", 8)])]), [clip(n)], n);
    expect(
      spies.error.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("FALLBACK"))
    ).toHaveLength(0);
    spies.error.mockRestore();
    spies.warn.mockRestore();
  });

  // The retry hook has to reach callJsonSchema or a failing stage parks a
  // waiting user for the full production backoff - two models x three attempts
  // x seconds of sleep. The margin here is ~100x, so this is a hook test and
  // not a timing test.
  it("forwards the retry-delay hook, so a failing call cannot stall the job", async () => {
    const spies = quiet();
    const n = nodes(40);
    const started = Date.now();
    await run(seqClient([boom]), [clip(n)], n);
    expect(Date.now() - started).toBeLessThan(1000);
    spies.error.mockRestore();
    spies.warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ARC-AUDIT HINTS (spec 2026-08-10 task 4). The self-motivated path above
// (every test up to this point) is asserted with an EMPTY arcFlags map - the
// mechanical, signature-forced update - and every one of it stays green
// unmodified. This block is the new surface: separability of the two
// switches, the offered-set semantics of all four combinations, and the
// hintFollowed/hintOverridden split. All existing gates are exercised
// unchanged by these tests - a hinted proposal goes through applyExtension
// exactly like any other, which is the property "refused like any other" is
// asserted against directly below.
// ---------------------------------------------------------------------------
describe("extendClipEnds - arc-audit hints (task 4)", () => {
  const exitFlag = (fixEndNode: number, defect: ArcFlags["exit"]["defect"] = "mid_thought"): ArcFlags => ({
    entry: { ok: true },
    exit: { ok: false, defect, fixEndNode },
    standalone: { ok: true },
  });

  const hintsOnly = loadAnalyzeConfig({
    SCENE_GAP_SEC: "8",
    END_EXTENSION_WINDOW_SEC: "25",
    ARC_AUDIT: "on",
    END_EXTENSION_HINTS: "on",
  });
  const bothOn = loadAnalyzeConfig({
    SCENE_GAP_SEC: "8",
    END_EXTENSION_WINDOW_SEC: "25",
    ARC_AUDIT: "on",
    END_EXTENSION: "on",
    END_EXTENSION_HINTS: "on",
  });

  /** The CLIP ids a rendered user prompt actually offers, in order - read the
   *  same way a model would, off the same "CLIP <id>" header every other test
   *  in this file asserts with `.toContain`. */
  const offeredIdsOf = (user: string): string[] =>
    [...user.matchAll(/^CLIP (\S+)/gm)].map((m) => m[1]);

  // THE FOUR SWITCH COMBINATIONS, on one fixture built so each combination
  // predicts a DIFFERENT offered set: "a" has a self window and no hint, "b"
  // has both, "c" ends exactly at a scene cut (nodes(40, 30) - the same
  // "atCut" shape the pre-task-4 suite already uses) so its self-motivated
  // window is EMPTY and the only way it can be offered is a hint.
  describe("offered-set semantics", () => {
    const n = nodes(40, 30);
    const a = snappedClip(n, 2, 5, "a");
    const b = snappedClip(n, 10, 13, "b");
    const c = snappedClip(n, 26, 29, "c");
    const clips = [a, b, c];
    const arcFlags = new Map<string, ArcFlags>([
      ["b", exitFlag(15)],
      ["c", exitFlag(32, "setup_no_payoff")],
    ]);

    const offered = async (config: AnalyzeConfig) => {
      const client = seqClient([() => ok([])]);
      const r = await run(client, clips, n, config, newUsage(), arcFlags);
      if (client.chat.completions.create.mock.calls.length === 0) {
        return { ids: [] as string[], skipped: r.telemetry.skipped };
      }
      return { ids: offeredIdsOf(userOf(client)), skipped: r.telemetry.skipped };
    };

    it("neither switch: the stage does not even ask", async () => {
      const r = await offered(cfg);
      expect(r.ids).toEqual([]);
      expect(r.skipped).toBe("disabled");
    });

    it("self only: every clip WITH a window, hinted or not - today's behavior, unchanged", async () => {
      expect((await offered(armed)).ids).toEqual(["a", "b"]);
    });

    it("hints only: ONLY the hinted clips, including one whose self window is empty", async () => {
      expect((await offered(hintsOnly)).ids).toEqual(["b", "c"]);
    });

    it("both on: the union", async () => {
      expect((await offered(bothOn)).ids).toEqual(["a", "b", "c"]);
    });
  });

  it("no-ops on the hint side when ARC_AUDIT is off, even with a populated arcFlags map - the dependency is checked in code, not inferred from an empty map", async () => {
    // c0's own window is empty (the same nodes(20, 6) shape "is empty when the
    // clip already ends at the scene boundary" already relies on), so the
    // clip can ONLY be offered via a hint - and arcAuditEnabled is deliberately
    // absent from this config, simulating a caller that (by bug or by stale
    // state) still hands this stage a non-empty arcFlags map.
    const n = nodes(20, 6);
    const c = clip(n);
    const arcFlags = new Map<string, ArcFlags>([["c0", exitFlag(10)]]);
    const config = loadAnalyzeConfig({
      SCENE_GAP_SEC: "8",
      END_EXTENSION_WINDOW_SEC: "25",
      END_EXTENSION_HINTS: "on", // ARC_AUDIT deliberately not set
    });
    const client = seqClient([() => ok([])]);
    const r = await run(client, [c], n, config, newUsage(), arcFlags);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(r.telemetry.skipped).toBe("no_window");
    expect(r.telemetry.hinted).toBeUndefined();
  });

  it("a hinted clip's prompt block carries the AUDIT NOTE; an unhinted clip in the SAME batch does not", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a");
    const b = snappedClip(n, 20, 23, "b");
    const arcFlags = new Map<string, ArcFlags>([["a", exitFlag(8, "transition_out")]]);
    const client = seqClient([() => ok([])]);
    await run(client, [a, b], n, bothOn, newUsage(), arcFlags);
    const user = userOf(client);
    const blocks = user.split("\n\n---\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("CLIP a");
    expect(blocks[0]).toContain(
      "AUDIT NOTE: a per-clip audit of the finished cut judged this clip's final " +
        "thought incomplete (transition_out); the line that completes it may be #8."
    );
    expect(blocks[1]).toContain("CLIP b");
    expect(blocks[1]).not.toContain("AUDIT NOTE");
  });

  it("counts hintFollowed when the model's node matches the hint, hintOverridden when it legally picks another", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a"); // hinted at 8, model proposes 8 - followed
    const b = snappedClip(n, 20, 23, "b"); // hinted at 26, model proposes 27 - overridden
    const c = snappedClip(n, 38, 41, "c"); // not hinted at all - ordinary self extension
    const arcFlags = new Map<string, ArcFlags>([
      ["a", exitFlag(8)],
      ["b", exitFlag(26, "setup_no_payoff")],
    ]);
    const client = seqClient([() => ok([row("a", 8), row("b", 27), row("c", 44)])]);
    const r = await run(client, [a, b, c], n, bothOn, newUsage(), arcFlags);

    expect(r.telemetry.applied).toBe(3);
    expect(r.telemetry.hinted).toBe(2);
    expect(r.telemetry.hintFollowed).toBe(1);
    expect(r.telemetry.hintOverridden).toBe(1);
    expect(r.clips.find((x) => x.verdict.id === "a")!.finalEndNode).toBe(8);
    expect(r.clips.find((x) => x.verdict.id === "b")!.finalEndNode).toBe(27);
  });

  it("refuses a hinted proposal exactly like any other - gates unchanged - and does not count it as followed or overridden", async () => {
    const n = nodes(40);
    const a = clip(n); // window's lastNode is 17 under `cfg`-equivalent settings
    const arcFlags = new Map<string, ArcFlags>([["c0", exitFlag(30)]]);
    const config = loadAnalyzeConfig({
      SCENE_GAP_SEC: "8",
      END_EXTENSION_WINDOW_SEC: "25",
      ARC_AUDIT: "on",
      END_EXTENSION_HINTS: "on",
    });
    // The model proposes exactly the hinted node, which is past the 25s window
    // - refused by the SAME gate an unhinted proposal would hit.
    const client = seqClient([() => ok([row("c0", 30)])]);
    const r = await run(client, [a], n, config, newUsage(), arcFlags);

    expect(r.telemetry.hinted).toBe(1);
    expect(r.telemetry.applied).toBe(0);
    expect(r.telemetry.refused).toBe(1);
    expect(r.telemetry.refusedBy).toEqual({ outside_window: 1 });
    // Present at 0, not absent - see ExtensionTelemetry's doc comment: once
    // there is a hinted population, 0 is a real answer about it.
    expect(r.telemetry.hintFollowed).toBe(0);
    expect(r.telemetry.hintOverridden).toBe(0);
  });

  // The whole point of the "absent, never zero" rule: every telemetry-equality
  // test in this file written before task 4 must keep matching byte for byte.
  it("keeps hinted/hintFollowed/hintOverridden entirely absent when nothing in the run was hinted", async () => {
    const n = nodes(60);
    const a = snappedClip(n, 2, 5, "a");
    const client = seqClient([() => ok([row("a", 8)])]);
    // an empty arcFlags map - exactly what index.ts passes when arcAudit never
    // ran, and exactly what `run`'s own default supplies
    const r = await run(client, [a], n);
    expect(r.telemetry.applied).toBe(1);
    expect("hinted" in r.telemetry).toBe(false);
    expect("hintFollowed" in r.telemetry).toBe(false);
    expect("hintOverridden" in r.telemetry).toBe(false);
  });

  // -------------------------------------------------------------------------
  // THE `repaired` FOLLOW-UP (2026-08-11, real job cmsoqmy47008fuhfjosaxi86s).
  //
  // Before this fix, nothing ever cleared a STANDING flag once its repair
  // APPLIED: a clip whose exit this stage successfully widened still carried
  // `exit.ok: false`, so the finalizer's AUDIT NOTE and `_arcFlags` on the
  // shipped highlight both kept accusing the clip of an ending defect it no
  // longer had. The rule: ANY applied extension on a clip carrying an
  // `exit.ok: false` flag marks `exit.repaired = true` - whether the model
  // followed the hint node exactly, overrode it with a different legal one,
  // or the clip reached here through the self-motivated path with no gated
  // pointer at all. `exit.ok` itself is never rewritten.
  // -------------------------------------------------------------------------
  describe("marks exit.repaired on an applied extension (2026-08-11 follow-up)", () => {
    it("sets exit.repaired on BOTH the hintFollowed and the hintOverridden clip", async () => {
      const n = nodes(60);
      const a = snappedClip(n, 2, 5, "a"); // hinted at 8, model proposes 8 - followed
      const b = snappedClip(n, 20, 23, "b"); // hinted at 26, model proposes 27 - overridden
      const arcFlags = new Map<string, ArcFlags>([
        ["a", exitFlag(8)],
        ["b", exitFlag(26, "setup_no_payoff")],
      ]);
      const client = seqClient([() => ok([row("a", 8), row("b", 27)])]);
      const r = await run(client, [a, b], n, bothOn, newUsage(), arcFlags);

      expect(r.telemetry.applied).toBe(2);
      expect(r.telemetry.hintFollowed).toBe(1);
      expect(r.telemetry.hintOverridden).toBe(1);

      const flagsA = arcFlags.get("a")!;
      expect(flagsA.exit.repaired).toBe(true);
      expect(flagsA.exit.ok).toBe(false); // the detector's own record is untouched
      expect(flagsA.exit.defect).toBe("mid_thought");
      expect(flagsA.exit.fixEndNode).toBe(8);

      const flagsB = arcFlags.get("b")!;
      expect(flagsB.exit.repaired).toBe(true);
      expect(flagsB.exit.ok).toBe(false);
      expect(flagsB.exit.defect).toBe("setup_no_payoff");
    });

    it("sets exit.repaired on a flagged clip's applied extension even with NO gated hint pointer (self-motivated path)", async () => {
      // c carries an exit flag with NO fixEndNode (a gate refused the pointer,
      // or the model never offered one) - not eligible for the hint-driven
      // offered path at all, so it can only be applied here through the
      // self-motivated window. The rule still fires: the end moved forward, so
      // the audited exit no longer exists, regardless of how the clip reached
      // the offered set.
      const n = nodes(60);
      const c = snappedClip(n, 38, 41, "c");
      const arcFlags = new Map<string, ArcFlags>([
        ["c", { entry: { ok: true }, exit: { ok: false, defect: "mid_thought" }, standalone: { ok: true } }],
      ]);
      const client = seqClient([() => ok([row("c", 44)])]);
      const r = await run(client, [c], n, bothOn, newUsage(), arcFlags);

      expect(r.telemetry.applied).toBe(1);
      // no gated fixEndNode on this clip's flag, so it was never in `hinted`
      expect(r.telemetry.hinted ?? 0).toBe(0);
      const flagsC = arcFlags.get("c")!;
      expect(flagsC.exit.repaired).toBe(true);
      expect(flagsC.exit.ok).toBe(false);
    });

    it("sets NOTHING on a non-flagged clip's applied self-motivated extension", async () => {
      const n = nodes(60);
      const c = snappedClip(n, 38, 41, "c"); // never audited - no entry in arcFlags at all
      const arcFlags = new Map<string, ArcFlags>();
      const client = seqClient([() => ok([row("c", 44)])]);
      const r = await run(client, [c], n, bothOn, newUsage(), arcFlags);

      expect(r.telemetry.applied).toBe(1);
      expect(arcFlags.has("c")).toBe(false); // no entry was ever created
    });

    it("does not mark repaired when the applied extension belongs to a clip whose exit was already ok:true", async () => {
      const n = nodes(60);
      const c = snappedClip(n, 38, 41, "c");
      const arcFlags = new Map<string, ArcFlags>([
        ["c", { entry: { ok: true }, exit: { ok: true }, standalone: { ok: true } }],
      ]);
      const client = seqClient([() => ok([row("c", 44)])]);
      const r = await run(client, [c], n, bothOn, newUsage(), arcFlags);

      expect(r.telemetry.applied).toBe(1);
      expect(arcFlags.get("c")!.exit.repaired).toBeUndefined();
    });

    it("does not mark repaired when a hinted proposal is refused by a gate", async () => {
      const n = nodes(40);
      const a = clip(n);
      const arcFlags = new Map<string, ArcFlags>([["c0", exitFlag(30)]]); // past the window
      const config = loadAnalyzeConfig({
        SCENE_GAP_SEC: "8",
        END_EXTENSION_WINDOW_SEC: "25",
        ARC_AUDIT: "on",
        END_EXTENSION_HINTS: "on",
      });
      const client = seqClient([() => ok([row("c0", 30)])]);
      const r = await run(client, [a], n, config, newUsage(), arcFlags);

      expect(r.telemetry.applied).toBe(0);
      expect(r.telemetry.refused).toBe(1);
      expect(arcFlags.get("c0")!.exit.repaired).toBeUndefined();
      expect(arcFlags.get("c0")!.exit.ok).toBe(false);
    });
  });
});
