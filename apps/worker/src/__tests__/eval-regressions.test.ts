import { describe, expect, it } from "vitest";
import type { SubtitleWord } from "@clipclap/shared";
import type { V2Result } from "../analyze-v2/types";
import { loadFixture, runFixture, type Fixture } from "./helpers/eval-fixture";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import {
  buildSentenceGraph,
  carriesOnlyFiller,
  looksLikeQuestion,
} from "../analyze-v2/sentence-graph";
import { detectTeaserRegion, isInTeaserRegion } from "../analyze-v2/teaser";
import { EVIDENCE_BOUNDARY_SLACK_NODES } from "../analyze-v2/gates";

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
 *
 * 2026-07-26: BOTH FIXTURES WERE RE-RECORDED when FINALIZE was wired in, so every
 * scanner and critic answer behind these cases is a fresh roll and the offenders
 * named in the 2026-07-25 measurements describe clips that no longer exist. What
 * was re-measured against the new recordings, and what was not:
 *   RE-CONFIRMED   the teaser region (11 hits, 0.00-44.64s, endSec 59.64, origin
 *                  spread ~2374s) is identical on both fixtures; TEASER_MIN_HITS
 *                  =12 still empties it; the cold open at node #26 is still
 *                  outside the region and the bait at node #0 still inside.
 *   RE-CONFIRMED   hardMinSec=0 alone is still inert - same clip count as
 *                  baseline, no offender in any case, on both fixtures.
 *   CHANGED        the mid-clause defect stopped reproducing. See that case.
 *   NOT MEASURABLE ANY MORE, and this is a real loss: every "teaser filter off"
 *                  arm below. Disabling the filter puts the montage candidates
 *                  back into the critic batches, which changes the prompt text,
 *                  which has no recording - the run now dies on "critic failed
 *                  for batch [...]" instead of producing an answer. The old
 *                  fixtures could run that arm only because they predated the
 *                  filter. The TWO GUARDS claims below therefore keep their
 *                  first arm and have LOST their second; they are not
 *                  re-verified, and nothing should cite them as if they were.
 *                  Restoring that arm costs a paid re-record with the filter
 *                  disabled - worth doing only if the filter is changed.
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
  startSec: number;
  endSec: number;
}

interface TeaserRegionTelemetry {
  endSec: number;
  hits: number;
  firstHitStartSec: number;
  lastHitEndSec: number;
  originSpreadSec: number;
}

function teaserDrops(result: V2Result): TeaserDrop[] {
  const drops = (result.telemetry as Record<string, unknown>).teaserDrops;
  expect(Array.isArray(drops), "teaserDrops telemetry is missing").toBe(true);
  return drops as TeaserDrop[];
}

/** The published montage region, or null when the detector did not fire.
 *  A missing KEY is a different failure from a null value and must not pass as
 *  one: the point of publishing the region is that a false positive is visible
 *  in the job record instead of being an unexplained missing clip. */
function teaserRegion(result: V2Result): TeaserRegionTelemetry | null {
  const telemetry = result.telemetry as Record<string, unknown>;
  expect(telemetry, "teaserRegion telemetry is missing").toHaveProperty("teaserRegion");
  return telemetry.teaserRegion as TeaserRegionTelemetry | null;
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
    // Measured 2026-07-25: dropping the `&& !startsLowercase(n.text)` term
    // from snap's clean-start walk reds this case ALONE (the other six stay
    // green), on podcast-answer-arc 865.15-900.46 "Почему нынешнее потепление
    // опаснее прошлых катастроф", which opens on the word "приводит". The
    // podcast-ecology 2128.05-2147.42 / "слишком" offender this comment used to
    // name is gone - that output moved when the teaser filter landed. Same
    // guard, different victim; the guard is what matters - which is just as
    // well, because the 2026-07-26 re-recording moved it AGAIN: neither named
    // clip is in either fixture's output now. NOT RE-MEASURED at that date, so
    // "ONE GUARD" is a 2026-07-25 claim about a guard that has not changed,
    // carried forward on evidence that no longer reproduces.
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
  // outside it. In the 2026-07-25 recordings, podcast-ecology 1866.26-1945.76 ends "...Без разумного вида,
  // строящего космические корабли," and the sentence's verb ("любая биосфера
  // обречена") is not in the clip; 907.53-952.14 ends "...перестраивать очень
  // много в сельском хозяйстве," with the enumeration still running.
  //
  // 2026-07-26: this stopped being `it.fails`. Read the next paragraph before
  // treating a red here as a regression, because NOTHING WAS FIXED.
  //
  // NO GUARD, and the rule now holds by LUCK. On the re-recorded fixtures the
  // offender list is empty on both, so the `.fails` wrapper itself began failing
  // ("Expect test to fail") and had to go. The defect was NOT repaired: it was
  // measured off and on the FINALIZE stage on the same recorded critic answers
  // (finalizerEnabled false vs true) and the list is empty in both runs, so the
  // new stage is not what removed it - the critic simply rolled different clip
  // ends this time. The finalizer could not have fixed it in any case: it never
  // moves an end (spec §9 rules end-boundary trimming out of scope), so the only
  // way it could clear this list is by dropping the offending clip outright.
  //
  // So a RED here means the known defect has resurfaced on a re-record, not that
  // someone broke something. The fix is the root cause below, not a re-bless.
  //
  // Root cause, unchanged and still unaddressed: isCleanEnd() treats "the next
  // node has no word timings" as end-of-speech ("music follows"), but
  // hasWords=false only means Whisper's word timings were unreliable - which
  // happens mid-sentence. In the 2026-07-25 recordings node 576 "Без разумного
  // вида строящего космические корабли" was certified a clean end purely because
  // node 577 was opaque. Compounding it, the word objects in these transcripts
  // carry no punctuation at all, so the CLAUSE regex in buildSentenceGraph never
  // fires and a comma never weakens a boundary.
  it("no clip ends mid-clause on a dangling comma", async () => {
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
    //   (TEASER_WINDOW_SEC=0)    26.93s (ecology) / 24.56s (answer-arc).
    //   both                     RED: "podcast-ecology 36.53-39.56 "Что на
    //                            самом деле убьёт человечество" is 3.03s".
    //   [2026-07-26] the two "teaser filter off" arms above are NO LONGER
    //   REPRODUCIBLE on these fixtures - see the dated note in the file
    //   preamble. The hardMinSec=0 arm was re-measured and is still inert.
    // Those guards are the `duration < cfg.hardMinSec` drop in snap.ts and
    // detectTeaserRegion() in analyze-v2/teaser.ts, covering one defect from two
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
    // A DEDICATED DEDUP GUARD NOW EXISTS, as of 2026-07-26: FINALIZE runs
    // findHookDuplicates over the selected set before any LLM sees it, and
    // resolveDuplicatesDetailed keeps the higher-scored member of each group.
    // (Until that stage was wired, analyze-v2/dedup.ts had no consumer at all.)
    // select.ts's post-critic NMS still compares TIME overlap only (>30% of the
    // shorter clip), so it remains unable to notice that a clip at 36.5s and a
    // clip at 2806.9s are the same spoken line - the hook pass is what does.
    //
    // UNFIRED on both fixtures today: hookDedupDrops is empty in both runs, so
    // this case is currently green because no duplicate pair reaches selection,
    // not because the new pass removed one. Do not cite it as proof the pass
    // works; finalize.test.ts is where that pass is actually exercised.
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
    //   [2026-07-26] the two "teaser filter off" arms above are NO LONGER
    //   REPRODUCIBLE on these fixtures - see the dated note in the file
    //   preamble. The hardMinSec=0 arm was re-measured and is still inert.
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
    // later.
    //
    // Enforced by detectTeaserRegion() in analyze-v2/teaser.ts, whose region is
    // applied to merged candidates BEFORE selectCriticCandidates. TWO GUARDS
    // again, re-measured 2026-07-25 against the region filter:
    //   teaser filter off alone (TEASER_WINDOW_SEC=0)  this case green.
    //   hardMinSec=0 alone                             this case green.
    //   both      RED: "podcast-ecology 36.53-39.56 ... repeats later speech
    //             (100%)" - a 3.03s clip titled "Что на самом деле убьёт
    //             человечество", the moment that ships properly at 2807s.
    //   [2026-07-26] the two "teaser filter off" arms above are NO LONGER
    //   REPRODUCIBLE on these fixtures - see the dated note in the file
    //   preamble. The hardMinSec=0 arm was re-measured and is still inert.
    // The duration floor is the second guard only because THIS montage fragment
    // is short; a longer montage would be caught by the filter alone, which is
    // why the filter is not redundant with a duration check.
    //
    // NOTE what the RED offender proves and what it does NOT. Its own 5-gram
    // recurrence is 100% only because this test measures the SHIPPED clip after
    // snapping, and snapping widened it to 36.53-39.56, pulling in words that
    // do recur. The candidate the filter sees (36.68-39.28) scores 0.0000 on
    // every text-similarity metric - it occurs exactly once in the episode. That
    // is why the filter no longer scores candidates at all; see teaser.ts.
    //
    // The legitimate cold open at ~87s is inside the 120s teaser window and the
    // region ends at 59.6s, so it is untouched on both fixtures and ships in
    // every run above (ecology 87.4-157.0, answer-arc 86.3-155.2). That the
    // FILTER never reaches it is pinned deterministically by the last case in
    // this file.
    //
    // MAX_RECURRENCE is a LITERAL and it is measured with a plain 5-gram
    // fraction here rather than by calling into teaser.ts, for the reason
    // spelled out on MIN_CLIP_SEC above: reading the implementation would make
    // the test move with the defect. It states the PRODUCT rule - a shipped clip
    // must not be a copy of later speech - in terms that do not depend on how
    // the filter decides. It is a CEILING, not a tripwire on any knob: no
    // reachable teaser setting reds it on its own.
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
    // Both fixtures are two transcription runs of the same episode, so the
    // region must agree on WHERE it is even though the node numbering does not
    // line up. Measured 2026-07-25, both fixtures independently: 11 hits,
    // 0.00-44.64s, endSec 59.6, origin spread 2374-2375s of a 3136s episode.
    //
    // ONE GUARD, and it is the case in this file that catches a loosened knob:
    // measured, raising the shipped TEASER_MIN_HITS default to 12 empties the
    // region on both fixtures and reds this. (11 leaves it green - the montage
    // scores exactly 11.) The absence case above does NOT catch that, so do not
    // rely on it for this.
    for (const name of CASES) {
      const { result } = await run(name);
      const region = teaserRegion(result);
      expect(region, `${name}: the intro montage was not detected at all`).not.toBeNull();
      expect(
        teaserDrops(result).length,
        `${name}: a montage region fired but dropped no candidate`
      ).toBeGreaterThan(0);

      // The montage is the first 45 seconds; the host's own "Всем привет, это
      // подкаст сортировочный" at 45.52s is where the real episode starts.
      // Nothing past it may be called a teaser. This is where OVERREACH shows
      // up, and overreach is now the whole risk of the design: the region is a
      // position, so everything starting inside it dies whatever it says.
      //
      // Asserted on the REGION rather than on the drops, which is a real
      // strengthening over what stood here before. The old version checked only
      // the candidates that happened to exist, so a region that ran to 200s
      // would have passed unnoticed on a fixture whose scanner proposed nothing
      // there. UNFIRED TRIPWIRE all the same: lastHitEndSec is 44.6s on both
      // fixtures and no reachable knob moves it, because nothing in the real
      // show's opening minutes recurs at all (the first non-zero node after the
      // montage is at 717s).
      const MONTAGE_ENDS_SEC = 50;
      expect(
        region!.lastHitEndSec,
        `${name}: the montage region reached past the montage`
      ).toBeLessThanOrEqual(MONTAGE_ENDS_SEC);
      expect(region!.firstHitStartSec, `${name}: the region is not anchored at the start`).toBeLessThan(
        MONTAGE_ENDS_SEC
      );
      const overreach = teaserDrops(result)
        .filter((d) => d.endSec > MONTAGE_ENDS_SEC)
        .map((d) => `${d.id} ${d.startSec}-${d.endSec}s`);
      expect(overreach, `${name}: a teaser drop reached past the montage`).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  it("the legitimate opening question is never mistaken for the montage", async () => {
    // The false positive this filter can commit is dropping a real cold open.
    // Both fixtures contain one at ~87s - "Бытует мнение, что люди - это главные
    // разрушители планеты... Так ли это?" - which sits INSIDE the 120s teaser
    // window and is therefore exposed to the filter on every run.
    //
    // Asserted against the PREDICATE rather than against the shipped clips on
    // purpose: whether that moment ships is a critic decision that moves between
    // recordings, while whether the filter would eat it is a deterministic
    // property of the transcript, and that is the thing this change can break.
    //
    // The two halves have very different strengths, measured 2026-07-25, and
    // the comment should not flatter the weaker one:
    //   NEGATIVE half (cold open outside the region) - robust rather than
    //   load-bearing. The region ends at 59.6s and the cold open starts at
    //   88.6s, a 29s margin, and no knob reachable from here closes it: the
    //   region end is pinned by the last montage hit at 44.64s plus a 15s pad,
    //   and the show's opening minutes contain no recurring sentence to extend
    //   it with. That is the filter being right, not a proven-red assertion.
    //   POSITIVE half (bait line inside the region) - ONE GUARD, genuinely
    //   load-bearing: TEASER_MIN_HITS=12 reds it. It is what stops a filter that
    //   has been switched off entirely from leaving the negative half green
    //   forever.
    for (const name of CASES) {
      const { fixture } = await run(name);
      const cfg = loadAnalyzeConfig({});
      const nodes = buildSentenceGraph(fixture.transcript.segments, cfg);
      const region = detectTeaserRegion(nodes, cfg);
      const find = (needle: string) => {
        const index = nodes.findIndex((n) => n.text.includes(needle));
        expect(index, `${name}: fixture no longer contains "${needle}"`).toBeGreaterThanOrEqual(0);
        return index;
      };
      // The real cold open - spoken once, and 29s clear of the region's end.
      const question = find("главные вообще разрушители планеты");
      expect(
        isInTeaserRegion(region, nodes[question].start),
        `${name}: the legitimate opening question was swallowed by the montage region`
      ).toBe(false);
      // The montage's own opening line, for contrast: same video, same test,
      // opposite answer. Without this the case above could pass on a filter that
      // had stopped working entirely.
      const bait = find("Человек");
      expect(
        isInTeaserRegion(region, nodes[bait].start),
        `${name}: the montage bait line was NOT inside the region`
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  it("no applied trim orphans the question its new opening answers", async () => {
    // Owner-visible defect: podcast-answer-arc clip c36 shipped opening on
    // "Вообще то думать это энергозатратно" (node 870), the answer to the host's
    // "какие претензии" (node 869) - which the finalizer's own trim had just
    // deleted. Its prompt rule 3 ("trim a meandering opening forward") beat its
    // rule 5 ("never open on an answer whose question stayed outside"), and no
    // code gate objected: 870 is a legal clean start, it is before the payoff,
    // and the trimmed verdict re-snapped cleanly.
    //
    // Asserted over the trims the stage APPLIED rather than over shipped clip
    // ranges, because that is exactly the decision orphansQuestion() governs -
    // see the loud caveat below for what it does not.
    //
    // ONE GUARD - measured 2026-07-26 by making orphansQuestion() return false
    // as its first statement. podcast-answer-arc reds here with
    // "c36 866->870 orphans #869", and eval-snapshot reds alongside it as that
    // clip's range returns to 3073.2-3117.8 (start +15.5s). podcast-ecology
    // stays green in both arms: its one applied trim, c15 332->334, removes
    // reply grammar and an on-air name search and orphans nothing.
    //
    // SAID LOUDLY - this gate does NOT make the fixtures free of the defect,
    // only free of the stage CAUSING it. Measured at HEAD on the same date,
    // two shipped clips still open one node after a question:
    //   podcast-ecology  3073.4 opens #846 straight after #845 "Да А какие
    //                    претензии" - the identical moment, reached by the
    //                    CRITIC picking that start, with no trim involved.
    //   podcast-answer-arc 3057.7 opens #864 after #863 "Руки такие же оставим,
    //                    как сейчас?" - milder, because #864 restates its own
    //                    subject ("Руки ... можно такие же оставить").
    // Neither is reachable from here: this gate only ever vetoes a trim. Closing
    // them means a rule on ORIGINAL critic boundaries, which is snap's territory
    // and a strictly larger change - and the answer-arc row shows why it needs
    // its own measurement rather than this predicate, since it would refuse a
    // start that is genuinely self-contained.
    const offenders: string[] = [];
    for (const name of CASES) {
      const { fixture, result } = await run(name);
      const nodes = buildSentenceGraph(fixture.transcript.segments, loadAnalyzeConfig({}));
      const trims = ((result.telemetry as Record<string, unknown>).openingTrims ??
        []) as Array<{ id: string; fromNode: number; toNode: number }>;
      for (const trim of trims) {
        // Walk back from the new opening through the removed run, skipping
        // discourse particles - the first thing actually said must not be a
        // question, or the new opening is its answer.
        for (let i = trim.toNode - 1; i >= trim.fromNode; i--) {
          if (looksLikeQuestion(nodes[i].text)) {
            offenders.push(
              `${name} ${trim.id} ${trim.fromNode}->${trim.toNode} orphans #${i} "${nodes[i].text}"`
            );
            break;
          }
          if (!carriesOnlyFiller(nodes[i].text)) break;
        }
      }
    }
    expect(offenders, "an applied trim deleted the question it answers").toEqual([]);
  });

  it("the node range published with a clip is the range that shipped", async () => {
    // Owner-visible defect on job cms2c8ahm, clip "Самые живучие на планете":
    // _descriptionEvidenceNodes = [804, 812, 819] where 804 sits OUTSIDE the
    // clip - snap's over-length compression had moved the start forward after
    // the evidence gate ran - and the description accordingly narrated the
    // PREVIOUS clip's ending. The root cause is upstream of the copy: snap moved
    // the boundaries and kept publishing the critic's proposal as the clip's
    // range, so every later range check (copy grounding, the finalizer's hook
    // dedup and trim guards) was answered against nodes the viewer never hears.
    //
    // ONE GUARD - measured 2026-07-26 by returning `verdict.startNode` /
    // `verdict.endNode` from snapNodes' finalStartNode/finalEndNode. Three
    // podcast-answer-arc rows come back, and they are the three places snap
    // moved a boundary on that fixture:
    //   1868.05-1949.98 "Человек — зло для планеты..." says it ends at #585
    //                   (1954.68s) - the payoff-tail rule pulled the end to #584.
    //   3057.75-3117.80 "Почему людям так больно думать..." says it starts at
    //                   #866 (3062.96s) - the clean-start walk-back went to #864.
    //   907.53-934.08   "«Ждите малярийных комаров...»" says it ends at #289
    //                   (931.58s) - the clean-end repair walked forward to #290.
    // podcast-ecology reds on none: snap moved nothing there. One fixture is not
    // a net.
    const offenders: string[] = [];
    for (const name of CASES) {
      const { fixture, result } = await run(name);
      const nodes = buildSentenceGraph(fixture.transcript.segments, loadAnalyzeConfig({}));
      const cfg = loadAnalyzeConfig({});
      for (const clip of result.highlights) {
        const from = clip._startNode;
        const to = clip._endNode;
        if (from === undefined || to === undefined) {
          offenders.push(`${label(name, clip)} publishes no node range`);
          continue;
        }
        // startSec is the node onset less at most leadInSec; endSec is the node
        // end plus at most tailHoldSec (and never less than the node end).
        const onset = nodes[from].start;
        const tail = nodes[to].end;
        if (clip.start < onset - cfg.leadInSec - EPS || clip.start > onset + EPS) {
          offenders.push(
            `${label(name, clip)} says it starts at #${from} (${onset.toFixed(2)}s)`
          );
        }
        if (clip.end < tail - EPS || clip.end > tail + cfg.tailHoldSec + EPS) {
          offenders.push(`${label(name, clip)} says it ends at #${to} (${tail.toFixed(2)}s)`);
        }
      }
    }
    expect(offenders, "a clip's published node range is not the range it shipped").toEqual([]);
  });

  it("no shipped clip's copy cites speech the viewer never hears", async () => {
    // The consequence of the range lie above, and the defect the owner actually
    // saw. Tolerance is EVIDENCE_BOUNDARY_SLACK_NODES, the same slack
    // widenRangeToEvidence uses to pull a boundary OUT to swallow a citation
    // before snap: podcast-ecology's one applied trim (332 -> 334) leaves the
    // "Плейстоценовый парк" title citing 332, two nodes out, while the title is
    // still fully grounded in 334 and 348 - a boundary artefact, not a lost
    // premise. On job cms2c8ahm the same measurement puts node 804 THREE nodes
    // and 24.8s outside, and the copy carrying it was false.
    //
    // TWO GUARDS, both measured 2026-07-26.
    //   regroundCopy() returning its input unchanged: this case stays GREEN on
    //   both fixtures, because at the 2-node slack neither fixture has a stale
    //   citation. It is a floor, not a proof - the case it was built from lives
    //   in gates.test.ts with the real node table, and the unit tests there red.
    //   EVIDENCE_BOUNDARY_SLACK_NODES = 0: this case still passes, but
    //   eval-snapshot reds, because podcast-ecology's "Плейстоценовый парк: как
    //   в Якутии готовят дом для мамонтов" is replaced by the verbatim snippet
    //   "Сергей Зимин который пристациновый парк пилит в Ягутии" - transcription
    //   errors and all - over a citation on #332 that the title never needed.
    //   That is the false positive the slack exists to avoid.
    const offenders: string[] = [];
    for (const name of CASES) {
      const { result } = await run(name);
      for (const clip of result.highlights) {
        const from = (clip._startNode ?? 0) - EVIDENCE_BOUNDARY_SLACK_NODES;
        const to = (clip._endNode ?? 0) + EVIDENCE_BOUNDARY_SLACK_NODES;
        for (const [field, cited] of [
          ["title", clip._titleEvidenceNodes ?? []],
          ["description", clip._descriptionEvidenceNodes ?? []],
        ] as const) {
          for (const i of cited) {
            if (i < from || i > to) {
              offenders.push(`${label(name, clip)} ${field} cites #${i}, outside [${from}..${to}]`);
            }
          }
        }
      }
    }
    expect(offenders, "shipped copy is grounded in speech outside the clip").toEqual([]);
  });
});

function ngrams(words: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) out.push(words.slice(i, i + size).join(" "));
  return out;
}
