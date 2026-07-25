import { describe, expect, it } from "vitest";
import {
  normalizeHook,
  hookSimilarity,
  findHookDuplicates,
  resolveDuplicates,
  resolveDuplicatesDetailed,
  duplicateDropCap,
  MIN_HOOK_TOKENS,
} from "../analyze-v2/dedup";

describe("normalizeHook", () => {
  it("strips case, punctuation and extra whitespace", () => {
    expect(normalizeHook("Человек — это ЗЛО, для планеты  Земля!")).toBe(
      "человек это зло для планеты земля"
    );
  });

  it("handles an empty string", () => {
    expect(normalizeHook("   ")).toBe("");
  });

  it("drops the node marker and speaker punctuation the prompt format adds", () => {
    expect(normalizeHook("¶ - Человек, это зло...")).toBe("человек это зло");
  });

  it("keeps digits as tokens", () => {
    expect(normalizeHook("В 2026 году!")).toBe("в 2026 году");
  });
});

describe("hookSimilarity", () => {
  it("is 1 for identical openings ignoring punctuation and case", () => {
    expect(
      hookSimilarity(
        "Человек - это зло для планеты Земля",
        "человек это зло для планеты земля!"
      )
    ).toBe(1);
  });

  it("is 0 for unrelated openings", () => {
    expect(hookSimilarity("бактерии едят пластик", "разумный вид строит корабли")).toBe(0);
  });

  it("is 0 when either side is empty", () => {
    expect(hookSimilarity("", "что угодно")).toBe(0);
    expect(hookSimilarity("что угодно", "")).toBe(0);
    expect(hookSimilarity("", "")).toBe(0);
    expect(hookSimilarity("...", "!!!")).toBe(0);
  });

  it("is 1 for identical single-word openings", () => {
    expect(hookSimilarity("Слушай!", "слушай")).toBe(1);
  });

  it("is symmetric and penalises the longer side", () => {
    const a = "человек это зло для планеты земля";
    const b = "человек это зло";
    expect(hookSimilarity(a, b)).toBe(hookSimilarity(b, a));
    // 3 shared of 6 union
    expect(hookSimilarity(a, b)).toBeCloseTo(0.5, 6);
  });

  it("ignores repeated words - it compares distinct token sets", () => {
    expect(hookSimilarity("зло зло зло", "зло")).toBe(1);
  });
});

describe("findHookDuplicates", () => {
  const clips = [
    { id: "a", score: 0.9, hook: "Человек это зло для планеты Земля" },
    { id: "b", score: 0.86, hook: "Человек - это зло для планеты Земля!" },
    { id: "c", score: 0.7, hook: "Бактерии научились есть пластик" },
  ];

  it("marks the lower-scored twin, never the stronger one", () => {
    expect(findHookDuplicates(clips, 0.8)).toEqual([{ id: "b", duplicateOf: "a" }]);
  });

  it("finds nothing when openings differ", () => {
    expect(findHookDuplicates(clips.slice(1), 0.8)).toEqual([]);
  });

  it("is order-independent - input order does not change who survives", () => {
    const reversed = [...clips].reverse();
    expect(findHookDuplicates(reversed, 0.8)).toEqual([{ id: "b", duplicateOf: "a" }]);
  });

  it("breaks score ties by id so the pass is deterministic", () => {
    const tied = [
      { id: "b", score: 0.8, hook: "Человек это зло для планеты Земля" },
      { id: "a", score: 0.8, hook: "Человек это зло для планеты Земля" },
    ];
    expect(findHookDuplicates(tied, 0.8)).toEqual([{ id: "b", duplicateOf: "a" }]);
    expect(findHookDuplicates([...tied].reverse(), 0.8)).toEqual([
      { id: "b", duplicateOf: "a" },
    ]);
  });

  it("points every member of a triple at the single strongest clip", () => {
    const triple = [
      { id: "a", score: 0.9, hook: "Человек это зло для планеты Земля" },
      { id: "b", score: 0.8, hook: "человек - это зло для планеты земля" },
      { id: "c", score: 0.7, hook: "ЧЕЛОВЕК ЭТО ЗЛО ДЛЯ ПЛАНЕТЫ ЗЕМЛЯ." },
    ];
    expect(findHookDuplicates(triple, 0.8)).toEqual([
      { id: "b", duplicateOf: "a" },
      { id: "c", duplicateOf: "a" },
    ]);
  });

  it("respects the threshold - a partial overlap below it is not a duplicate", () => {
    const partial = [
      { id: "a", score: 0.9, hook: "Человек это зло для планеты Земля" },
      { id: "b", score: 0.8, hook: "Человек это зло" },
    ];
    expect(findHookDuplicates(partial, 0.8)).toEqual([]);
    expect(findHookDuplicates(partial, 0.5)).toEqual([{ id: "b", duplicateOf: "a" }]);
  });

  it("catches a one-node offset when the extra lead-in is short", () => {
    // Same spoken line, one clip starts on a short preceding clause.
    const offset = [
      { id: "a", score: 0.9, hook: "Человек это зло для планеты Земля" },
      { id: "b", score: 0.8, hook: "Знаешь, человек это зло для планеты Земля" },
    ];
    expect(hookSimilarity(offset[0].hook, offset[1].hook)).toBeGreaterThanOrEqual(0.8);
    expect(findHookDuplicates(offset, 0.8)).toEqual([{ id: "b", duplicateOf: "a" }]);
  });

  it("does NOT catch an offset that adds a whole extra sentence", () => {
    // A viewer meets a materially different first three seconds - this is the
    // semantic finalizer's job, not the lexical pass's.
    const offset = [
      { id: "a", score: 0.9, hook: "Человек это зло для планеты Земля" },
      {
        id: "b",
        score: 0.8,
        hook: "Мы обсуждали экологию целый час и пришли к простому выводу. Человек это зло для планеты Земля",
      },
    ];
    expect(hookSimilarity(offset[0].hook, offset[1].hook)).toBeLessThan(0.8);
    expect(findHookDuplicates(offset, 0.8)).toEqual([]);
  });

  it("ignores hooks too short to carry evidence", () => {
    const tiny = [
      { id: "a", score: 0.9, hook: "Слушай!" },
      { id: "b", score: 0.8, hook: "слушай" },
    ];
    expect(MIN_HOOK_TOKENS).toBeGreaterThan(1);
    expect(hookSimilarity(tiny[0].hook, tiny[1].hook)).toBe(1);
    expect(findHookDuplicates(tiny, 0.8)).toEqual([]);
  });

  it("ignores empty hooks", () => {
    const empty = [
      { id: "a", score: 0.9, hook: "" },
      { id: "b", score: 0.8, hook: "   " },
      { id: "c", score: 0.7, hook: "..." },
    ];
    expect(findHookDuplicates(empty, 0.8)).toEqual([]);
  });

  it("handles empty and single-clip input", () => {
    expect(findHookDuplicates([], 0.8)).toEqual([]);
    expect(findHookDuplicates([clips[0]], 0.8)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [...clips];
    const snapshot = JSON.stringify(input);
    findHookDuplicates(input, 0.8);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("resolveDuplicates", () => {
  const scores = { a: 0.9, b: 0.8, c: 0.7, d: 0.6 };

  it("keeps the highest-scored member of a chain", () => {
    const drops = resolveDuplicates(
      [
        { id: "b", duplicateOf: "a" },
        { id: "c", duplicateOf: "b" },
      ],
      scores,
      99
    );
    expect(drops.sort()).toEqual(["b", "c"]);
  });

  it("breaks a cycle instead of dropping everything", () => {
    const drops = resolveDuplicates(
      [
        { id: "a", duplicateOf: "b" },
        { id: "b", duplicateOf: "a" },
      ],
      scores,
      99
    );
    expect(drops).toEqual(["b"]); // a is stronger and survives
  });

  it("breaks a TIED cycle instead of dropping everything", () => {
    const tied = { a: 0.8, b: 0.8 };
    expect(
      resolveDuplicates(
        [
          { id: "a", duplicateOf: "b" },
          { id: "b", duplicateOf: "a" },
        ],
        tied,
        99
      )
    ).toEqual(["b"]);
  });

  it("leaves one survivor in a longer cycle", () => {
    const drops = resolveDuplicates(
      [
        { id: "a", duplicateOf: "b" },
        { id: "b", duplicateOf: "c" },
        { id: "c", duplicateOf: "a" },
      ],
      scores,
      99
    );
    expect(drops.sort()).toEqual(["b", "c"]);
  });

  it("resolves independent groups independently", () => {
    const drops = resolveDuplicates(
      [
        { id: "b", duplicateOf: "a" },
        { id: "d", duplicateOf: "c" },
      ],
      scores,
      99
    );
    expect(drops.sort()).toEqual(["b", "d"]);
  });

  it("keeps the strongest clip even when it is the claimed duplicate", () => {
    // The judge pointed the strong clip at the weak one - direction is advice,
    // score is authority.
    expect(resolveDuplicates([{ id: "a", duplicateOf: "d" }], scores, 99)).toEqual(["d"]);
  });

  it("ignores self-reference and unknown ids", () => {
    expect(
      resolveDuplicates(
        [
          { id: "a", duplicateOf: "a" },
          { id: "zz", duplicateOf: "a" },
          { id: "b", duplicateOf: "nope" },
        ],
        scores,
        99
      )
    ).toEqual([]);
  });

  it("returns nothing for no claims, and never drops a lone clip", () => {
    expect(resolveDuplicates([], scores, 99)).toEqual([]);
    expect(resolveDuplicates([{ id: "a", duplicateOf: "a" }], { a: 0.9 }, 99)).toEqual([]);
  });

  it("deduplicates repeated claims", () => {
    const drops = resolveDuplicates(
      [
        { id: "b", duplicateOf: "a" },
        { id: "b", duplicateOf: "a" },
        { id: "a", duplicateOf: "b" },
      ],
      scores,
      99
    );
    expect(drops).toEqual(["b"]);
  });

  it("enforces the drop cap, dropping the weakest first", () => {
    const drops = resolveDuplicates(
      [
        { id: "b", duplicateOf: "a" },
        { id: "c", duplicateOf: "a" },
        { id: "d", duplicateOf: "a" },
      ],
      scores,
      2
    );
    expect(drops).toEqual(["d", "c"]);
  });

  it("drops nothing at a cap of zero or below", () => {
    const claims = [{ id: "b", duplicateOf: "a" }];
    expect(resolveDuplicates(claims, scores, 0)).toEqual([]);
    expect(resolveDuplicates(claims, scores, -3)).toEqual([]);
  });

  it("orders the drop list weakest first with an id tie-break", () => {
    const flat = { a: 0.9, x: 0.5, y: 0.5 };
    const drops = resolveDuplicates(
      [
        { id: "y", duplicateOf: "a" },
        { id: "x", duplicateOf: "a" },
      ],
      flat,
      99
    );
    expect(drops).toEqual(["x", "y"]);
  });

  it("reports how many drops the cap swallowed", () => {
    const detailed = resolveDuplicatesDetailed(
      [
        { id: "b", duplicateOf: "a" },
        { id: "c", duplicateOf: "a" },
        { id: "d", duplicateOf: "a" },
      ],
      scores,
      2
    );
    expect(detailed).toEqual({ drops: ["d", "c"], dropCapHits: 1 });
  });

  it("reports zero cap hits when nothing was withheld", () => {
    expect(resolveDuplicatesDetailed([{ id: "b", duplicateOf: "a" }], scores, 99)).toEqual({
      drops: ["b"],
      dropCapHits: 0,
    });
  });

  it("does not mutate its input", () => {
    const claims = [
      { id: "c", duplicateOf: "b" },
      { id: "b", duplicateOf: "a" },
    ];
    const snapshot = JSON.stringify(claims);
    resolveDuplicates(claims, scores, 99);
    expect(JSON.stringify(claims)).toBe(snapshot);
  });
});

describe("duplicateDropCap", () => {
  it("is floor(n / 2) - half the set always ships", () => {
    expect(duplicateDropCap(0)).toBe(0);
    expect(duplicateDropCap(1)).toBe(0);
    expect(duplicateDropCap(2)).toBe(1);
    expect(duplicateDropCap(3)).toBe(1);
    expect(duplicateDropCap(6)).toBe(3);
    expect(duplicateDropCap(10)).toBe(5);
  });

  it("never returns a negative cap", () => {
    expect(duplicateDropCap(-4)).toBe(0);
  });

  it("cannot empty a set - survivors are always at least ceil(n / 2)", () => {
    for (let n = 0; n <= 20; n++) {
      expect(n - duplicateDropCap(n)).toBe(Math.ceil(n / 2));
    }
  });
});

describe("the real defect: montage twin of a later moment", () => {
  it("ships exactly one clip opening on the shared line, the stronger one", () => {
    const clips = [
      { id: "montage", score: 0.86, hook: "Человек - это зло для планеты Земля!" },
      { id: "real", score: 0.9, hook: "Человек, это зло для планеты Земля..." },
      { id: "other", score: 0.75, hook: "Бактерии уже научились есть пластик" },
    ];
    const scores = Object.fromEntries(clips.map((c) => [c.id, c.score]));
    const drops = resolveDuplicates(
      findHookDuplicates(clips, 0.8),
      scores,
      duplicateDropCap(clips.length)
    );
    expect(drops).toEqual(["montage"]);
    expect(clips.filter((c) => !drops.includes(c.id)).map((c) => c.id)).toEqual([
      "real",
      "other",
    ]);
  });
});
