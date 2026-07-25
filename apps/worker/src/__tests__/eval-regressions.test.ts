import { describe, expect, it } from "vitest";
import type { SubtitleWord } from "@clipclap/shared";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { V2Result } from "../analyze-v2/types";
import { loadFixture, runFixture, type Fixture } from "./helpers/eval-fixture";

/**
 * Tier-1 "never again" regressions.
 *
 * Each case below is a defect the owner saw in a real shipped clip. The
 * assertions state the RULE and derive everything from the fixture transcript at
 * the clip boundary - never from a hardcoded range - so they keep their meaning
 * when the fixtures are re-recorded. Exact output is pinned separately by
 * eval-snapshot.test.ts; this file is about behaviour that must stay true.
 *
 * Every rule here was verified load-bearing: its enforcing guard was disabled by
 * hand and the case was watched go red. Where a rule has NO enforcing guard, or
 * is violated by the engine today, the test comment says so out loud - a green
 * test that cannot fail is worse than no test.
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
    // Proven load-bearing: dropping the `&& !startsLowercase(n.text)` term from
    // snap's clean-start walk makes podcast-ecology ship 2128.05-2147.42
    // "Почему эволюция не успеет нас спасти", which opens on the word "слишком".
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
  // the `.fails` is deleted and this becomes an ordinary never-again test. It is
  // NOT asserted green on podcast-answer-arc either, because nothing enforces it
  // there: disabling snap's clean-end repair does move one answer-arc clip
  // (882.8-934.1 -> 882.8-931.9) but produces no comma ending, i.e. that fixture
  // passes the rule by luck, not by guard.
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
  it("no clip is shorter than the hard minimum", async () => {
    // Owner's complaint: two-second stingers shipped as clips. This is also the
    // ONLY guard currently standing between the intro montage and the output
    // (see the two cases below), so it is load-bearing three times over.
    //
    // Enforced by the `duration < cfg.hardMinSec` drop in snap.ts. Proven
    // load-bearing: with hardMinSec=0 podcast-ecology ships a 3.03s clip at
    // 36.53-39.56.
    const hardMinSec = loadAnalyzeConfig({}).hardMinSec;
    const offenders: string[] = [];
    for (const name of CASES) {
      const { result } = await run(name);
      for (const clip of result.highlights) {
        const duration = clip.end - clip.start;
        if (duration < hardMinSec) {
          offenders.push(`${label(name, clip)} is ${duration.toFixed(2)}s`);
        }
      }
    }
    expect(offenders, `a clip is shorter than ${hardMinSec}s`).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it("no two clips open on the same spoken line", async () => {
    // Owner's complaint: two clips in one batch that start with the identical
    // sentence - one of them the intro montage's copy of the other.
    //
    // NO DEDICATED GUARD EXISTS. In podcast-ecology the montage copy c2
    // (36.7-39.3, "Что убьет человечество / Собственная глупость конечно") and
    // the real moment c29 (2806.87, same opening words) were BOTH kept by the
    // critic, at 0.80 and 0.92; only snap's too_short drop stopped the pair from
    // shipping. Proven by that: with hardMinSec=0 both ship and this test goes
    // red. Until a hook-dedup pass exists, this rule passes by side effect -
    // treat a failure here as the duplicate defect returning, not as noise.
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
    // NO DEDICATED GUARD EXISTS (the teaser filter is not built yet). Proven by
    // the same experiment as above: with hardMinSec=0 podcast-ecology ships
    // 36.53-39.56 with a recurrence fraction of 1.0 and this test goes red.
    // The legitimate opening question at 87.43-156.96 stays under the threshold
    // in the same run - it is spoken once, so nothing of it recurs later.
    const NGRAM = 5;
    const MAX_RECURRENCE = 0.5;
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
});

function ngrams(words: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) out.push(words.slice(i, i + size).join(" "));
  return out;
}
