import { describe, expect, it } from "vitest";
import { applyExtension, extensionWindow } from "../analyze-v2/end-extension";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SentenceNode, SnappedClip } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", END_EXTENSION_WINDOW_SEC: "25" });

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
});

describe("applyExtension", () => {
  it("accepts a legal forward move and returns the widened clip", () => {
    const n = nodes(40);
    const out = applyExtension(clip(n), n, 8, cfg);
    expect(out).not.toBeNull();
    expect(out!.finalEndNode).toBe(8);
    expect(out!.endSec).toBeGreaterThan(n[5].end);
  });

  it("refuses a move that shortens the clip", () => {
    const n = nodes(40);
    expect(applyExtension(clip(n), n, 4, cfg)).toBeNull();
  });

  it("refuses a no-op", () => {
    const n = nodes(40);
    expect(applyExtension(clip(n), n, 5, cfg)).toBeNull();
  });

  it("refuses a move across a scene boundary", () => {
    const n = nodes(20, 8);
    expect(applyExtension(clip(n), n, 10, cfg)).toBeNull();
  });

  it("refuses a move that would push the clip past maxSec", () => {
    const n = nodes(200);
    expect(applyExtension(clip(n), n, 120, cfg)).toBeNull();
  });

  it("refuses an index outside the graph", () => {
    const n = nodes(40);
    expect(applyExtension(clip(n), n, 999, cfg)).toBeNull();
  });

  it("keeps the payoff, hook and start untouched", () => {
    const n = nodes(40);
    const before = clip(n);
    const out = applyExtension(before, n, 8, cfg)!;
    expect(out.startSec).toBe(before.startSec);
    expect(out.payoffSec).toBe(before.payoffSec);
    expect(out.hookStartSec).toBe(before.hookStartSec);
    expect(out.finalStartNode).toBe(before.finalStartNode);
  });
});

// ---------------------------------------------------------------------------
// Everything below was added after mutation-testing the suite above. Nineteen
// of the twenty-nine mutations of this module and its knobs that ran against
// those ten cases SURVIVED them - including deleting the opaque-node gate, the
// clean-end gate and the maxSec gate outright - so the ten proved almost
// nothing about the gates. Each case here names the mutation it kills, because
// a gate nobody can prove fires is worse than no gate: it buys false confidence.
//
// Two warnings for whoever runs the next matrix over this file. A mutant that
// FAILS TO APPLY is an error, never a kill - one of these had a find-string go
// stale against a return that grew multi-line, and subtracting survivors from
// the total published it as a kill. Check the error count first.
//
// And three mutations here are EQUIVALENT, so do not go hunting for a case that
// kills them: (1) starting the window loop at `from` rather than `from + 1` -
// `last` is already `from`, and the deadline is at or after nodes[from].end for
// any non-negative window; (2) dropping applyExtension's in-graph gate - the
// window can never return an index outside the graph, so the window gate
// already refuses everything that one would; (3) the `: null` branch of the
// `next` lookup - nodes[len] is undefined, which the guard beside it treats
// identically. All three were checked over 20000 random graphs, and (2) and (3)
// are kept deliberately - end-extension.ts says why at each.
// ---------------------------------------------------------------------------

/** Window wide enough that maxSec, not the window, is the binding gate. */
const cfgWide = loadAnalyzeConfig({
  SCENE_GAP_SEC: "8",
  END_EXTENSION_WINDOW_SEC: "1000",
});

describe("extensionWindow bounds", () => {
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
  // their successor's start for real - nested word timings, snap.ts:168.
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

describe("applyExtension gates", () => {
  // Kills dropping Number.isInteger. A model that answers 8.5 - or a NaN from a
  // parsed empty string - must be refused, not indexed into the graph: nodes[8.5]
  // is undefined and every gate after it reads a property off it.
  it("refuses a proposal that is not a whole node index", () => {
    const n = nodes(40);
    expect(applyExtension(clip(n), n, 8.5, cfg)).toBeNull();
    expect(applyExtension(clip(n), n, Number.NaN, cfg)).toBeNull();
    expect(applyExtension(clip(n), n, Number.POSITIVE_INFINITY, cfg)).toBeNull();
  });

  // Kills `> nodes.length - 1` -> `>=`. The last node in the graph is a legal
  // end - it is where every clip at the end of a video has to stop - and the
  // bounds gate must reject only what is genuinely outside.
  //
  // Also kills dropping the `next` null-guard (nodes[len] is undefined, and
  // reading .start off it throws) and kills tailHoldSec -> 0: with nothing
  // after it, the last node gets the full tail hold and no bleed cap.
  it("accepts the last node in the graph and holds the full tail there", () => {
    const n = nodes(10);
    const out = applyExtension(clip(n), n, 9, cfg);
    expect(out).not.toBeNull();
    expect(out!.finalEndNode).toBe(9);
    expect(out!.endSec).toBeCloseTo(n[9].end + cfg.tailHoldSec, 6);
  });

  // Kills `> lastNode` -> `>= lastNode`, on BOTH branches of the window, which
  // is the pair the scene rail's contract turns on: the window is the tighter
  // of the scene cut and the clock, and whichever one is tighter must be
  // reachable and the node past it refused. If only one branch were covered the
  // other could disappear without a red test.
  it("accepts exactly the last node the scene allows and refuses the next", () => {
    const n = nodes(20, 8);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(7);
    expect(applyExtension(clip(n), n, 7, cfg)!.finalEndNode).toBe(7);
    expect(applyExtension(clip(n), n, 8, cfg)).toBeNull();
  });

  it("accepts exactly the last node the clock allows and refuses the next", () => {
    const n = nodes(40);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(17);
    expect(applyExtension(clip(n), n, 17, cfg)!.finalEndNode).toBe(17);
    expect(applyExtension(clip(n), n, 18, cfg)).toBeNull();
  });

  // The tightest crossing: the node immediately after the cut. A window loop
  // that ran one index too far would hand the clip the first line of an
  // unrelated scene, which is the single thing the scene rail exists to stop.
  it("refuses the very first node on the far side of a cut", () => {
    const n = nodes(20, 6);
    expect(applyExtension(clip(n), n, 6, cfg)).toBeNull();
  });

  // Kills dropping the hasWords gate. trailingStrength stays 1 so the node
  // still passes isCleanEnd - opacity has to be the ONLY reason this is
  // refused. An opaque node's timings are segment-level, not word-level (music,
  // laughter, crosstalk), so ending a clip on one puts the boundary at a coarse
  // Whisper edge; snap.ts walks BACK off opaque ends for the same reason, and
  // this stage must not walk onto one.
  it("refuses an opaque node as the new end", () => {
    const n = nodes(40);
    n[8] = { ...n[8], hasWords: false };
    expect(applyExtension(clip(n), n, 8, cfg)).toBeNull();
  });

  // Kills dropping the isCleanEnd gate. Node 8 keeps its words, so the clean-end
  // test is the only thing that can refuse it: a weak trailing boundary followed
  // by a node that does not open cleanly is a mid-clause cut ("...искала ты его
  // потому,"), and extending onto one trades a short clip for a broken one.
  it("refuses an end that leaves the sentence open", () => {
    const n = nodes(40);
    n[8] = { ...n[8], trailingStrength: 0.2 };
    n[9] = { ...n[9], leadingStrength: 0.2, text: "and then." };
    expect(applyExtension(clip(n), n, 8, cfg)).toBeNull();
    // and the node before it, which IS a clean end, is still accepted - the
    // gate must refuse this node, not the whole neighbourhood
    expect(applyExtension(clip(n), n, 7, cfg)!.finalEndNode).toBe(7);
  });

  // Kills dropping the maxSec gate AND `> maxSec` -> `>= maxSec`. The plan's
  // "refuses a move that would push the clip past maxSec" does neither: with a
  // 25s window the proposal it makes is already refused by the window gate, so
  // maxSec could be deleted entirely and that test stays green. Only a window
  // wide enough to let the clip reach 90s tests the length cap at all.
  it("accepts a clip landing exactly on maxSec and refuses the next node", () => {
    const n = nodes(200);
    const c = clip(n);
    const at = applyExtension(c, n, 46, cfgWide)!;
    expect(at.endSec - c.startSec).toBe(cfgWide.maxSec);
    expect(applyExtension(c, n, 47, cfgWide)).toBeNull();
  });

  // Kills dropping the Math.min bleed cap. The tail hold is silence to breathe
  // in, never a licence to play the next speaker's first word - the same cap
  // snap.ts:122 applies. Here node 9 starts the instant node 8 ends, so the
  // whole 0.3s hold has to be given up.
  it("never lets the tail hold bleed into the next line", () => {
    const n = nodes(40);
    const out = applyExtension(clip(n), n, 8, cfg)!;
    expect(out.endSec).toBe(n[9].start);
  });

  // Kills dropping the Math.max last-word clamp. Word timings nest, so a node
  // can end AFTER its successor starts (snap.ts:168); the bleed cap must never
  // then cut the last word of the very line the clip is being extended to.
  it("never cuts the last word of the new end node", () => {
    const n = nodes(40);
    n[8] = { ...n[8], end: 19 };
    const out = applyExtension(clip(n), n, 8, cfg)!;
    expect(out.endSec).toBe(19);
  });

  // Kills mutating the input in place. The plan's "keeps the payoff, hook and
  // start untouched" compares the RESULT against an object that in-place
  // mutation has already changed, so it passes for a function that overwrites
  // its argument. Clips are handed around by reference between stages; a
  // refusal or an acceptance must not reach back into the caller's copy.
  it("returns a new clip and leaves the caller's copy alone", () => {
    const n = nodes(40);
    const before = clip(n);
    const out = applyExtension(before, n, 8, cfg)!;
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
    expect(applyExtension(c, n, 6, cfg)).toBeNull();
  });

  // The index gate is NOT made redundant by the seconds gate, and this is the
  // case that proves it. Node 3 runs to 30.0 because one of its words does, so
  // proposing it moves the end BACKWARD by two nodes while moving the clock
  // forward by 18s: it passes the seconds gate on the way out. The result would
  // be a clip whose node range no longer contains its own titleEvidenceNodes
  // (node 4 here), which is the copy-degrading shape this stage is built never
  // to produce (engine-notes §6).
  it("refuses an earlier node even when its nested timings would end later", () => {
    const n = nodes(40);
    n[3] = { ...n[3], end: 30 };
    const c = clip(n);
    expect(c.verdict.titleEvidenceNodes).toContain(4);
    expect(applyExtension(c, n, 3, cfg)).toBeNull();
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
    expect(applyExtension(c, n, 5, cfg)).toBeNull();
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
    expect(applyExtension(c, n, 6, cfg)).toBeNull();
  });

  // The whole-object invariant, swept rather than spot-checked: across every
  // proposal this fixture admits, an accepted extension moves the end and
  // NOTHING else. Copy is grounded against [finalStartNode, finalEndNode]
  // before this stage runs, so widening that range is safe and moving anything
  // else in it is not (engine-notes §6, "boundaries are code-owned").
  it("moves the end forward and changes nothing else, for every legal proposal", () => {
    const n = nodes(40);
    const before = clip(n);
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const out = applyExtension(before, n, i, cfg);
      if (!out) continue;
      accepted++;
      expect(out.finalEndNode).toBeGreaterThan(before.finalEndNode);
      expect(out.endSec).toBeGreaterThan(before.endSec);
      expect(out.startSec).toBe(before.startSec);
      expect(out.finalStartNode).toBe(before.finalStartNode);
      expect(out.payoffSec).toBe(before.payoffSec);
      expect(out.hookStartSec).toBe(before.hookStartSec);
      expect(out.hookEndSec).toBe(before.hookEndSec);
      expect(out.verdict).toBe(before.verdict);
      // the two fields that DO move are the two derived from the end
      expect(out.shortMoment).toBe(out.endSec - out.startSec < cfg.targetMinSec);
      expect(out.endsOnQuestion).toBe(false);
    }
    expect(accepted).toBe(12); // nodes 6..17, the whole window
  });
});

describe("applyExtension keeps the clip describing its own end", () => {
  // shortMoment is a verdict on LENGTH and this stage changes the length. It is
  // persisted onto the highlight (index.ts, toHighlight), so a carried-forward
  // `true` would file a 14s clip as a fragment.
  it("recomputes shortMoment against the new duration", () => {
    const n = nodes(40);
    const wasShort = { ...clip(n), shortMoment: true };
    const out = applyExtension(wasShort, n, 8, cfg)!;
    expect(out.endSec - out.startSec).toBeGreaterThanOrEqual(cfg.targetMinSec);
    expect(out.shortMoment).toBe(false);
  });

  // And it uses snap's definition of short, strictly under the target, so the
  // same clip carries the same flag whichever stage last set its end
  // (snap.ts:204). A clip landing exactly on the target is not short.
  it("calls a clip exactly on the target not short, as snap does", () => {
    const n = nodes(40);
    const exact = loadAnalyzeConfig({
      SCENE_GAP_SEC: "8",
      END_EXTENSION_WINDOW_SEC: "25",
      CLIP_TARGET_MIN_SEC: "14",
    });
    const out = applyExtension(clip(n), n, 8, exact)!;
    expect(out.endSec - out.startSec).toBe(exact.targetMinSec);
    expect(out.shortMoment).toBe(false);
  });

  // endsOnQuestion names the clip's LAST sentence. Reaching the answer to a
  // question the clip ended on is one of the beats this stage exists to reach,
  // so the flag has to move with the end - in both directions.
  it("recomputes endsOnQuestion from the new end node", () => {
    const n = nodes(40);
    const asked = { ...clip(n), endsOnQuestion: true };
    expect(applyExtension(asked, n, 8, cfg)!.endsOnQuestion).toBe(false);

    n[8] = { ...n[8], text: "line 8?" };
    expect(applyExtension(clip(n), n, 8, cfg)!.endsOnQuestion).toBe(true);
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
});
