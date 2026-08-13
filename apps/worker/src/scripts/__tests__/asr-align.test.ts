// apps/worker/src/scripts/__tests__/asr-align.test.ts
import { describe, expect, it } from "vitest";
import { alignTokens, normToken } from "../asr-align";

describe("normToken", () => {
  it("lowercases and strips everything but letters and digits, like the stitcher's norm", () => {
    expect(normToken("Привет,")).toBe("привет");
    expect(normToken("«Yes!»")).toBe("yes");
  });

  it("does NOT fold ё into е - ё/е flips must count as substitutions, matching engine-notes", () => {
    expect(normToken("всё")).not.toBe(normToken("все"));
  });
});

describe("alignTokens", () => {
  it("counts identical sequences as all matches", () => {
    const r = alignTokens(["раз", "два", "три"], ["раз", "два", "три"]);
    expect(r).toMatchObject({ matches: 3, substitutions: 0, insertions: 0, deletions: 0 });
  });

  it("counts a one-token replacement as one substitution, not an ins+del pair", () => {
    const r = alignTokens(["раз", "два", "три"], ["раз", "ДВЕ", "три"]);
    expect(r).toMatchObject({ matches: 2, substitutions: 1, insertions: 0, deletions: 0 });
  });

  it("counts a discourse-particle insertion as one insertion", () => {
    const r = alignTokens(["я", "думаю", "что"], ["я", "ну", "думаю", "что"]);
    expect(r).toMatchObject({ matches: 3, substitutions: 0, insertions: 1, deletions: 0 });
  });

  it("counts a deletion", () => {
    const r = alignTokens(["я", "вот", "думаю"], ["я", "думаю"]);
    expect(r).toMatchObject({ matches: 2, substitutions: 0, insertions: 0, deletions: 1 });
  });

  it("pairs unequal hunks as substitutions plus the remainder", () => {
    // hunk: A drops 2 tokens, B adds 1 -> 1 substitution + 1 deletion
    const r = alignTokens(["a", "x", "y", "b"], ["a", "z", "b"]);
    expect(r).toMatchObject({ matches: 2, substitutions: 1, insertions: 0, deletions: 1 });
  });

  it("drops punctuation-only tokens before aligning", () => {
    const r = alignTokens(["раз", "-", "два"], ["раз", "два"]);
    expect(r).toMatchObject({ tokensA: 2, tokensB: 2, matches: 2 });
  });

  it("counts ё/е divergence as a substitution", () => {
    const r = alignTokens(["всё", "ясно"], ["все", "ясно"]);
    expect(r).toMatchObject({ matches: 1, substitutions: 1 });
  });

  it("refuses a table whose AREA would not fit, before allocating it", () => {
    // 9000 x 9000 = 81M cells; each side alone passes a per-dimension check.
    const big = Array.from({ length: 9000 }, (_, k) => `t${k}`);
    expect(() => alignTokens(big, big)).toThrow(/too long/);
  });
});
