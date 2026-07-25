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
  it("no clip is shorter than the product floor", async () => {
    // Owner's complaint: two-second stingers shipped as clips.
    //
    // Enforced by the `duration < cfg.hardMinSec` drop in snap.ts. Proven
    // load-bearing: with hardMinSec=0 podcast-ecology ships a 3.03s clip at
    // 36.53-39.56.
    //
    // It used to be the ONLY thing standing between the intro montage and the
    // output as well - which is why that 3.03s clip is a montage fragment. The
    // teaser filter (analyze-v2/teaser.ts) now removes the montage candidate
    // before the critic ever sees it, so the two cases below no longer lean on
    // this one, and the duration floor is back to guarding only duration.
    //
    // MIN_CLIP_SEC is deliberately a LITERAL and NOT cfg.hardMinSec: the knob is
    // what the engine compares against, so reading it here would make the test
    // move with the defect instead of catching it. Dropping the default to 0
    // ships that 3.03s clip and this case stayed green, its message reading
    // "a clip is shorter than 0s". The realistic way the stingers come back is
    // exactly that - a knob edit, or a CLIP_HARD_MIN_SEC override in prod - so
    // the number below states the PRODUCT rule and only a product decision may
    // change it. (The default itself is pinned separately in
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
    // NO DEDICATED DEDUP GUARD EXISTS - but the specific duplicate the owner hit
    // is now prevented upstream. In podcast-ecology the montage copy c2
    // (36.7-39.3, "Что убьет человечество / Собственная глупость конечно") and
    // the real moment c29 (2806.87, same opening words) were BOTH kept by the
    // critic, at 0.80 and 0.92, and only snap's too_short drop stopped the pair
    // from shipping. The teaser filter now drops c2 before selection, so with
    // hardMinSec=0 podcast-ecology ships the real moment ALONE (measured
    // 2026-07-25: the 36.53-39.56 copy is gone, 87.43-156.96 is untouched).
    // Paraphrase duplicates - the same claim in different words - still have no
    // guard and wait on the finalizer; treat a failure here as the duplicate
    // defect returning, not as noise.
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
    // candidates BEFORE selectCriticCandidates. Proven load-bearing: with the
    // filter disabled (teaserRecurrenceFrac > 1) and hardMinSec=0 to strip the
    // duration floor that used to hide it, podcast-ecology ships 36.53-39.56
    // "Что на самом деле убьёт человечество" at 0.80 - a 3.03s copy of the
    // moment it ships properly at 2807s. With the filter on, the same run does
    // not. The legitimate opening question (87.43-156.96 in podcast-ecology,
    // 86.33-155.18 in podcast-answer-arc) survives BOTH runs: it is inside the
    // 120s teaser window and is spoken once, so its recurrence is exactly 0.000.
    //
    // MAX_RECURRENCE is a LITERAL, not cfg.teaserRecurrenceFrac, for the reason
    // spelled out on MIN_CLIP_SEC above: reading the knob would make the test
    // move with the defect. It states the PRODUCT rule - a shipped clip must not
    // be a copy of later speech - and is set to the same 0.35 the filter uses so
    // that loosening the knob shows up here instead of passing silently.
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
      // Every drop must be a real copy, not a marginal one scraping the bar.
      for (const drop of drops) {
        expect(
          drop.recurrence,
          `${name}: ${drop.id} was dropped on a recurrence of only ${drop.recurrence}`
        ).toBeGreaterThanOrEqual(0.35);
      }
      // The montage is the first 45 seconds; the host's own "Всем привет, это
      // подкаст сортировочный" at ~45.5s is where the real episode starts.
      // Nothing past it may be called a teaser - a drop that reached in there
      // would be the filter eating real conversation.
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
    // recordings (it was gate-dropped in podcast-answer-arc's previous roll and
    // ships in this one); whether the filter would eat it is a deterministic
    // property of the transcript, and that is the thing this change can break.
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
