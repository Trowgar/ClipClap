import { describe, expect, it } from "vitest";
import { classifyOnset, CONNECTIVE, PRONOUN } from "../scripts/arc-audit-onset";

/**
 * The six openings are verbatim transcript text from podcast-nuclear (design
 * doc 2026-08-10, §0 table) - real defects the owner named by eye on job
 * cmsnmcbec005ouhfj30l0w4qm. Expectations differ across cases on purpose
 * (some conn=true, some false; some pron=true, some false; one q=true, five
 * q=false) so a classifier that always returns the same flag fails here -
 * see memory feedback_test_matches_default: a test whose expectation is the
 * tie-break default proves nothing.
 */
describe("classifyOnset - the six §0 openings, verbatim", () => {
  it('"Он ехал на велосипеде Увидел яркую вспышку" - pron via the raw subject, no connective', () => {
    const r = classifyOnset("Он ехал на велосипеде Увидел яркую вспышку");
    expect(r.rawFirst).toBe("он");
    expect(r.pron).toBe(true); // "он" itself, first non-particle token
    expect(r.conn).toBe(false);
    expect(r.q).toBe(false);
  });

  it('"Это миллиарды вот тут я то так скажу" - "Это" is a pronoun, not a connective', () => {
    const r = classifyOnset("Это миллиарды вот тут я то так скажу");
    expect(r.rawFirst).toBe("это");
    expect(r.pron).toBe(true); // "это"
    // rawFirst "это" is a member of PRONOUN, not CONNECTIVE - the two sets
    // are disjoint by construction, asserted directly so a future edit that
    // lets a word leak into both sets is caught here, not just by the flags.
    expect(CONNECTIVE.has(r.rawFirst)).toBe(false);
    expect(r.conn).toBe(false);
    expect(r.q).toBe(false);
  });

  it('"И можно ли ее избежать" - coordinating "И" plus dangling "ее"', () => {
    const r = classifyOnset("И можно ли ее избежать");
    expect(r.rawFirst).toBe("и");
    expect(r.conn).toBe(true);
    expect(r.pron).toBe(true); // "ее", after "и" is skipped as a particle
    // MEASURED, not assumed: looksLikeQuestion has no signal for "ли"
    // (a yes/no question particle, not in INTERROGATIVE - that set is only
    // wh-words) and "можно" is not interrogative either, so the mechanical
    // test misses this real question. A real gap, recorded rather than
    // hidden behind an assumed value.
    expect(r.q).toBe(false);
  });

  it('"И проверять это на практике" - same shape, both flags true', () => {
    const r = classifyOnset("И проверять это на практике");
    expect(r.rawFirst).toBe("и");
    expect(r.conn).toBe(true);
    expect(r.pron).toBe(true); // "это"
    expect(r.q).toBe(false);
  });

  it('"А помогают ли от радиации народные средства" - "а" deliberately NOT a connective', () => {
    const r = classifyOnset("А помогают ли от радиации народные средства");
    expect(r.rawFirst).toBe("а");
    // The asymmetry documented on CONNECTIVE in arc-audit-onset.ts: "а" is a
    // PARTICLE and reads like a connective, but is excluded from CONNECTIVE
    // because it routinely opens fine, unflagged material (this clip is the
    // design doc's own example, §2: "'А помогают ли...' opens on a particle
    // and is a fine hook").
    expect(CONNECTIVE.has("а")).toBe(false);
    expect(r.conn).toBe(false);
    expect(r.pron).toBe(false);
    // MEASURED, not assumed (verified by running looksLikeQuestion directly
    // before writing this assertion): despite reading as a clear yes/no
    // question to a person, looksLikeQuestion returns false here for the
    // same reason as the "И можно ли ее избежать" case above - "ли" carries
    // the question, and "ли" is not in INTERROGATIVE. The onset-position
    // check only recognizes wh-word questions, not да/нет questions marked
    // by a trailing "ли". This is a real, load-bearing finding about
    // looksLikeQuestion's coverage, not a hidden assumption.
    expect(r.q).toBe(false);
  });

  it('"Вот почему ядерное оружие не запретили большая загадка" - the "вот"+"почему" collision', () => {
    const r = classifyOnset("Вот почему ядерное оружие не запретили большая загадка");
    expect(r.rawFirst).toBe("вот");
    expect(r.conn).toBe(true);
    expect(r.pron).toBe(false);
    // MEASURED (verified by running looksLikeQuestion directly, per the task
    // spec's instruction not to guess): this line is declarative, not a
    // question - "that's why nuclear weapons were never banned, a great
    // mystery" - and carries no "?". looksLikeQuestion still returns TRUE,
    // because it skips the leading particle "вот" and then finds "почему" in
    // onset position, which IS in INTERROGATIVE. This is a real collision
    // between the particle-skip rule and the wh-word rule: a declarative
    // sentence that happens to open "<particle> <wh-word>" reads as a
    // question to the mechanical test. It is exactly the kind of case
    // looksLikeQuestion's own doc comment (sentence-graph.ts) warns about
    // for "contains" tests ("rhetorical tag, not a question") but the
    // onset-position test is not immune to it either when the wh-word itself
    // opens the clause.
    expect(r.q).toBe(true);
  });
});

describe("classifyOnset - each set membership is individually load-bearing", () => {
  // These are not restatements of the six cases above. Each one isolates a
  // SINGLE membership so that a classifier which got the right answer for
  // the wrong reason (e.g. conn hard-coded to `rawFirst.length > 0`) cannot
  // pass by accident. Combined with the differing expectations in the suite
  // above (conn: true/false/false/true/true/false across the six; pron:
  // true/true/true/true/false/false; q: false x5, true x1), no constant
  // function - always-true or always-false, for any of the three flags -
  // survives this file. That is the "OR" branch of the task's mutation-check
  // requirement (build the fixture so the mechanism must overcome the
  // tie-break default, instead of running a live mutation pass).
  it("conn: a CONNECTIVE word not present anywhere reads false", () => {
    expect(classifyOnset("Пушистый кот спит на подоконнике").conn).toBe(false);
  });

  it("conn: a bare CONNECTIVE-opening reads true even with no pronoun", () => {
    expect(classifyOnset("Но факты остаются фактами").conn).toBe(true);
    expect(classifyOnset("Но факты остаются фактами").pron).toBe(false);
  });

  it("pron: a PRONOUN word beyond the 6-token window after particles does not count", () => {
    // "и" is skipped as a leading particle, leaving 7 non-pronoun tokens
    // before "она" - one past PRONOUN_WINDOW (6), so it must not fire.
    const r = classifyOnset("И один два три четыре пять шесть она");
    expect(r.pron).toBe(false);
  });

  it("pron: the same PRONOUN word inside the window does count", () => {
    const r = classifyOnset("И один два три четыре она");
    expect(r.pron).toBe(true);
  });

  it("q: a plain declarative with no wh-word and no question mark reads false", () => {
    expect(classifyOnset("Кот спит на подоконнике").q).toBe(false);
  });

  it("q: a terminal question mark reads true independent of onset word", () => {
    expect(classifyOnset("Кот спит на подоконнике?").q).toBe(true);
  });
});

describe("PRONOUN set", () => {
  it("carries both ё and е spellings of the third-person feminine object pronoun", () => {
    // engine-notes §3: ё/е is a measured transcription-jitter coin flip. A
    // set that only carried "её" would silently miss this fixture's own
    // defect case ("И можно ли ее избежать" is transcribed without ё).
    expect(PRONOUN.has("её")).toBe(true);
    expect(PRONOUN.has("ее")).toBe(true);
  });
});
