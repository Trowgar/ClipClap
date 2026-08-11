import { describe, expect, it } from "vitest";
import { compressToFit, snapNodes } from "../analyze-v2/snap";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});
const longCfg = loadAnalyzeConfig({ LONG_CLIPS: "on" });

/** 20 nodes x 2s each, all strong sentence boundaries. */
function strongNodes(): SentenceNode[] {
  return Array.from({ length: 20 }, (_, i) => ({
    index: i,
    start: i * 2,
    end: i * 2 + 1.8,
    text: `Sentence ${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function verdict(p: Partial<CriticVerdict>): CriticVerdict {
  return {
    id: "c0",
    keep: true,
    score: 0.8,
    grounded: true,
    selfContained: true,
    startNode: 2,
    payoffNode: 6,
    endNode: 7,
    hookStartNode: 5,
    hookEndNode: 6,
    title: "t",
    description: "d",
    titleEvidenceNodes: [6],
    descriptionEvidenceNodes: [6],
    language: "en",
    ...p,
  };
}

describe("snapNodes", () => {
  it("snaps a clean clip to word edges with lead-in and tail-hold", () => {
    const r = snapNodes(verdict({}), strongNodes(), cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.startSec).toBeCloseTo(4 - cfg.leadInSec, 5);
    // tail-hold capped at the next node's onset: min(15.8 + 0.3, 16) = 16
    expect(r.clip.endSec).toBeCloseTo(16, 5);
    expect(r.clip.payoffSec).toBeCloseTo(13.8, 5);
    expect(r.clip.shortMoment).toBe(false);
  });

  it("accepts a hook that opens the clip exactly (epsilon, not strict <)", () => {
    const r = snapNodes(verdict({ hookStartNode: 2 }), strongNodes(), cfg);
    expect(r.ok).toBe(true);
  });

  it("forces end at or after the payoff", () => {
    const r = snapNodes(verdict({ endNode: 4, payoffNode: 6 }), strongNodes(), cfg);
    if (!r.ok) throw new Error("should not drop");
    expect(r.clip.endSec).toBeGreaterThanOrEqual(13.8);
  });

  it("drops when the start is weak and no strong boundary is within reach", () => {
    const nodes = strongNodes().map((n, i) =>
      i <= 3 ? { ...n, leadingStrength: 0.3, trailingStrength: 0.3 } : n
    );
    const r = snapNodes(verdict({ startNode: 3, hookStartNode: 5 }), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "no_clean_start" });
  });

  it("drops sub-6s clips instead of extending them", () => {
    const r = snapNodes(
      verdict({ startNode: 5, payoffNode: 5, endNode: 5, hookStartNode: 5, hookEndNode: 5 }),
      strongNodes(),
      cfg
    );
    // single 1.8s node -> too_short (hookEnd==hookStart also violates, either drop is fine)
    expect(r.ok).toBe(false);
  });

  it("flags 6-8s clips as shortMoment without extending", () => {
    // three 2s nodes -> ~6.4s with lead-in/tail-hold
    const r = snapNodes(
      verdict({ startNode: 5, payoffNode: 7, endNode: 7, hookStartNode: 6, hookEndNode: 7 }),
      strongNodes(),
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.shortMoment).toBe(true);
    expect(r.clip.endSec - r.clip.startSec).toBeLessThan(8);
  });

  it("accepts an opaque payoff at segment confidence instead of dropping", () => {
    // punchline drowned in laughter: words unreliable, segment edges real
    const nodes = strongNodes().map((n, i) => (i === 6 ? { ...n, hasWords: false } : n));
    const r = snapNodes(verdict({}), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.boundaryConfidence).toBe("segment");
    expect(r.clip.endSec).toBeGreaterThanOrEqual(nodes[6].end);
  });

  it("treats a start right after an opaque node as a clean cold open", () => {
    // music break before the sentence: leadingStrength inherits 0.2 but the
    // gap itself is a strong semantic boundary
    const nodes = strongNodes().map((n, i) =>
      i === 4 ? { ...n, hasWords: false } : i === 5 ? { ...n, leadingStrength: 0.2 } : n
    );
    const r = snapNodes(
      verdict({ startNode: 5, payoffNode: 7, endNode: 8, hookStartNode: 6, hookEndNode: 7 }),
      nodes,
      cfg
    );
    expect(r.ok).toBe(true);
  });

  it("walks an opaque end back and re-checks payoff containment", () => {
    const nodes = strongNodes().map((n, i) => (i >= 7 ? { ...n, hasWords: false } : n));
    const r = snapNodes(verdict({ endNode: 8 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec).toBeGreaterThanOrEqual(nodes[6].end); // last word-bearing node covers payoff
  });

  it("clamps a nested prev.end at the start node onset instead of cutting into it", () => {
    // node1's words nest past node2's onset (legal nested-word input);
    // the start must land exactly at node2.start, not at prev.end.
    const nodes = strongNodes().map((n, i) => (i === 1 ? { ...n, end: 5.5 } : n));
    const r = snapNodes(verdict({}), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.startSec).toBe(4);
  });

  it("salvages a clip whose start and end nodes are both opaque", () => {
    const nodes = strongNodes()
      .slice(0, 12)
      .map((n, i) => {
        if (i === 3) return { ...n, hasWords: false, leadingStrength: 0.3 };
        if (i === 8) return { ...n, hasWords: false };
        return n;
      });
    const r = snapNodes(
      verdict({ startNode: 3, payoffNode: 6, endNode: 8, hookStartNode: 6, hookEndNode: 6 }),
      nodes,
      cfg
    );
    expect(r.ok).toBe(true);
  });

  it("extends the end for a nested payoff that outlasts the end node", () => {
    // payoff node6's last word runs to 20s, past endNode 7's end (15.8s);
    // payoff containment outranks the bleed cap - extend, don't drop.
    const nodes = strongNodes().map((n, i) => (i === 6 ? { ...n, end: 20 } : n));
    const r = snapNodes(verdict({}), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec).toBeGreaterThanOrEqual(20);
  });

  it("vetoes a lowercase pause-boundary start and walks back to a real sentence onset", () => {
    // CLIP4 regression: a hesitation pause minted a fake 0.8 boundary before
    // "глаза на все её хотелки" - the lowercase onset must veto it and the
    // walk-back must land on the earlier capitalized sentence start.
    const nodes = strongNodes().map((n, i) =>
      i === 3
        ? { ...n, text: "глаза на все её хотелки.", leadingStrength: 0.8 }
        : n
    );
    const r = snapNodes(verdict({ startNode: 3 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    // node2 is the nearest clean (capitalized, strong) start within reach
    expect(r.clip.startSec).toBeCloseTo(nodes[2].start - cfg.leadInSec, 5);
  });

  it("trims a weak comma end back to the sentence-final payoff", () => {
    // CLIP3 regression: end lands on "...искала ты его потому," (weak trailing,
    // lowercase continuation follows) - repair must trim BACK to the payoff's
    // terminal boundary, not swallow the next sentence forward.
    const nodes = strongNodes().map((n, i) => {
      if (i === 7) return { ...n, text: "которого не существует,", trailingStrength: 0.4, leadingStrength: 0.4 };
      if (i === 8) return { ...n, text: "а искала ты его потому,", trailingStrength: 0.4, leadingStrength: 0.4 };
      // real graphs derive leadingStrength from the previous node's trailing
      if (i === 9) return { ...n, leadingStrength: 0.4 };
      return n;
    });
    const r = snapNodes(verdict({ payoffNode: 6, endNode: 8 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    // trimmed to node6 ("Sentence 6." trailing 1.0): endSec = min(13.8 + 0.3, 14) = 14
    expect(r.clip.endSec).toBeCloseTo(14, 5);
  });

  it("drops with no_clean_end when no clean boundary exists near the payoff", () => {
    const nodes = strongNodes().map((n, i) =>
      i >= 5 && i <= 9
        ? { ...n, text: "и снова без точки,", trailingStrength: 0.4, leadingStrength: 0.4 }
        : n
    );
    // payoff and end both sit inside the weak run; forward slack (3s) cannot
    // reach node 10 (17.8s away from node 6's end), backward finds nothing >= payoff
    const r = snapNodes(
      verdict({ startNode: 2, payoffNode: 6, endNode: 6, hookStartNode: 5, hookEndNode: 6 }),
      nodes,
      cfg
    );
    expect(r).toEqual({ ok: false, reason: "no_clean_end" });
  });

  // -------------------------------------------------------------------------
  // Forward clean-end repair onto an OPAQUE node.
  //
  // The completion of a sentence a word-bearing node left open frequently lives
  // in the very next node, which is opaque - Whisper lost the word timings to
  // laughter or crosstalk but still transcribed the segment, with punctuation.
  // Ending there is not a new kind of clip: 12 of the 44 clips the four eval
  // fixtures ship already end on an opaque node, at "segment" confidence.
  //
  // These build the ecology #576/#577 geometry by hand: a weak-ended node, then
  // an opaque node whose text completes the sentence 4.22s later.
  // -------------------------------------------------------------------------

  /** node 8 ends mid-clause; node 9 is opaque and `text` decides its fate. */
  function opaqueTailNodes(text: string, opaqueEnd = 18 + 4.22): SentenceNode[] {
    return strongNodes().map((n, i) => {
      if (i === 7) return { ...n, text: "Без разумного вида,", trailingStrength: 0.4, leadingStrength: 1.0 };
      if (i === 8) {
        // the clip's end node: weak trailing, opaque successor
        return { ...n, text: "строящего космические корабли,", trailingStrength: 0.8, leadingStrength: 0.4, end: 18 };
      }
      if (i === 9) return { ...n, hasWords: false, text, start: 18.3, end: opaqueEnd, leadingStrength: 0.8 };
      if (i === 10) return { ...n, start: opaqueEnd + 1, end: opaqueEnd + 2.8, leadingStrength: 0.2 };
      return n;
    });
  }

  const tailVerdict = { startNode: 2, payoffNode: 8, endNode: 8, hookStartNode: 5, hookEndNode: 6 };

  it("completes a dangling clause on the opaque node that carries the rest of the sentence", () => {
    const nodes = opaqueTailNodes("любая биосфера обречена, срок ее жизни ограничен сроком жизни звезды.");
    const r = snapNodes(verdict(tailVerdict), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.finalEndNode).toBe(9);
    // the opaque node's own segment edge, plus the tail hold, capped by the next
    // node's onset - snap's ordinary arithmetic, not a special case
    expect(r.clip.endSec).toBeCloseTo(22.22 + cfg.tailHoldSec, 5);
    expect(r.clip.boundaryConfidence).toBe("segment");
  });

  it("REFUSES an opaque node whose text does not close the sentence", () => {
    // The load-bearing half of the guard: without it the repair would end a clip
    // inside a laugh on any opaque node at all. answer-arc #847's real shape.
    const nodes = opaqueTailNodes("и с шеей, и с поясницей, и с тем, что роды стали сложнее,");
    const r = snapNodes(verdict(tailVerdict), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "no_clean_end" });
  });

  it("leaves a clip alone when the opaque successor is pure music", () => {
    // No letters means no evidence that speech continued, so the end was clean
    // all along and no repair runs. The clip keeps its own end node and word
    // confidence - this is the case the original "music follows" rule was
    // written for, and it must survive the change untouched.
    for (const text of ["", "[Музыка]", "♪♪♪"]) {
      const r = snapNodes(verdict(tailVerdict), opaqueTailNodes(text), cfg);
      if (!r.ok) throw new Error(`unexpected drop on ${JSON.stringify(text)}: ${r.reason}`);
      expect(r.clip.finalEndNode, JSON.stringify(text)).toBe(8);
      expect(r.clip.boundaryConfidence, JSON.stringify(text)).toBe("word");
    }
  });

  it("reaches an opaque completion at exactly the reach limit but not past it", () => {
    // The two offenders that motivated the 5s reach sit 4.22s out; the boundary
    // is pinned from both sides so widening it again is a deliberate act.
    const at = opaqueTailNodes("любая биосфера обречена.", 18 + 5);
    expect(snapNodes(verdict(tailVerdict), at, cfg).ok).toBe(true);

    const past = opaqueTailNodes("любая биосфера обречена.", 18 + 5.01);
    expect(snapNodes(verdict(tailVerdict), past, cfg)).toEqual({
      ok: false,
      reason: "no_clean_end",
    });
  });

  it("prefers a backward trim to reaching forward onto an opaque node", () => {
    // Repair order is BACKWARD first: trimming to a clean end at or after the
    // payoff never adds foreign content, while reaching forward always does.
    const nodes = opaqueTailNodes("любая биосфера обречена.").map((n, i) =>
      i === 7 ? { ...n, trailingStrength: 1.0 } : n
    );
    const r = snapNodes(verdict({ ...tailVerdict, payoffNode: 7 }), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.finalEndNode).toBe(7);
    expect(r.clip.boundaryConfidence).toBe("word");
  });

  it("takes the NEAREST forward completion, opaque or not", () => {
    // Both candidates are inside the reach here, so this really does choose. The
    // scan stops at the first node that can end the clip: every node in between
    // would play anyway, so the nearer end is the one that adds least.
    const nodes = strongNodes().map((n, i) => {
      if (i === 8) return { ...n, text: "космические корабли,", trailingStrength: 0.8, end: 18 };
      if (i === 9) {
        return { ...n, hasWords: false, text: "любая биосфера обречена.", start: 18.3, end: 20 };
      }
      // word-bearing, a legal clean end, and still inside the 5s reach at 4s out
      if (i === 10) return { ...n, start: 20.5, end: 22, trailingStrength: 1.0, leadingStrength: 0.2 };
      if (i === 11) return { ...n, start: 22.5, end: 24.3, leadingStrength: 1.0 };
      return n;
    });
    const r = snapNodes(verdict(tailVerdict), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.finalEndNode).toBe(9);
  });

  it("walks through a leading non-terminating opaque node to a later completion", () => {
    // A run of opaque nodes: the first cannot end the clip, the second can, and
    // both are inside the reach.
    const nodes = opaqueTailNodes("и с поясницей,", 18 + 1).map((n, i) =>
      i === 10
        ? { ...n, hasWords: false, text: "любая биосфера обречена.", start: 19.2, end: 21, leadingStrength: 0.2 }
        : i === 11
          ? { ...n, start: 22, end: 23.8, leadingStrength: 0.2 }
          : n
    );
    const r = snapNodes(verdict(tailVerdict), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.finalEndNode).toBe(10);
    expect(r.clip.boundaryConfidence).toBe("segment");
  });

  it("may end on an opaque node that is last in the graph", () => {
    const nodes = opaqueTailNodes("любая биосфера обречена.").slice(0, 10);
    const r = snapNodes(verdict(tailVerdict), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.finalEndNode).toBe(9);
    // no successor to cap the tail hold against
    expect(r.clip.endSec).toBeCloseTo(22.22 + cfg.tailHoldSec, 5);
  });

  it("never ends on a WORD-BEARING node just because its text closes a sentence", () => {
    // The sentence-mark test is for opaque nodes ONLY. A word-bearing node is
    // judged by isCleanEnd, which knows what follows it; its text is assembled
    // from word tokens and means much less.
    //
    // Reachable rather than theoretical: `Да!"` does not match the builder's
    // TERMINAL regex (which wants the mark at the very end), so such a node
    // really does carry a weak trailing boundary AND a sentence-final mark.
    const nodes = strongNodes().map((n, i) => {
      if (i === 8) return { ...n, text: "космические корабли,", trailingStrength: 0.4, end: 18 };
      if (i === 9) {
        return { ...n, text: 'Да!"', trailingStrength: 0.4, leadingStrength: 0.4, start: 18.3, end: 20 };
      }
      if (i === 10) {
        return { ...n, text: "и дальше", trailingStrength: 0.4, leadingStrength: 0.4, start: 20.3, end: 22 };
      }
      if (i === 11) return { ...n, leadingStrength: 0.4, start: 22.5, end: 24.3 };
      return n;
    });
    const r = snapNodes(verdict(tailVerdict), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "no_clean_end" });
  });

  it("takes the nearest of two word-bearing forward completions", () => {
    // The opaque case is covered above; this pins the same nearest-wins rule on
    // the branch that was already there, with both candidates inside the reach.
    const nodes = strongNodes().map((n, i) => {
      if (i === 8) return { ...n, text: "космические корабли,", trailingStrength: 0.4, end: 18 };
      if (i === 9) {
        return { ...n, text: "Первый чистый конец.", leadingStrength: 0.4, start: 18.3, end: 20 };
      }
      if (i === 10) return { ...n, text: "Второй чистый конец.", start: 20.3, end: 22 };
      if (i === 11) return { ...n, start: 22.5, end: 24.3 };
      return n;
    });
    const r = snapNodes(verdict(tailVerdict), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.finalEndNode).toBe(9);
  });

  it("never trims BACKWARD onto an opaque node", () => {
    // The backward walk keeps its word-bearing requirement. Landing on an opaque
    // node here would swap a word edge for a coarse segment edge while still
    // reporting "word" confidence - a silent lie about the boundary. Reaching
    // forward onto one is a different decision: there it is the only way to
    // close the sentence, and it marks the clip accordingly.
    const nodes = strongNodes().map((n, i) => {
      if (i === 7) return { ...n, trailingStrength: 0.4 };
      if (i === 8) {
        return { ...n, hasWords: false, text: "Новая мысль.", trailingStrength: 0.2, leadingStrength: 0.4 };
      }
      if (i === 9) {
        return { ...n, text: "Продолжение", leadingStrength: 0.2, trailingStrength: 0.4 };
      }
      if (i === 10) return { ...n, text: "и дальше", leadingStrength: 0.4 };
      return n;
    });
    const r = snapNodes(
      verdict({ startNode: 2, payoffNode: 7, endNode: 9, hookStartNode: 5, hookEndNode: 6 }),
      nodes,
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.finalEndNode).toBe(7);
    expect(r.clip.boundaryConfidence).toBe("word");
  });

  it("does not repair an end that the opaque payoff forced", () => {
    // When the PAYOFF itself is opaque, snap keeps the opaque end and marks the
    // clip segment-confidence: that end is not a choice, it is where the payoff
    // is. Running the clean-end repair on it would move the boundary off the
    // payoff the critic named.
    const nodes = strongNodes().map((n, i) => {
      if (i === 8) {
        return { ...n, hasWords: false, text: "смех и аплодисменты", trailingStrength: 0.2 };
      }
      if (i === 9) {
        return { ...n, text: "и потом он добавил", leadingStrength: 0.2, trailingStrength: 1.0 };
      }
      return n;
    });
    const r = snapNodes(
      verdict({ startNode: 2, payoffNode: 8, endNode: 8, hookStartNode: 5, hookEndNode: 6 }),
      nodes,
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.finalEndNode).toBe(8);
    expect(r.clip.boundaryConfidence).toBe("segment");
  });

  it("keeps the payoff-containment fallback at its own 3s window", () => {
    // The forward clean-end reach was widened to 5s; the payoff-tail fallback was
    // deliberately NOT, and they are separate constants for exactly this reason.
    // Node 10's strong boundary sits 8s past the payoff - inside payoffMaxTailSec
    // (4) + 5 but outside payoffMaxTailSec + 3 - so this reds the moment anyone
    // makes the fallback borrow the clean-end reach.
    const nodes = strongNodes().map((n, i) => {
      // weak payoff, or pickEnd would return it at once and the window would
      // never be consulted at all
      if (i === 6) return { ...n, trailingStrength: 0.4 };
      // opaque and sentence-final: keeps isCleanEnd(6) true (so no repair runs
      // and this case stays about the payoff window) while pickEnd skips it
      if (i === 7) return { ...n, hasWords: false, text: "Новая мысль.", leadingStrength: 0.4 };
      if (i === 8 || i === 9) return { ...n, trailingStrength: 0.4, leadingStrength: 0.4 };
      if (i === 10) return { ...n, leadingStrength: 0.4 }; // strong trailing, end 21.8 = payoff.end + 8
      return n;
    });
    const r = snapNodes(
      verdict({ startNode: 2, payoffNode: 6, endNode: 12, hookStartNode: 5, hookEndNode: 6 }),
      nodes,
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    // fell back to the payoff itself; reaching node 10 would mean the window grew
    expect(r.clip.finalEndNode).toBe(6);
  });

  it("flags clips whose final sentence is a question", () => {
    const nodes = strongNodes().map((n, i) =>
      i === 7 ? { ...n, text: "Так ли это? Самые ли мы страшные?" } : n
    );
    const r = snapNodes(verdict({}), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endsOnQuestion).toBe(true);
    const r2 = snapNodes(verdict({}), strongNodes(), cfg);
    if (!r2.ok) throw new Error("unexpected drop");
    expect(r2.clip.endsOnQuestion).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Real node tables from job cms2c8ahm000droa7tcqh30ho (the 52-minute podcast
  // the owner cut by hand). Times, texts, hasWords and the strength pair are
  // verbatim from buildSentenceGraph on that transcript; only the INDICES are
  // rebased to 0 so a 25-node array can stand in for an 886-node graph. Each
  // table starts one node BEFORE the critic's start_node so the lead-in clamp
  // (prevS.end) reproduces the shipped second exactly - both tables replay the
  // real startSec to 0.01s, which is the point of using them.
  // ---------------------------------------------------------------------------

  type Row = [number, number, boolean, number, number, string];

  function table(rows: Row[]): SentenceNode[] {
    return rows.map(([start, end, hasWords, leading, trailing, text], index) => ({
      index,
      start,
      end,
      text,
      hasWords,
      leadingStrength: leading,
      trailingStrength: trailing,
    }));
  }

  /** Graph nodes 804-828: "Самые живучие на планете". Critic range [804..826]
   *  = 98.6s against the 90s cap, so compression MUST fire. The interesting
   *  node is #806 (idx 2): an opaque node carrying the host's question, which
   *  makes #807 (idx 3) a clean start through isCleanStart's post-opaque
   *  branch even though its leadingStrength is only 0.20. */
  function survivalNodes(): SentenceNode[] {
    return table([
      [2831.52, 2838.86, true, 0.2, 0.8, "А вот устроить глобальную ядерную войнушку или убить себя совсем запредельным изменением климата"],
      [2839.46, 2850.16, true, 0.8, 0.8, "или отупеть до состояния совсем полена из за искусственного интеллекта вот это возможные сценарии"],
      [2850.16, 2856.18, false, 0.8, 0.2, "То есть, ну вообще, мне кажется, люди, наверное, самый живучий вид на планете или все-таки нет?"],
      [2856.32, 2860.42, true, 0.2, 0.8, "Ну как живучий смотря по каким параметрам сравнивать"],
      [2862.2, 2864.12, true, 0.8, 0.4, "Люди довольно долго живут"],
      [2864.56, 2865.66, true, 0.4, 0.8, "дольше других приматов"],
      [2867.38, 2873.96, false, 0.8, 0.2, "Люди могут размножаться быстрее, чем шимпанзе и гориллы."],
      [2874.34, 2877.94, false, 0.2, 0.2, "То есть, у шимпанзе и горилл детеныши могут кормить молоком лет до пяти."],
      [2877.94, 2879.54, true, 0.2, 0.4, "Люди очень выносливые"],
      [2880.04, 2882.28, true, 0.4, 0.8, "они могут ходить далеко и"],
      [2882.92, 2891.36, false, 0.8, 0.2, "И вот по выносливости с нами сравнимы только два вида млекопитающих."],
      [2892.94, 2894.08, true, 0.2, 0.8, "На почве выносливости"],
      [2894.4, 2897.52, false, 0.8, 0.2, "Ну да, они могут с нами ходить и не устать."],
      [2898.0, 2902.84, false, 0.2, 0.2, "С другой стороны, у людей довольно слабые мышцы."],
      [2902.84, 2909.72, false, 0.2, 0.2, "То есть, тот же объем мышечной ткани у нас дает раза в два меньше усилия."],
      [2910.08, 2913.74, false, 0.2, 0.2, "Люди это компенсировали, соответственно, оружием."],
      [2914.38, 2916.08, true, 0.2, 0.8, "Начиная с камней дубинок"],
      [2916.9, 2917.62, true, 0.8, 0.4, "копья луки"],
      [2917.98, 2918.78, true, 0.4, 0.8, "стрелы и так далее"],
      [2919.3, 2920.2, true, 0.8, 0.8, "Результат вы видите"],
      [2921.5, 2923.74, true, 0.8, 0.8, "Те хищники которые копьями не пользовались"],
      [2925.48, 2927.24, true, 0.8, 0.8, "остались часто в красной книге"],
      [2927.54, 2930.0, false, 0.8, 0.2, "Ну так в итоге мы самые живучие на планете."],
      [2930.0, 2931.86, true, 0.2, 0.4, "По части устойчивости к ядам"],
      [2932.46, 2933.84, true, 0.4, 0.8, "крысы гораздо живучее нас"],
    ]);
  }

  /** Critic verdict for the table above: [804..826], payoff 826, hook 823-826. */
  const survivalVerdict = () =>
    verdict({ startNode: 0, payoffNode: 22, endNode: 22, hookStartNode: 19, hookEndNode: 22 });

  /** Graph nodes 753-772: "Как неандертальские гены влияют на психику".
   *  Critic range [754..771] = 91.5s, 1.5s over the cap. */
  function neanderthalNodes(): SentenceNode[] {
    return table([
      [2582.82, 2587.26, false, 0.2, 0.2, "Та часть, которая всегда жила в Африке, у нее неандертальская ДНК взяться неоткуда."],
      [2587.36, 2592.5, true, 0.2, 0.8, "А вот те которые перешли в Евразию столкнулись там с неандертальцами и в том числе скрестились"],
      [2592.76, 2599.1, true, 0.8, 0.8, "Поэтому все неафриканское человечество имеет там какие то полпроцента неандертальской ДНК"],
      [2599.36, 2602.04, true, 0.8, 0.8, "А как это влияет на человека"],
      [2602.06, 2603.18, true, 0.8, 0.8, "А вот это ученые спорят"],
      [2603.18, 2608.0, false, 0.8, 0.2, "Потому что там неандертальские варианты генов встречаются в разных генах."],
      [2608.1, 2612.08, true, 0.2, 0.8, "Многие из которых связаны либо с иммунитетом либо с работой мозга"],
      [2612.2, 2619.58, false, 0.8, 0.2, "Но и те варианты, которые связаны с иммунитетом, они скорее связаны были со встречей с новым."],
      [2619.78, 2620.86, false, 0.2, 0.2, "Более холодном, чем в Африке."],
      [2621.26, 2625.5, false, 0.2, 0.2, "Что-то там было связано с жировой тканью."],
      [2625.5, 2629.64, true, 0.2, 0.8, "А то что в мозге оно в современных условиях"],
      [2629.96, 2632.96, true, 0.8, 0.8, "Неандертальские варианты скорее связаны с чем то неприятным"],
      [2634.3, 2638.24, true, 0.8, 0.8, "какими то неврологическими или психиатрическими расстройствами"],
      [2638.72, 2642.44, false, 0.8, 0.2, "То есть у меня депрессия из-за неандертальских генов?"],
      [2642.74, 2646.52, true, 0.2, 0.8, "Вклад конкретно неандертальских генов в депрессию он в среднем очень маленький"],
      [2646.72, 2649.58, true, 0.8, 0.8, "куча других причин но нет Но он измеримый он есть"],
      [2649.58, 2658.58, false, 0.8, 0.2, "Ну и судя по тому, что мы знаем про жизнь неандертальцев, группы могли жить обособленно."],
      [2659.66, 2661.74, false, 0.2, 0.2, "То есть они были менее общительными."],
      [2662.6, 2678.76, false, 0.2, 0.2, "То есть я видел гипотезы, что неандертальская норма - это ближе к аутистическому спектру."],
      [2678.76, 2683.38, false, 0.2, 0.2, "А вот как определить, есть у меня гены неандертальца или нет?"],
    ]);
  }

  /** Critic verdict for the table above: [754..771], payoff 771, hook 756-765. */
  const neanderthalVerdict = () =>
    verdict({ startNode: 1, payoffNode: 18, endNode: 18, hookStartNode: 3, hookEndNode: 12 });

  it("compresses onto a post-opaque clean start the leadingStrength test cannot see", () => {
    // Job cms2c8ahm, "Самые живучие на планете". The critic's 98.6s range must
    // lose ~9s. leadingStrength >= 0.8 walks past idx 3 (#807, lead 0.20 behind
    // an opaque node) and lands on idx 4 (#808, lead 0.80), deleting the framing
    // the whole clip answers - "смотря по каким параметрам сравнивать" - and
    // 30.7s more than the cap required. isCleanStart, the definition every other
    // start decision in the engine uses, accepts idx 3.
    const nodes = survivalNodes();
    const r = snapNodes(survivalVerdict(), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.startSec).toBeCloseTo(2856.18, 2); // #807 onset, clamped by #806's end
    expect(r.clip.endSec - r.clip.startSec).toBeCloseTo(73.82, 2);
  });

  it("takes the EARLIEST legal start that fits - compression deletes the minimum", () => {
    // Job cms2c8ahm, "Как неандертальские гены влияют на психику": 91.5s against
    // the 90s cap. Two legal starts fit - idx 2 (86.1s) and idx 3 (79.6s) - and
    // compression must take the first, because a later one deletes strictly more
    // of a clip the critic already approved. Preferring the LATEST fitting start
    // would land here on idx 3 and on idx 21 in the survival table.
    const nodes = neanderthalNodes();
    const r = snapNodes(neanderthalVerdict(), nodes, cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.startSec).toBeCloseTo(2592.61, 2);
    expect(r.clip.endSec - r.clip.startSec).toBeCloseTo(86.15, 2);
  });

  it("drops an over-length clip with no clean start ahead instead of shipping it broken", () => {
    // Same real geometry, every forward onset lowercased: isCleanStart refuses
    // all of them, so there is nothing legal to compress onto. Better lost than
    // broken - shipping means either a >90s clip or a mid-sentence opening.
    const nodes = survivalNodes().map((n, i) =>
      i === 0 ? n : { ...n, text: n.text.toLowerCase() }
    );
    const r = snapNodes(survivalVerdict(), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "too_long" });
  });

  it("never compresses past the hook the critic chose", () => {
    // hookStartNode caps the walk. With the hook at idx 1 the only candidate is
    // idx 1 itself, which still measures 90.7s, so the clip drops rather than
    // eating into the hook to make the cap.
    const r = snapNodes(
      verdict({ startNode: 0, payoffNode: 22, endNode: 22, hookStartNode: 1, hookEndNode: 22 }),
      survivalNodes(),
      cfg
    );
    expect(r).toEqual({ ok: false, reason: "too_long" });
  });

  it("reports the node range that actually shipped, not the critic's proposal", () => {
    const r = snapNodes(survivalVerdict(), survivalNodes(), cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    // critic asked for [0..22]; compression moved the start to idx 3
    expect(r.clip.verdict.startNode).toBe(0);
    expect(r.clip.finalStartNode).toBe(3);
    expect(r.clip.finalEndNode).toBe(22);
  });

  it("reports a final range that tracks an end the payoff rules moved", () => {
    // endNode 9 drags 6.0s past payoff node 6, more than payoffMaxTailSec, so
    // the end is pulled back to the payoff's own terminal boundary. The reported
    // end node must follow it - otherwise the range lies about 3 whole nodes.
    const r = snapNodes(verdict({ payoffNode: 6, endNode: 9 }), strongNodes(), cfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.verdict.endNode).toBe(9);
    expect(r.clip.finalStartNode).toBe(2);
    expect(r.clip.finalEndNode).toBe(6);
  });

  it("compresses >90s clips from the start along strong boundaries, keeping the hook", () => {
    const nodes: SentenceNode[] = Array.from({ length: 60 }, (_, i) => ({
      index: i,
      start: i * 2,
      end: i * 2 + 1.9,
      text: `S${i}.`,
      hasWords: true,
      trailingStrength: 1.0,
      leadingStrength: 1.0,
    }));
    const r = snapNodes(
      verdict({ startNode: 0, payoffNode: 55, endNode: 56, hookStartNode: 54, hookEndNode: 55 }),
      nodes,
      cfg
    );
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec - r.clip.startSec).toBeLessThanOrEqual(90);
    expect(r.clip.startSec).toBeLessThanOrEqual(nodes[54].start);
  });

  // ---------------------------------------------------------------------------
  // Long-clip deferral (spec 2026-08-10 §2e, task 5). The mechanism under test
  // is `endSec - startSec > cfg.maxSec` (branch entered at all) crossed with
  // `cfg.longClipsEnabled && span <= cfg.longClipMaxSec` (defer instead of
  // compress). The DEFAULT reading of an unset `overLength` is "false" -
  // absent - so every test below that expects `true` has to make the
  // mechanism overcome that default, not merely fail to contradict it
  // (memory: feedback_test_matches_default).
  //
  // A single node, both start and end and payoff and hook, makes the SPAN a
  // pure function of one number (node0.end) via startSecFor/endSecFor's own
  // arithmetic: startSec is pinned at 0 (no predecessor, no lead-in room
  // below it), endSec is node0.end + tailHoldSec (no successor to cap
  // against). hookStartNode=hookEndNode=0 still satisfies
  // `hookStartSec < hookEndSec` because those read `.start` and `.end` of the
  // SAME node, which differ by construction. This buys exact control over the
  // span down to hundredths of a second without fighting lead-in/tail-hold
  // nesting on a bigger table.
  // ---------------------------------------------------------------------------

  function oneNodeClip(endTime: number): SentenceNode[] {
    return [
      {
        index: 0,
        start: 0,
        end: endTime,
        text: "Sentence zero.",
        hasWords: true,
        trailingStrength: 1.0,
        leadingStrength: 1.0,
      },
    ];
  }

  const oneNodeVerdict = () =>
    verdict({ startNode: 0, payoffNode: 0, endNode: 0, hookStartNode: 0, hookEndNode: 0 });

  it("does not mark a span that fits maxSec, flag on or off", () => {
    // span = maxSec exactly (90 = 89.7 + tailHoldSec 0.3): the over-length
    // branch is never even ENTERED (endSec - startSec > cfg.maxSec is false at
    // equality), so there is nothing to defer or compress either way - the
    // default absence of `overLength` is the mechanism's real answer here, not
    // an untested tie-break.
    const nodes = oneNodeClip(89.7);
    for (const c of [cfg, longCfg]) {
      const r = snapNodes(oneNodeVerdict(), nodes, c);
      if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
      expect(r.clip.endSec - r.clip.startSec).toBeCloseTo(90, 6);
      expect(r.clip.overLength).toBeUndefined();
    }
  });

  it("defers compression and marks overLength the instant the span crosses maxSec, flag on", () => {
    // span = 90.05s - one hundredth past the cap, within longClipMaxSec (150).
    // The single node has no room to compress onto (nothing before index 0),
    // so if the mechanism did NOT defer here it would drop `too_long` instead
    // of shipping - the two branches are impossible to confuse from outside.
    const nodes = oneNodeClip(89.75);
    const r = snapNodes(oneNodeVerdict(), nodes, longCfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec - r.clip.startSec).toBeCloseTo(90.05, 6);
    expect(r.clip.overLength).toBe(true);
    expect(r.clip.finalStartNode).toBe(0); // uncompressed - the start never moved
  });

  it("compresses the same 90.05s span exactly as today when the flag is off", () => {
    // Same clip as above, LONG_CLIPS off: today's path. The single node still
    // has no room to compress onto, so this drops - which is exactly what
    // this clip did before task 5 touched snap.ts, byte for byte (same
    // reason, "too_long").
    const nodes = oneNodeClip(89.75);
    const r = snapNodes(oneNodeVerdict(), nodes, cfg);
    expect(r).toEqual({ ok: false, reason: "too_long" });
  });

  it("still defers at exactly longClipMaxSec - the boundary is inclusive", () => {
    // span = 150 exactly (149.7 + 0.3).
    const nodes = oneNodeClip(149.7);
    const r = snapNodes(oneNodeVerdict(), nodes, longCfg);
    if (!r.ok) throw new Error(`unexpected drop: ${r.reason}`);
    expect(r.clip.endSec - r.clip.startSec).toBeCloseTo(150, 6);
    expect(r.clip.overLength).toBe(true);
  });

  it("stops deferring the instant the span crosses longClipMaxSec, even with the flag on", () => {
    // span = 150.05s - one hundredth past the long-clip ceiling. Compression
    // is attempted (not deferred), and this single node has nowhere to
    // compress onto, so it drops - the sharpest possible signal that the
    // mechanism took the compress branch and not the defer one.
    const nodes = oneNodeClip(149.75);
    const r = snapNodes(oneNodeVerdict(), nodes, longCfg);
    expect(r).toEqual({ ok: false, reason: "too_long" });
  });

  it("compresses a span over longClipMaxSec identically whether the flag is on or off", () => {
    // A real, multi-node over-length clip (174s, comfortably past both caps)
    // built the same way as "compresses >90s clips..." above. compressToFit
    // must fire on this exact path for both configs and land on the SAME
    // node - proving `longClipMaxSec` bounds only the DEFERRAL, never a second
    // `maxSec`.
    const nodes: SentenceNode[] = Array.from({ length: 90 }, (_, i) => ({
      index: i,
      start: i * 2,
      end: i * 2 + 1.9,
      text: `S${i}.`,
      hasWords: true,
      trailingStrength: 1.0,
      leadingStrength: 1.0,
    }));
    const v = verdict({ startNode: 0, payoffNode: 85, endNode: 86, hookStartNode: 84, hookEndNode: 85 });
    // The UNCOMPRESSED span, before either config's snapNodes call touches it:
    // node0's startSec is 0 (already clean, no walk-back), node86's endSec is
    // 174 (endSecFor, capped by node87's onset) - comfortably over
    // longClipMaxSec(150), so this fixture really does force compression
    // either way rather than accidentally fitting the deferral.
    expect(174 - 0).toBeGreaterThan(150);
    const flagOff = snapNodes(v, nodes, cfg);
    const flagOn = snapNodes(v, nodes, longCfg);
    if (!flagOff.ok) throw new Error(`unexpected drop (flag off): ${flagOff.reason}`);
    if (!flagOn.ok) throw new Error(`unexpected drop (flag on): ${flagOn.reason}`);
    expect(flagOff.clip.endSec - flagOff.clip.startSec).toBeLessThanOrEqual(cfg.maxSec);
    expect(flagOn.clip).toEqual(flagOff.clip);
    expect(flagOn.clip.overLength).toBeUndefined();
  });

  it("compressToFit picks the same earliest fit snapNodes's own compression used to inline", () => {
    // Extraction sanity check (spec task 5): replays the real job cms2c8ahm
    // survival-clip geometry already used above, calling compressToFit
    // directly instead of through snapNodes, and checks it lands on the same
    // node #807 (idx 3) the inline walk found before the extraction.
    const nodes = survivalNodes();
    const result = compressToFit(
      { startNode: 0, endSec: nodes[22].end, hookStartNode: 19 },
      nodes,
      cfg
    );
    expect(result).toEqual({ ok: true, startNode: 3, startSec: 2856.18 });
  });
});
