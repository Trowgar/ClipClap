import { describe, expect, it } from "vitest";
import {
  criticCandidateBlock,
  criticSystemPrompt,
  finalizerSystemPrompt,
} from "../analyze-v2/prompts";
import { isCleanStart } from "../analyze-v2/sentence-graph";
import type { MergedCandidate, SentenceNode } from "../analyze-v2/types";

function node(i: number, over: Partial<SentenceNode> = {}): SentenceNode {
  return {
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text: `Узел ${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
    ...over,
  };
}

describe("isCleanStart", () => {
  it("accepts strong leading boundaries and post-opaque starts, rejects mid-flow", () => {
    const nodes = [
      node(0),
      node(1, { leadingStrength: 0.4 }),
      node(2, { hasWords: false, leadingStrength: 0.4 }),
      node(3, { leadingStrength: 0.2 }), // follows opaque node 2
    ];
    expect(isCleanStart(nodes, 0)).toBe(true);
    expect(isCleanStart(nodes, 1)).toBe(false);
    expect(isCleanStart(nodes, 3)).toBe(true);
    expect(isCleanStart(nodes, 99)).toBe(false);
    // an opaque node is never a valid start, even with a strong leading boundary
    expect(isCleanStart([node(0), node(1, { hasWords: false })], 1)).toBe(false);
  });

  it("vetoes lowercase onsets on pause boundaries but trusts terminal ones", () => {
    const nodes = [
      node(0),
      // hesitation pause minted 0.8 - lowercase onset says mid-sentence
      node(1, { leadingStrength: 0.8, text: "глаза на все её хотелки." }),
      // same strength with a capitalized onset is a real sentence start
      node(2, { leadingStrength: 0.8, text: "Что интересно, дальше." }),
      // terminal-punctuation boundary (1.0) is trusted regardless of case
      node(3, { leadingStrength: 1.0, text: "просто продолжение." }),
    ];
    expect(isCleanStart(nodes, 1)).toBe(false);
    expect(isCleanStart(nodes, 2)).toBe(true);
    expect(isCleanStart(nodes, 3)).toBe(true);
  });
});

/** The text of ONE numbered rule, from its own "N. " line to the next rule's.
 *
 *  Scoping matters more than it looks. Both prompts are hundreds of lines long,
 *  so a bare toContain over the whole prompt passes on a phrase that drifted
 *  into an unrelated rule - the substring test that proves nothing. Anything
 *  asserted below has to be inside the rule that is supposed to carry it, and a
 *  rule that loses its heading fails here rather than silently matching nothing.
 */
function rule(prompt: string, n: number): string {
  const from = prompt.indexOf(`\n${n}. `);
  const to = prompt.indexOf(`\n${n + 1}. `);
  if (from < 0) throw new Error(`no rule ${n} in this prompt`);
  if (to <= from) throw new Error(`rule ${n} is not followed by rule ${n + 1}`);
  // Whitespace-collapsed: a prompt reflowed to a different line width must not
  // fail these tests, only a prompt that lost the rule.
  return prompt.slice(from, to).replace(/\s+/g, " ");
}

/** The title rule of the critic (rule 6) and of the finalizer (rule 3).
 *
 *  These two stages both write the caption a viewer reads, and until 2026-08-04
 *  they disagreed: the critic asked for a curiosity hook, the finalizer then
 *  told the judge to rewrite it as "a truthful statement built from the clip's
 *  own words" - a description of the clip. The finalizer won, and `title is a
 *  recap` came back in 11 of 11 editor verdicts on the audited set. The shared
 *  block below is what stops them disagreeing again, so it is asserted against
 *  BOTH prompts from one list.
 */
const TITLE_RULES: Array<[string, string]> = [
  ["critic rule 6", rule(criticSystemPrompt("en", "English"), 6)],
  ["finalizer rule 3", rule(finalizerSystemPrompt("ru", "Russian"), 3)],
];

describe("the title rule, in both prompts that write a title", () => {
  it.each(TITLE_RULES)("%s asks for a hook, not a recap", (_name, text) => {
    // the title's job, and the recap named as the failure
    expect(text).toMatch(/make a stranger .{0,40}(WANT TO WATCH|want to press play)/);
    expect(text).toMatch(/recap/i);
  });

  it.each(TITLE_RULES)("%s forbids stating the payoff", (_name, text) => {
    expect(text).toMatch(/MUST NOT STATE THE PAYOFF/);
    // REFER versus RESTATE is the whole distinction: the audit called
    // "Their Big News" clean and "Scrabble with Monica" a spoiler, and the two
    // titles cite evidence in identical positions - no gate can tell them
    // apart, so the prompt has to.
    expect(text).toMatch(/REFER.{0,80}never.{0,20}RESTATE/);
  });

  it.each(TITLE_RULES)("%s works the contrast on a real pair", (_name, text) => {
    // An abstract rule in a crowded prompt has been measured firing ZERO times
    // while the defect it named sat in the output (engine-notes 5a), so the
    // rule ships with the measured example or it does not ship.
    const spoiler = text.indexOf("Scrabble with Monica");
    const clean = text.indexOf("Their Big News");
    expect(spoiler, "the RESTATED example is gone").toBeGreaterThan(-1);
    expect(clean, "the REFERRED-to example is gone").toBeGreaterThan(-1);
    expect(text).toContain("playing Scrabble with Monica");
  });

  it.each(TITLE_RULES)("%s keeps the 70-character bound", (_name, text) => {
    expect(text).toMatch(/70 characters/);
  });
});

describe("criticSystemPrompt", () => {
  const rule6 = rule(criticSystemPrompt("en", "English"), 6);

  it("keeps the no-clickbait bar the hook rule could otherwise loosen", () => {
    expect(rule6).toMatch(/clickbait/i);
  });

  it("labels the restating example WRONG and the referring one RIGHT", () => {
    // Unlabelled examples are just two more titles in the prompt. The order is
    // load-bearing: WRONG belongs to the Scrabble line, RIGHT to the Big News
    // line, and swapping the labels inverts the rule.
    const spoiler = rule6.indexOf("Scrabble with Monica");
    const wrong = rule6.indexOf("WRONG");
    const clean = rule6.indexOf("Their Big News");
    const right = rule6.indexOf("RIGHT");
    expect(wrong).toBeGreaterThan(spoiler);
    expect(clean).toBeGreaterThan(wrong);
    expect(right).toBeGreaterThan(clean);
  });

  it("substitutes the clip's language rather than hardcoding one", () => {
    const en = criticSystemPrompt("en", "English");
    expect(en).toContain("(English, en)");
    expect(en).not.toContain("{{");
    expect(criticSystemPrompt("ru", "Russian")).not.toContain("English");
  });
});

describe("finalizerSystemPrompt title rule", () => {
  const rule3 = rule(finalizerSystemPrompt("ru", "Russian"), 3);

  it("keeps the honesty requirement and its drop reason", () => {
    // The defect this rule was written for: a title promising what the speech
    // never delivers. engine-notes 4 records what letting copy degrade
    // unchecked costs, so the honesty half survives the hook rewrite intact.
    expect(rule3).toMatch(/promises what the speech never delivers/);
    expect(rule3).toMatch(/viewer feels cheated at the cut/);
    expect(rule3).toContain("unanswered_title");
    expect(rule3).toMatch(/never repair a clip with its caption/);
  });

  it("treats a question title as a hook when the clip answers it", () => {
    // The blanket suspicion of question titles is what pushed the judge into
    // rewriting hooks as descriptions. A question the clip answers is a hook.
    expect(rule3).toMatch(/question title is fine/i);
    expect(rule3).toMatch(/WHENEVER the answer is spoken inside the clip/);
    expect(rule3).not.toMatch(/question title is valid ONLY when/);
  });

  it("never asks for a title built from the clip's own words", () => {
    // The exact instruction that manufactured the recap: a statement built from
    // the clip's own words IS a description of the clip.
    expect(rule3).not.toMatch(/statement.{0,20}built from the clip's own words/);
    expect(rule3).not.toMatch(/truthful statement/);
  });

  it("repairs copy instead of dropping a clip for it", () => {
    // The invariant predates this work: no clip may be dropped for its copy.
    expect(rule3).toMatch(/do not drop the clip for it/);
  });
});

describe("criticCandidateBlock", () => {
  it("marks clean-start lines with ¶ and mid-flow lines with padding", () => {
    const nodes = [node(0), node(1, { leadingStrength: 0.4 }), node(2)];
    const candidate: MergedCandidate = {
      id: "c0",
      startNode: 0,
      endNode: 2,
      payoffNode: 2,
      interest: 0.7,
      type: "story",
      windowIndex: 0,
    };
    const block = criticCandidateBlock(candidate, nodes);
    const lines = block.split("\n");
    // match node lines by "#<idx> [" - the candidate header also contains #0
    expect(lines.find((l) => l.includes("#0 ["))!.startsWith("¶ ")).toBe(true);
    expect(lines.find((l) => l.includes("#1 ["))!.startsWith("  ")).toBe(true);
    expect(lines.find((l) => l.includes("#2 ["))!.startsWith("¶ ")).toBe(true);
  });
});
