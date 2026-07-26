import { describe, expect, it } from "vitest";
import { snapNodes } from "../analyze-v2/snap";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

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
});
