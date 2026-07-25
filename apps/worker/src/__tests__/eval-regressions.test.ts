import { describe, expect, it } from "vitest";
import type { SubtitleWord } from "@clipclap/shared";
import type { V2Result } from "../analyze-v2/types";
import { loadFixture, runFixture, type Fixture } from "./helpers/eval-fixture";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { isTeaserCandidate } from "../analyze-v2/teaser";

/**
 * Tier-1 "never again" regressions.
 *
 * Each case below is a defect the owner saw in a real shipped clip. The
 * assertions state the RULE and derive everything from the fixture transcript at
 * the clip boundary - never from a hardcoded range - so they keep their meaning
 * when the fixtures are re-recorded. Exact output is pinned separately by
 * eval-snapshot.test.ts; this file is about behaviour that must stay true.
 *
 * PROVENANCE. Every claim below was re-measured at HEAD on 2026-07-25 by
 * disabling the named guard by hand and watching the case. What a comment is
 * allowed to say is exactly what that measurement showed, which in this file
 * means four different verdicts, none of them dressed up as another:
 *   - ONE GUARD: the case reds when that guard alone is disabled.
 *   - TWO GUARDS: the case needs BOTH disabled to red. Stated in full, with the
 *     single-knob runs that stayed green. Two guards over one defect is good
 *     engineering; a comment claiming a single-knob proof that no longer
 *     reproduces is not, and that is how the numbers below went stale before.
 *   - NO GUARD: the rule holds by luck, or is violated today. Said loudly.
 *   - UNFIRED TRIPWIRE: an assertion no reachable knob can turn red on today's
 *     fixtures. Kept, but never cited as proof of anything.
 * A green test that cannot fail is worse than no test; a green test that LIES
 * about why it is green is worse again.
 */

const CASES = ["podcast-ecology", "podcast-answer-arc"] as const;
type CaseName = (typeof CASES)[number];

// ---------------------------------------------------------------------------
// transcript access
// ---------------------------------------------------------------------------

/** A transcript word plus the punctuation that follows it in the segment text.
 *  Whisper's word objects carry no punctuation at all in these recordings -
 *  only the segment text does - so a boundary rule about commas has to align
 *  the two. */
interface AlignedWord extends SubtitleWord {
  /** Punctuation run immediately after this word, "" when none. */
  after: string;
}

/**
 * Aligns each word with the punctuation that follows it by walking the segment
 * text letter by letter. A naive whitespace split cannot be used: Whisper emits
 * "что-то" as two words ("что", "то") against one text token.
 */
function alignedWords(fixture: Fixture): AlignedWord[] {
  const out: AlignedWord[] = [];
  for (const seg of fixture.transcript.segments ?? []) {
    const text = seg.text ?? "";
    let cursor = 0;
    for (const word of seg.words ?? []) {
      for (const ch of word.text) {
        if (!/[\p{L}\p{N}]/u.test(ch)) continue;
        while (cursor < text.length && text[cursor].toLowerCase() !== ch.toLowerCase()) {
          cursor += 1;
        }
        cursor += 1;
      }
      let after = "";
      let k = cursor;
      while (k < text.length && /[^\p{L}\p{N}\s]/u.test(text[k])) {
        after += text[k];
        k += 1;
      }
      out.push({ ...word, after });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Word-boundary tolerance. Snap moves edges by leadInSec/tailHoldSec into
 *  silence, so an edge lands a fraction of a second outside the word it keeps. */
const EPS = 0.05;

function wordsInside(words: AlignedWord[], startSec: number, endSec: number): AlignedWord[] {
  return words.filter((w) => w.start >= startSec - EPS && w.end <= endSec + EPS);
}

interface Run {
  fixture: Fixture;
  result: V2Result;
  words: AlignedWord[];
}

// One engine run per fixture, shared by every case: replay is deterministic, and
// re-running it per assertion would multiply a multi-second parse for nothing.
const runs = new Map<CaseName, Promise<Run>>();

function run(name: CaseName): Promise<Run> {
  let pending = runs.get(name);
  if (!pending) {
    pending = (async () => {
      const fixture = loadFixture(name);
      return { fixture, result: await runFixture(fixture), words: alignedWords(fixture) };
    })();
    runs.set(name, pending);
  }
  return pending;
}

/** Short, greppable identity of a clip for failure messages. */
function label(name: string, clip: { start: number; end: number; title: string }): string {
  return `${name} ${clip.start.toFixed(2)}-${clip.end.toFixed(2)} "${clip.title}"`;
}

interface TeaserDrop {
  id: string;
  recurrence: number;
  startSec: number;
  endSec: number;
}

function teaserDrops(result: V2Result): TeaserDrop[] {
  const drops = (result.telemetry as Record<string, unknown>).teaserDrops;
  expect(Array.isArray(drops), "teaserDrops telemetry is missing").toBe(true);
  return drops as TeaserDrop[];
}

function normalizeWords(words: AlignedWord[]): string[] {
  return words
    .map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

describe("named regressions", () => {
  // -------------------------------------------------------------------------
  it("no clip opens on a lowercase mid-sentence fragment", async () => {
    // Owner's complaint: clips that begin in the middle of somebody's sentence -
    // the viewer joins on "...глаза на все её хотелки" with no idea what is
    // being talked about.
    //
    // The rule is enforced by startsLowercase() inside isCleanStart()
    // (sentence-graph.ts). It matters more than it looks: the word objects in
    // these transcripts carry NO punctuation, so the TERMINAL regex never fires
    // and every node boundary here is a 0.8 pause boundary. Capitalization is
    // the ONLY signal separating a real sentence onset from a hesitation pause.
    //
    // ONE GUARD - the only case in this file with a single enforcing guard.
    // Re-measured 2026-07-25: dropping the `&& !startsLowercase(n.text)` term
    // from snap's clean-start walk reds this case ALONE (the other six stay
    // green), on podcast-answer-arc 865.15-900.46 "Почему нынешнее потепление
    // опаснее прошлых катастроф", which opens on the word "приводит". The
    // podcast-ecology 2128.05-2147.42 / "слишком" offender this comment used to
    // name is gone - that output moved when the teaser filter landed. Same
    // guard, different victim; the guard is what matters.
    //
    // HOW to disable it, because the obvious way proves nothing: inline
    // isCleanStart into snap's `cleanStartAt` WITHOUT the lowercase veto.
    // Deleting the term from isCleanStart itself also changes the critic's ¶
    // window markers, so the prompt text changes, the replay fixture has no
    // recording for it, and all seven cases die on "critic failed for batch
    // [...]" - a stale-fixture error, not the rule being violated.
    const offenders: string[] = [];
    for (const name of CASES) {
      const { result, words } = await run(name);
      for (const clip of result.highlights) {
        const first = wordsInside(words, clip.start, clip.end)[0];
        if (!first) continue;
        const letter = first.text.match(/\p{L}/u)?.[0];
        if (letter && /\p{Ll}/u.test(letter)) {
          offenders.push(`${label(name, clip)} opens on "${first.text}"`);
        }
      }
    }
    expect(offenders, "a clip opens mid-sentence").toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Owner's complaint: a clip that stops on a comma with the predicate left
  // outside it. podcast-ecology 1866.26-1945.76 ends "...Без разумного вида,
  // строящего космические корабли," and the sentence's verb ("любая биосфера
  // обречена") is not in the clip; 907.53-952.14 ends "...перестраивать очень
  // много в сельском хозяйстве," with the enumeration still running.
  //
  // THIS RULE IS VIOLATED TODAY, so it is pinned with .fails: the case is green
  // while the defect exists and turns RED the moment it is fixed, at which point
  // the `.fails` is deleted and this becomes an ordinary never-again test.
  // Re-measured 2026-07-25: the body still throws, on exactly the two clips
  // named above and on no others.
  //
  // NO GUARD. Snap's clean-end repair (block 2b) is the only candidate, and it
  // is INERT on both fixtures: short-circuiting the
  // `if (e.hasWords && !isCleanEnd(nodes, e.index))` branch leaves BOTH
  // fixtures' clip lists byte-identical to baseline and leaves this offender
  // list unchanged at the same two entries. The earlier note here - that
  // disabling it moved one answer-arc clip 882.8-934.1 -> 882.8-931.9 - no
  // longer reproduces at all; that clip is not in answer-arc's output any more.
  // So podcast-answer-arc's silence on this rule is luck rather than a guard,
  // and podcast-ecology's failure is the engine rather than a threshold.
  //
  // Root cause found while writing this file: isCleanEnd() treats "the next node
  // has no word timings" as end-of-speech ("music follows"), but hasWords=false
  // only means Whisper's word timings were unreliable - which happens
  // mid-sentence. Node 576 "Без разумного вида строящего космические корабли" is
  // certified a clean end purely because node 577 is opaque. Compounding it, the
  // word objects in these transcripts carry no punctuation at all, so the CLAUSE
  // regex in buildSentenceGraph never fires and a comma never weakens a boundary.
  it.fails("KNOWN DEFECT: clips still end mid-clause on a dangling comma", async () => {
    const offenders: string[] = [];
    for (const name of CASES) offenders.push(...(await midClauseEndings(name)));
    expect(offenders, "a clip ends mid-clause").toEqual([]);
  });

  /** Clips whose last spoken word is followed by clause punctuation while the
   *  speaker keeps going - i.e. the sentence is cut in half. */
  async function midClauseEndings(name: CaseName): Promise<string[]> {
    const { result, words } = await run(name);
    const offenders: string[] = [];
    for (const clip of result.highlights) {
      const inside = wordsInside(words, clip.start, clip.end);
      const last = inside[inside.length - 1];
      if (!last) continue;
      const continues = words.some((w) => w.start >= clip.end - EPS);
      if (continues && /^[,;:]/.test(last.after)) {
        offenders.push(`${label(name, clip)} ends "${last.text}${last.after}"`);
      }
    }
    return offenders;
  }

  // -------------------------------------------------------------------------
  it("no clip is shorter than the product floor", async () => {
    // Owner's complaint: two-second stingers shipped as clips.
    //
    // TWO GUARDS, and this case needs BOTH disabled to fail. All four
    // combinations were run on 2026-07-25:
    //   hardMinSec=0 alone       all seven cases green - and both fixtures'
    //                            output is byte-identical to baseline, so the
    //                            duration floor is not currently dropping
    //                            anything at all.
    //   teaser filter off alone  this case green; shortest shipped clip is
    //                            26.93s (ecology) / 24.56s (answer-arc).
    //   both                     RED: "podcast-ecology 36.53-39.56 "Что на
    //                            самом деле убьёт человечество" is 3.03s".
    // Those guards are the `duration < cfg.hardMinSec` drop in snap.ts and
    // isTeaserCandidate() in analyze-v2/teaser.ts, covering one defect from two
    // directions: the only sub-6s clip either fixture can produce happens to be
    // a montage fragment, so the montage filter removes it before the floor is
    // ever consulted. Neither is redundant - the floor is the only thing that
    // would catch a short NON-montage clip, and no fixture produces one today.
    // Read a failure here as "both guards are gone", not as a knob tweak.
    //
    // An earlier version of this comment claimed hardMinSec=0 alone ships the
    // 3.03s clip. That was true before the teaser filter landed and is false
    // now; it is written out in full above so the next edit re-measures rather
    // than trusting the prose.
    //
    // MIN_CLIP_SEC is deliberately a LITERAL and NOT cfg.hardMinSec: the knob is
    // what the engine compares against, so reading it here would make the test
    // move with the defect instead of catching it. The realistic way the
    // stingers come back is a knob edit or a CLIP_HARD_MIN_SEC override in prod,
    // so the number below states the PRODUCT rule and only a product decision
    // may change it. (The default itself is pinned separately in
    // analyze-config.test.ts; this case pins the shipped output.)
    const MIN_CLIP_SEC = 6;
    const offenders: string[] = [];
    for (const name of CASES) {
      const { result } = await run(name);
      for (const clip of result.highlights) {
        const duration = clip.end - clip.start;
        if (duration < MIN_CLIP_SEC) {
          offenders.push(`${label(name, clip)} is ${duration.toFixed(2)}s`);
        }
      }
    }
    expect(offenders, `a clip is shorter than ${MIN_CLIP_SEC}s`).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it("no two clips open on the same spoken line", async () => {
    // Owner's complaint: two clips in one batch that start with the identical
    // sentence - one of them the intro montage's copy of the other.
    //
    // NO DEDICATED DEDUP GUARD EXISTS IN THE SHIPPED V2 PATH. Re-checked
    // 2026-07-25: analyze-v2/dedup.ts landed this week but has NO consumer -
    // it is pure primitives waiting on the finalizer - and select.ts's
    // post-critic NMS compares TIME overlap only (>30% of the shorter clip), so
    // it can never notice that a clip at 36.5s and a clip at 2806.9s are the
    // same spoken line. Nothing in the engine compares opening lines today.
    //
    // What actually keeps the owner's duplicate out is the same TWO GUARDS as
    // the case above, and this case likewise needs BOTH gone to fail:
    //   hardMinSec=0 alone       green - ecology ships the real moment ALONE
    //                            (output identical to baseline: the 36.53-39.56
    //                            copy is absent, 87.43-156.96 is untouched).
    //   teaser filter off alone  green - no duplicate pair either.
    //   both                     RED: "36.53-39.56 repeats the opening of
    //                            2806.87-2850.16: что убьет человечество
    //                            собственная глупость".
    // In podcast-ecology the montage copy c2 (36.7-39.3) and the real moment
    // c29 (2806.87, same opening words) were BOTH kept by the critic, at 0.80
    // and 0.92; the teaser filter now drops c2 before selection and the duration
    // floor would still catch it afterwards.
    //
    // Paraphrase duplicates - the same claim in different words - have no guard
    // at any layer and wait on the finalizer; treat a failure here as the
    // duplicate defect returning, not as noise.
    const OPENING_WORDS = 5;
    for (const name of CASES) {
      const { result, words } = await run(name);
      const seen = new Map<string, string>();
      const offenders: string[] = [];
      for (const clip of result.highlights) {
        const opening = normalizeWords(wordsInside(words, clip.start, clip.end))
          .slice(0, OPENING_WORDS)
          .join(" ");
        if (opening.split(" ").length < OPENING_WORDS) continue;
        const previous = seen.get(opening);
        if (previous) {
          offenders.push(`${label(name, clip)} repeats the opening of ${previous}: "${opening}"`);
        } else {
          seen.set(opening, label(name, clip));
        }
      }
      expect(offenders, `${name}: two clips open on the same line`).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  it("no clip is cut from the intro teaser montage", async () => {
    // Owner's complaint: the first clip was a fragment of the video's own
    // trailer - three seconds of a line that the guest says properly 47 minutes
    // later. A teaser montage is literally a copy of later speech, so it is
    // detectable without an LLM: its word 5-grams occur again further on.
    //
    // Enforced by isTeaserCandidate() in analyze-v2/teaser.ts, applied to merged
    // candidates BEFORE selectCriticCandidates. TWO GUARDS again, measured
    // 2026-07-25:
    //   teaser filter off alone (teaserRecurrenceFrac > 1)  this case green.
    //   hardMinSec=0 alone                                  this case green.
    //   both      RED: "podcast-ecology 36.53-39.56 ... repeats later speech
    //             (100%)" - a 3.03s copy, shipped at 0.80, of the moment that
    //             ships properly at 2807s.
    // The duration floor is the second guard only because THIS montage fragment
    // is short; a longer montage would be caught by the filter alone, which is
    // why the filter is not redundant with a duration check.
    //
    // The legitimate cold open at ~87s is inside the 120s teaser window and is
    // spoken once, so the filter scores it exactly 0.0000 on both fixtures.
    // podcast-ecology's (87.43-156.96) ships in all four runs above.
    // podcast-answer-arc's (86.33-155.18) ships in the baseline but NOT with the
    // filter off - not because anything ate it, but because it then competes for
    // critic budget with the montage candidates that are no longer being
    // dropped. Whether that moment ships is a selection outcome and moves
    // between recordings; that the FILTER never touches it is pinned
    // deterministically by the last case in this file.
    //
    // MAX_RECURRENCE is a LITERAL, not cfg.teaserRecurrenceFrac, and it is
    // measured with a plain 5-gram fraction here rather than by calling
    // montageScore, for the reason spelled out on MIN_CLIP_SEC above: reading
    // the knob - or the implementation - would make the test move with the
    // defect. It states the PRODUCT rule - a shipped clip must not be a copy of
    // later speech - in terms that do not depend on how the filter decides.
    //
    // It is a CEILING, not a tripwire on the knob, and it must not be sold as
    // one: measured, raising the shipped default from 0.5 to 0.9 or even 1.1
    // leaves THIS case green. A loosened knob surfaces two cases down, where the
    // drops themselves are asserted, and in teaser.test.ts's literal default
    // pin. (0.35 also no longer matches the filter's 0.5 bar, which is fine -
    // they are different metrics on different jobs and may drift apart.)
    const NGRAM = 5;
    const MAX_RECURRENCE = 0.35;
    for (const name of CASES) {
      const { result, words } = await run(name);
      const offenders: string[] = [];
      for (const clip of result.highlights) {
        const inside = normalizeWords(wordsInside(words, clip.start, clip.end));
        if (inside.length < NGRAM) continue;
        // n-grams of everything spoken strictly AFTER this clip: a clip that is
        // itself the original must not be flagged because its own teaser copy
        // came earlier.
        const later = new Set(
          ngrams(normalizeWords(words.filter((w) => w.start >= clip.end - EPS)), NGRAM)
        );
        const mine = ngrams(inside, NGRAM);
        const hits = mine.filter((g) => later.has(g)).length;
        const recurrence = hits / mine.length;
        if (recurrence >= MAX_RECURRENCE) {
          offenders.push(`${label(name, clip)} repeats later speech (${(recurrence * 100).toFixed(0)}%)`);
        }
      }
      expect(offenders, `${name}: a montage fragment shipped as a clip`).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  it("the teaser filter actually fires on both real intros", async () => {
    // The case above asserts an ABSENCE, and an absence can be produced by
    // anything - a filter that silently stopped matching would leave it green
    // for as long as no montage happened to survive selection. This case pins
    // the positive half: the montage really is found, and it is found in the
    // opening minute where the source editor put it.
    //
    // Both fixtures are two transcription runs of the same episode, and the
    // montage text is byte-identical between them, so the drops must agree on
    // WHERE they are even though the node numbering does not line up.
    for (const name of CASES) {
      const { result } = await run(name);
      const drops = teaserDrops(result);
      expect(
        drops.length,
        `${name}: the intro montage was not detected at all`
      ).toBeGreaterThan(0);
      // The drops.length assertion above is ONE GUARD and it is the case in
      // this file that catches a loosened knob: measured 2026-07-25, raising the
      // shipped TEASER_RECURRENCE_FRAC default to 0.9 reds it on
      // podcast-answer-arc (whose drops score 0.88 and 0.83), and anything above
      // 1.0 reds it on both fixtures. The absence case above does NOT catch
      // that, so do not rely on it for this.
      //
      // The >= 0.75 evidence floor below is an UNFIRED TRIPWIRE and is kept as
      // one, not cited as proof. Measured: exactly seven merged candidates ever
      // start inside the 120s window across both fixtures, and their
      // montageScores are quantised with nothing in between -
      // 1.0000/1.0000/1.0000/0.0000 (ecology) and 0.8750/0.8333/0.0000
      // (answer-arc); telemetry rounds to 2dp, which is what this reads, so the
      // five real montage fragments arrive here as 1.00/1.00/1.00/0.88/0.83.
      // Nothing reachable puts a drop in [bar, 0.75): lowering the bar to
      // 0.35/0.2/0.1 admits no new candidate, weakening the evidence rule
      // (TEASER_MIN_RUN 5->3, TEASER_MIN_ALIGNED 5->2) RAISES every drop to
      // 1.0000 instead of lowering it, and removing the ё-folding leaves them
      // unchanged. It guards a future montageScore that starts deciding on thin
      // evidence - a real risk, just not one today's fixtures can demonstrate.
      for (const drop of drops) {
        expect(
          drop.recurrence,
          `${name}: ${drop.id} was dropped on a recurrence of only ${drop.recurrence}`
        ).toBeGreaterThanOrEqual(0.75);
      }
      // The montage is the first 45 seconds; the host's own "Всем привет, это
      // подкаст сортировочный" at ~45.5s is where the real episode starts.
      // Nothing past it may be called a teaser - a drop that reached in there
      // would be the filter eating real conversation. Also an UNFIRED TRIPWIRE:
      // the latest drop on either fixture ends at 44.6s, and no bar setting
      // admits a candidate that starts later, so this has never been red. Kept
      // because overreach is the expensive failure mode, not because it is
      // proven.
      const MONTAGE_ENDS_SEC = 50;
      const overreach = drops
        .filter((d) => d.endSec > MONTAGE_ENDS_SEC)
        .map((d) => `${d.id} ${d.startSec}-${d.endSec}s (${d.recurrence})`);
      expect(overreach, `${name}: a teaser drop reached past the montage`).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  it("the legitimate opening question is never mistaken for the montage", async () => {
    // The false positive this filter can commit is dropping a real cold open.
    // Both fixtures contain one at ~87s - "Бытует мнение, что люди - это главные
    // разрушители планеты... Так ли это?" - which sits INSIDE the 120s teaser
    // window and is therefore recurrence-tested on every run.
    //
    // Asserted against the PREDICATE rather than against the shipped clips on
    // purpose. Whether that moment ships is a critic decision that moves between
    // recordings and between knob settings (it does not ship in answer-arc once
    // the filter is switched off - see the montage case above); whether the
    // filter would eat it is a deterministic property of the transcript, and
    // that is the thing this change can break.
    //
    // The two halves have very different strengths, measured 2026-07-25, and
    // the comment should not flatter the weaker one:
    //   NEGATIVE half (cold open not flagged) - robust rather than
    //   load-bearing. It scores exactly 0.0000 on both fixtures and stays
    //   0.0000 with TEASER_MIN_RUN weakened to 4 or 3. No knob reachable from
    //   here makes the filter wrong about it; that is the filter being right,
    //   which is worth pinning but is not a proven-red assertion.
    //   POSITIVE half (bait line flagged) - ONE GUARD, genuinely load-bearing:
    //   raising the shipped teaserRecurrenceFrac default past 1.0 reds it
    //   (measured at 1.1). It is what stops a filter that has been switched off
    //   entirely from leaving the negative half green forever.
    for (const name of CASES) {
      const { fixture } = await run(name);
      const cfg = loadAnalyzeConfig({});
      const nodes = buildSentenceGraph(fixture.transcript.segments, cfg);
      const find = (needle: string) => {
        const index = nodes.findIndex((n) => n.text.includes(needle));
        expect(index, `${name}: fixture no longer contains "${needle}"`).toBeGreaterThanOrEqual(0);
        return index;
      };
      // The real cold open - spoken once, so nothing of it recurs.
      const question = find("главные вообще разрушители планеты");
      expect(
        isTeaserCandidate(nodes, { startNode: question, endNode: question + 4 }, cfg),
        `${name}: the legitimate opening question was flagged as a montage copy`
      ).toBe(false);
      // The montage's own opening line, for contrast: same window, same test,
      // opposite answer. Without this the case above could pass on a filter that
      // had stopped working entirely.
      const bait = find("Человек");
      expect(
        isTeaserCandidate(nodes, { startNode: bait, endNode: bait }, cfg),
        `${name}: the montage bait line was NOT flagged`
      ).toBe(true);
    }
  });
});

function ngrams(words: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) out.push(words.slice(i, i + size).join(" "));
  return out;
}
