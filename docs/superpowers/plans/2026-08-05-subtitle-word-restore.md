# Subtitle Word Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw the word Whisper never timed. 10.7% of transcript segments lose a word that is spoken in the clip and absent from the burned caption; this restores it.

**Architecture:** Two pure functions added to `apps/worker/src/processors/subtitles.ts`. `comparableStream` normalises a string for comparison only. `restoreDroppedWords` compares a segment's `text` against its `words[]` on that stream and puts the missing head or tail back as one timing entry, using the segment's own boundaries. `segmentsToCues` calls it before its existing window filter. A third helper counts outcomes for telemetry. No new module, no schema change, no feature flag.

**Tech Stack:** TypeScript, vitest, Prisma (read-only, in the acceptance script), ffmpeg (untouched by this work).

**Spec:** [2026-08-05-subtitle-word-restore-design.md](../specs/2026-08-05-subtitle-word-restore-design.md). Read §3.1, §4.1 and §7 before Task 2 - two of the three are corrections made in review and the reasons matter.

---

## Before you start

**Every command runs inside a container. Host Node is v18 and cannot run vitest.**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Baseline right now: **12 tests, all passing.** If that is not what you see, stop and find out why before changing anything.

Source is bind-mounted and `tsx` hot-reloads, so an edit on the host is live in the container immediately. No rebuild, no restart.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/worker/src/processors/subtitles.ts` | cue construction; gains the two pure helpers and one summary helper | Modify |
| `apps/worker/src/processors/__tests__/subtitles.test.ts` | unit + integration coverage | Modify |
| `apps/worker/src/stages/render.ts` | records the summary into `renderManifest` | Modify |
| `apps/worker/src/scripts/eval-subtitle-coverage.ts` | the acceptance measurement, run before and after | Create |

Everything lives beside the code it belongs to. `subtitles.ts` is 255 lines and stays comfortably focused; no split is needed.

---

### Task 1: `comparableStream` and the split helper

The comparison form. Every later task depends on it, and §3.1 of the spec exists because two different naive versions of this produced two different wrong measurements.

**Files:**
- Modify: `apps/worker/src/processors/subtitles.ts`
- Test: `apps/worker/src/processors/__tests__/subtitles.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/processors/__tests__/subtitles.test.ts`:

```ts
describe("comparableStream", () => {
  it("keeps letters and digits, drops everything else, folds case", () => {
    expect(comparableStream("It was 5.30 in the morning,")).toBe("itwas530inthemorning");
    expect(comparableStream("Bing?")).toBe("bing");
    expect(comparableStream("Y-O-U-R means you're.")).toBe("yourmeansyoure");
  });

  it("does not erase Cyrillic", () => {
    expect(comparableStream("Там хорошая компания подбирается.")).toBe(
      "тамхорошаякомпанияподбирается"
    );
  });

  it("treats composed and decomposed forms as equal", () => {
    // "й" as one code point vs "и" + combining breve
    expect(comparableStream("й")).toBe(comparableStream("й"));
  });

  it("agrees when Whisper splits a number into two tokens", () => {
    expect(comparableStream("5.30")).toBe(comparableStream(["5", "30"].join("")));
  });

  it("does not fold compatibility forms - NFC, not NFKC", () => {
    // U+FB01 LATIN SMALL LIGATURE FI. NFKC would decompose it to "fi" and make
    // these compare equal; NFC leaves it alone (spec 3.1). Without this the
    // NFC-to-NFKC mutation survives every other test in the file - found by
    // mutation-testing the first implementation, not by reasoning.
    expect(comparableStream("ﬁ")).not.toBe(comparableStream("fi"));
  });
});

describe("splitAtComparable", () => {
  it("splits right after the Nth comparable character", () => {
    // "We think an" is 9 comparable characters: W,e + t,h,i,n,k + a,n.
    // Count them before trusting this number; an earlier draft said 10, which
    // would have split inside "affair".
    expect(splitAtComparable("We think an affair.", 9)).toEqual([
      "We think an",
      " affair.",
    ]);
  });

  it("returns the whole string as the head when N covers everything", () => {
    expect(splitAtComparable("Там", 3)).toEqual(["Там", ""]);
  });

  it("returns an empty head for N of 0", () => {
    expect(splitAtComparable("Там", 0)).toEqual(["", "Там"]);
  });
});
```

And extend the import on line 2 of that file:

```ts
import {
  comparableStream,
  generateAss,
  segmentsToCues,
  sliceCues,
  splitAtComparable,
} from "../subtitles";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: FAIL, `comparableStream is not a function` (or a transform error naming the missing export).

- [ ] **Step 3: Implement both helpers**

In `apps/worker/src/processors/subtitles.ts`, directly above `export function segmentsToCues`:

```ts
// Comparison form ONLY. Never rendered, never stored, never shown to a user -
// what reaches the viewer is always an exact substring of the segment's own
// text. NFC and not NFKC: NFKC folds compatibility forms, which would let two
// visibly different strings compare equal, the opposite of what this is for.
// \p{L}\p{N} and not [a-z0-9]: the latter reduces every Russian segment to the
// empty string and would report a total loss on the whole language.
export function comparableStream(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const COMPARABLE_CHAR = /[\p{L}\p{N}]/u;

/** Splits `text` immediately after its `keep`-th comparable character, so the
 *  head carries exactly `keep` of them and the tail carries the rest with its
 *  original punctuation and spacing intact. Iterates code points, not code
 *  units, so a surrogate pair is never cut in half. */
export function splitAtComparable(text: string, keep: number): [string, string] {
  if (keep <= 0) return ["", text];
  let seen = 0;
  let idx = 0;
  for (const ch of text) {
    idx += ch.length;
    if (COMPARABLE_CHAR.test(ch)) {
      seen += 1;
      if (seen === keep) return [text.slice(0, idx), text.slice(idx)];
    }
  }
  return [text, ""];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: PASS, 20 tests (12 existing + 8 new).

**Then mutate the implementation and confirm each mutation is caught**, because a guard that no test can kill is the failure mode this repo has already shipped once. Flip `NFC` to `NFKC`, `\p{L}\p{N}` to `a-z0-9`, `seen === keep` to `seen === keep + 1`, and remove `.toLowerCase()`; each must turn at least one test red. Restore the correct implementation afterwards.

Test counts quoted in later tasks assume 20 here. They are guidance for spotting a missing test, not contracts.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors/subtitles.ts apps/worker/src/processors/__tests__/subtitles.test.ts
git commit -m "feat(subtitles): a comparison form that survives Whisper's tokenisation

Token counts miss a loss when 5.30 becomes two tokens; token sets invent one
when Y-O-U-R becomes four letters. Only the concatenated character stream is
safe, and [a-z0-9] would erase Cyrillic entirely."
```

---

### Task 2: `restoreDroppedWords` - the tail case

The commonest shape: 64 of 75 English losses. The test data is taken verbatim from the corpus.

**Files:**
- Modify: `apps/worker/src/processors/subtitles.ts`
- Test: `apps/worker/src/processors/__tests__/subtitles.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("restoreDroppedWords - tail", () => {
  it("restores the last word Whisper never timed", () => {
    // Verbatim from job cmsg4y7rw0001fqbf8dimdrb0; "affair" is absent from words[]
    const words = [
      { text: "We", start: 10.0, end: 10.2 },
      { text: "think", start: 10.2, end: 10.5 },
      { text: "Chandler", start: 10.5, end: 10.9 },
      { text: "might", start: 10.9, end: 11.1 },
      { text: "be", start: 11.1, end: 11.3 },
      { text: "having", start: 11.3, end: 11.7 },
      { text: "an", start: 11.7, end: 11.9 },
    ];
    const out = restoreDroppedWords(
      "We think Chandler might be having an affair.",
      words,
      10.0,
      12.6
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(8);
    expect(out.words[7]).toEqual({ text: "affair.", start: 11.9, end: 12.6 });
  });

  it("restores when the token counts happen to match", () => {
    // "5.30" is two word entries, so a count test sees 6 against 6 and misses it
    const words = [
      { text: "It", start: 0, end: 0.2 },
      { text: "was", start: 0.2, end: 0.4 },
      { text: "5", start: 0.4, end: 0.6 },
      { text: "30", start: 0.6, end: 0.9 },
      { text: "in", start: 0.9, end: 1.0 },
      { text: "the", start: 1.0, end: 1.2 },
    ];
    const out = restoreDroppedWords("It was 5.30 in the morning,", words, 0, 1.8);
    expect(out.outcome).toBe("tail");
    expect(out.words[6].text).toBe("morning,");
  });

  it("leaves a complete segment untouched", () => {
    const words = [
      { text: "Y", start: 0, end: 0.1 },
      { text: "O", start: 0.1, end: 0.2 },
      { text: "U", start: 0.2, end: 0.3 },
      { text: "R", start: 0.3, end: 0.4 },
      { text: "means", start: 0.4, end: 0.7 },
      { text: "you're", start: 0.7, end: 1.0 },
    ];
    const out = restoreDroppedWords("Y-O-U-R means you're.", words, 0, 1.0);
    expect(out.outcome).toBe("none");
    expect(out.words).toEqual(words);
  });

  it("leaves a segment with no word timings untouched", () => {
    const out = restoreDroppedWords("Anything at all", [], 0, 2);
    expect(out.outcome).toBe("none");
    expect(out.words).toEqual([]);
  });
});
```

Extend the import to include `restoreDroppedWords`.

- [ ] **Step 2: Run to verify it fails**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: FAIL, `restoreDroppedWords is not a function`.

- [ ] **Step 3: Implement the tail branch**

Below `splitAtComparable` in `subtitles.ts`:

```ts
export type RestoreOutcome = "none" | "head" | "tail" | "unresolved";

// Below this, the gap between the segment boundary and the nearest timed word
// is too small to be a duration. The text is merged into its neighbour rather
// than given a made-up one.
const MIN_RESTORED_SEC = 0.08;

/**
 * Puts back the head or tail of a segment that Whisper transcribed but never
 * timed. `segmentsToCues` builds cue text from `words[]` alone, so anything
 * missing there is never drawn: measured at 10.7% of segments corpus-wide,
 * and it is the LAST word in English and the FIRST in Russian.
 *
 * Absolute segment times in, absolute times out - the caller still windows and
 * shifts afterwards.
 *
 * The restored span stays ONE timing entry even when it holds several words
 * (8 of 133 measured spans do, the worst holding nine). Splitting it would need
 * a per-word timestamp that nothing here can honestly produce; the cost is a
 * cue that can exceed the chunker's character limit, and that is bounded by
 * what already ships - the wordless fallback path draws cues of median 46 and
 * up to 103 characters today.
 */
export function restoreDroppedWords(
  text: string,
  words: SubtitleWord[],
  segStart: number,
  segEnd: number
): { words: SubtitleWord[]; outcome: RestoreOutcome } {
  if (words.length === 0) return { words, outcome: "none" };
  const flatText = comparableStream(text);
  const flatWords = comparableStream(words.map((w) => w.text).join(""));
  if (flatText === flatWords) return { words, outcome: "none" };

  if (flatText.startsWith(flatWords)) {
    const missing = splitAtComparable(text, flatWords.length)[1].trim();
    if (!missing) return { words, outcome: "none" };
    const last = words[words.length - 1];
    if (segEnd - last.end >= MIN_RESTORED_SEC) {
      return {
        words: [...words, { text: missing, start: last.end, end: segEnd }],
        outcome: "tail",
      };
    }
    return {
      words: [
        ...words.slice(0, -1),
        { ...last, text: `${last.text} ${missing}` },
      ],
      outcome: "tail",
    };
  }

  return { words, outcome: "unresolved" };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: PASS, 24 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors/subtitles.ts apps/worker/src/processors/__tests__/subtitles.test.ts
git commit -m "feat(subtitles): restore the sentence-final word Whisper left untimed

64 of 75 English losses are the last word of the sentence, which is where
punchlines live - 'fight', 'joke', 'affair', 'Monica'."
```

---

### Task 3: the head case, and `unresolved`

53 of 60 Russian losses are the FIRST word. This is the half the documented note got wrong.

**Files:**
- Modify: `apps/worker/src/processors/subtitles.ts`
- Test: `apps/worker/src/processors/__tests__/subtitles.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("restoreDroppedWords - head", () => {
  it("restores the first word, the Russian shape of the defect", () => {
    // Verbatim from job cms7jhcbz0003nb7fkfdki0lp
    const words = [
      { text: "хорошая", start: 5.4, end: 5.9 },
      { text: "компания", start: 5.9, end: 6.4 },
      { text: "подбирается", start: 6.4, end: 7.1 },
    ];
    const out = restoreDroppedWords(
      "Там хорошая компания подбирается.",
      words,
      5.0,
      7.1
    );
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(4);
    expect(out.words[0]).toEqual({ text: "Там", start: 5.0, end: 5.4 });
    expect(out.words[1].text).toBe("хорошая");
  });

  it("reports unresolved when both ends are missing and changes nothing", () => {
    const words = [{ text: "middle", start: 1.0, end: 1.5 }];
    const out = restoreDroppedWords("start middle end", words, 0.5, 2.0);
    expect(out.outcome).toBe("unresolved");
    expect(out.words).toEqual(words);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: FAIL - the head test reports `unresolved` because the branch does not exist yet.

- [ ] **Step 3: Add the head branch**

In `restoreDroppedWords`, between the tail branch and the final `unresolved` return:

```ts
  if (flatText.endsWith(flatWords)) {
    const missing = splitAtComparable(
      text,
      flatText.length - flatWords.length
    )[0].trim();
    if (!missing) return { words, outcome: "none" };
    const first = words[0];
    if (first.start - segStart >= MIN_RESTORED_SEC) {
      return {
        words: [
          { text: missing, start: segStart, end: first.start },
          ...words,
        ],
        outcome: "head",
      };
    }
    return {
      words: [
        { ...first, text: `${missing} ${first.text}` },
        ...words.slice(1),
      ],
      outcome: "head",
    };
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: PASS, 26 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors/subtitles.ts apps/worker/src/processors/__tests__/subtitles.test.ts
git commit -m "feat(subtitles): restore the sentence-initial word, which is the Russian shape

53 of 60 Russian losses are the FIRST word - Там, Без, На, Оно. The documented
claim that this defect is 'almost always the last word' held for English only."
```

---

### Task 4: the multi-word span and the no-room merge

Both branches are rare and both are measured. Neither may invent a timestamp.

**Files:**
- Modify: `apps/worker/src/processors/__tests__/subtitles.test.ts` (tests only - Tasks 2 and 3 already implement these paths)

- [ ] **Step 1: Write the tests**

```ts
describe("restoreDroppedWords - edge shapes", () => {
  it("restores a nine-word span as ONE timing entry", () => {
    // The worst measured span: 36 characters, 9 lexical words
    const words = [
      { text: "Honestly", start: 0, end: 0.5 },
      { text: "though", start: 0.5, end: 0.8 },
    ];
    const out = restoreDroppedWords(
      "Honestly though I'm not sure I'm going to be able to",
      words,
      0,
      3.4
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(3);
    expect(out.words[2]).toEqual({
      text: "I'm not sure I'm going to be able to",
      start: 0.8,
      end: 3.4,
    });
  });

  it("merges into the neighbour when there is no room for a duration", () => {
    const words = [
      { text: "So", start: 0, end: 0.3 },
      { text: "come", start: 0.3, end: 0.9 },
    ];
    // last word ends exactly at the segment end - no gap to place a word in
    const out = restoreDroppedWords("So come on", words, 0, 0.9);
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(2);
    expect(out.words[1]).toEqual({ text: "come on", start: 0.3, end: 0.9 });
  });

  it("merges at the head when the first word starts at the segment start", () => {
    const words = [{ text: "хорошая", start: 5.0, end: 5.9 }];
    const out = restoreDroppedWords("Там хорошая", words, 5.0, 5.9);
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(1);
    expect(out.words[0]).toEqual({ text: "Там хорошая", start: 5.0, end: 5.9 });
  });

  it("never produces a zero-length or inverted restored word", () => {
    const words = [{ text: "one", start: 1.0, end: 1.4 }];
    for (const segEnd of [1.4, 1.42, 1.5]) {
      const out = restoreDroppedWords("one two", words, 1.0, segEnd);
      for (const w of out.words) expect(w.end).toBeGreaterThanOrEqual(w.start);
    }
  });
});
```

- [ ] **Step 2: Run them**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: PASS, 29 tests. If any fail, the bug is in Task 2 or 3 - fix it there rather than weakening the test.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/processors/__tests__/subtitles.test.ts
git commit -m "test(subtitles): pin the multi-word span and the no-room merge

8 of 133 measured spans hold more than one word and the worst holds nine. The
merge branch is what keeps the repair from inventing a duration when the
segment boundary leaves no room."
```

---

### Task 5: wire it into `segmentsToCues`

Reconciliation runs on the raw segment **before** the window filter. The other order reads every straddling segment as a loss.

**Files:**
- Modify: `apps/worker/src/processors/subtitles.ts:41-74`
- Test: `apps/worker/src/processors/__tests__/subtitles.test.ts`

- [ ] **Step 1: Write the failing integration tests**

```ts
describe("segmentsToCues with restoration", () => {
  const dropped: WhisperSegment[] = [
    {
      start: 10.0,
      end: 12.6,
      text: "We think Chandler might be having an affair.",
      words: [
        { text: "We", start: 10.0, end: 10.2 },
        { text: "think", start: 10.2, end: 10.5 },
        { text: "Chandler", start: 10.5, end: 10.9 },
        { text: "might", start: 10.9, end: 11.1 },
        { text: "be", start: 11.1, end: 11.3 },
        { text: "having", start: 11.3, end: 11.7 },
        { text: "an", start: 11.7, end: 11.9 },
      ],
    },
  ];

  it("draws the whole sentence", () => {
    const cues = segmentsToCues(dropped, 10.0, 12.6);
    const drawn = comparableStream(cues.map((c) => c.text).join(""));
    expect(drawn).toBe(comparableStream(dropped[0].text));
  });

  it("keeps the outer window even though the inner split may move", () => {
    const cues = segmentsToCues(dropped, 10.0, 12.6);
    expect(cues[0].start).toBeCloseTo(0);
    expect(cues[cues.length - 1].end).toBeCloseTo(2.6);
  });

  it("does not treat a segment straddling the window edge as a loss", () => {
    // window starts mid-segment: words before 11.3 are filtered out by design
    const cues = segmentsToCues(dropped, 11.3, 12.6);
    const drawn = cues.map((c) => c.text).join(" ");
    expect(drawn).not.toContain("Chandler");
    expect(drawn).toContain("affair.");
  });

  it("leaves complete segments byte-identical", () => {
    // `segments` is the fixture at the top of this file: no segment in it has a
    // gap between text and words, so restoration must be a no-op for all of it.
    const cues = segmentsToCues(segments, 10.0, 25.0);
    expect(cues.map((c) => c.text)).toEqual([
      "Hello everyone",
      "Welcome to the",
      "stream",
      "Today we are going to talk about AI",
    ]);
    // Float noise: 14.6 - 10.0 is not exactly 4.6, so compare approximately -
    // the same reason the pre-existing tests in this file use toBeCloseTo.
    const bounds = [
      [0, 3.5],
      [3.5, 4.6],
      [4.6, 8],
      [8, 15],
    ];
    cues.forEach((c, i) => {
      expect(c.start).toBeCloseTo(bounds[i][0]);
      expect(c.end).toBeCloseTo(bounds[i][1]);
    });
  });
});
```

- [ ] **Step 2: Run to verify the first two fail**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: FAIL on "draws the whole sentence" - the drawn stream ends at `an`, missing `affair`.

- [ ] **Step 3: Call the helper from `segmentsToCues`**

Replace the `words` derivation inside the `flatMap` (currently `subtitles.ts:51-53`):

```ts
      // Restore BEFORE windowing: reconciling after the filter would read every
      // segment straddling the window edge as a loss and append text the window
      // deliberately excludes (spec §4).
      const whole =
        s.words && s.words.length > 0
          ? restoreDroppedWords(s.text, s.words, s.start, s.end).words
          : s.words;
      const words = whole
        ?.filter((w) => w.end > clipStart && w.start < clipEnd)
        .map((w) => shiftWord(w, clipStart));
```

- [ ] **Step 4: Run to verify everything passes**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: PASS, 33 tests. The four pre-existing `segmentsToCues` tests must still pass untouched - they are the byte-identical guarantee for the 89.3% of segments with no loss.

- [ ] **Step 5: Run the whole worker suite for regressions**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker'
```

Expected: PASS. `render-clips-subtitles.test.ts` exercises the same path and must be green.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/processors/subtitles.ts apps/worker/src/processors/__tests__/subtitles.test.ts
git commit -m "feat(subtitles): draw the restored word in the burned caption

Reconciliation runs on the raw segment before the window filter - the other
order reads every straddling segment as a loss."
```

---

### Task 6: telemetry

Without a counter we cannot answer "is it still firing" or notice `unresolved` growing, which is the signal that Whisper's output shape changed.

**Files:**
- Modify: `apps/worker/src/processors/subtitles.ts`
- Modify: `apps/worker/src/stages/render.ts`
- Test: `apps/worker/src/processors/__tests__/subtitles.test.ts`

- [ ] **Step 1: Write the failing test**

Add `summariseRestores` to the import at the top of the test file - by now it reads
`import { comparableStream, generateAss, restoreDroppedWords, segmentsToCues, sliceCues, splitAtComparable, summariseRestores } from "../subtitles";`

```ts
describe("summariseRestores", () => {
  it("counts occurrences and outcomes over a clip window", () => {
    const segs: WhisperSegment[] = [
      {
        start: 0,
        end: 2,
        text: "one two",
        words: [{ text: "one", start: 0, end: 0.5 }],
      },
      {
        start: 2,
        end: 4,
        text: "три четыре",
        words: [{ text: "четыре", start: 3, end: 3.5 }],
      },
      {
        start: 4,
        end: 6,
        text: "all here",
        words: [
          { text: "all", start: 4, end: 4.5 },
          { text: "here", start: 4.5, end: 5 },
        ],
      },
    ];
    expect(summariseRestores(segs, 0, 6)).toEqual({
      segmentOccurrences: 3,
      restoredHead: 1,
      restoredTail: 1,
      unresolved: 0,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: FAIL, `summariseRestores is not a function`.

- [ ] **Step 3: Implement it**

Below `restoreDroppedWords` in `subtitles.ts`:

```ts
export interface RestoreSummary {
  /** (clip, segment) pairs, NOT unique transcript segments - a segment falling
   *  inside two clips counts twice. Measured at 6 of 1265 in the corpus, small
   *  but enough to make a rate computed the other way wrong. */
  segmentOccurrences: number;
  restoredHead: number;
  restoredTail: number;
  unresolved: number;
}

/** What the repair did over one clip window. Pure; mirrors the filter in
 *  segmentsToCues so the two can never disagree about what is in range. */
export function summariseRestores(
  segments: WhisperSegment[],
  clipStart: number,
  clipEnd: number
): RestoreSummary {
  const summary: RestoreSummary = {
    segmentOccurrences: 0,
    restoredHead: 0,
    restoredTail: 0,
    unresolved: 0,
  };
  for (const s of segments) {
    if (!(s.end > clipStart && s.start < clipEnd)) continue;
    if (!s.words || s.words.length === 0) continue;
    summary.segmentOccurrences += 1;
    const { outcome } = restoreDroppedWords(s.text, s.words, s.start, s.end);
    if (outcome === "head") summary.restoredHead += 1;
    else if (outcome === "tail") summary.restoredTail += 1;
    else if (outcome === "unresolved") summary.unresolved += 1;
  }
  return summary;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/processors/__tests__/subtitles.test.ts'
```

Expected: PASS, 35 tests.

- [ ] **Step 5: Record it in the render manifest**

In `apps/worker/src/stages/render.ts`, add `summariseRestores` to the import block from `../processors/subtitles` (currently lines 16-21).

Declare an accumulator beside `reframeChecks` (near line 98):

```ts
    const subtitleSummary = {
      segmentOccurrences: 0,
      restoredHead: 0,
      restoredTail: 0,
      unresolved: 0,
    };
```

Immediately after the `const cues = segmentsToCues(...)` call in the highlights loop (line 106):

```ts
      const restores = summariseRestores(
        transcription.segments,
        highlight.start,
        highlight.end
      );
      subtitleSummary.segmentOccurrences += restores.segmentOccurrences;
      subtitleSummary.restoredHead += restores.restoredHead;
      subtitleSummary.restoredTail += restores.restoredTail;
      subtitleSummary.unresolved += restores.unresolved;
```

And in the `renderManifest` object (near line 293), beside the `reframe` key:

```ts
          subtitles: subtitleSummary,
```

- [ ] **Step 6: Typecheck and run the suite**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx tsc --noEmit -p apps/worker/tsconfig.json && npx vitest run apps/worker'
```

Expected: no type errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/processors/subtitles.ts apps/worker/src/processors/__tests__/subtitles.test.ts apps/worker/src/stages/render.ts
git commit -m "feat(subtitles): record what the restore did in the render manifest

segmentOccurrences and not segments: a source segment inside two clips counts
twice, 6 of 1265 in the corpus. unresolved growing is the signal that Whisper's
output shape has changed."
```

---

### Task 7: the acceptance measurement

This is the task that proves the work. It measures **cues**, not the transcript - the repair never rewrites `words[]`, so the obvious re-measurement would report no improvement on a correct engine.

**Files:**
- Create: `apps/worker/src/scripts/eval-subtitle-coverage.ts`

- [ ] **Step 1: Write the script**

```ts
/**
 * Acceptance metric for the subtitle word restore.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-subtitle-coverage.ts"
 *
 * Measures the CUES, not the transcript. The repair runs when cues are built
 * and never rewrites transcriptJson, so a script that re-reads words[] would
 * report the same number on a repaired engine as on a broken one. That mistake
 * was made once while designing this and is the reason for the comment.
 *
 * Read-only: opens no video, writes nothing, touches no job.
 */
import { prisma } from "@clipclap/shared";
import { comparableStream, segmentsToCues } from "../processors/subtitles";
import type { WhisperSegment } from "@clipclap/shared";

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      clips: { some: { deletedAt: null } },
      transcriptJson: { not: null },
    },
    select: {
      id: true,
      language: true,
      transcriptJson: true,
      clips: {
        where: { deletedAt: null },
        select: { startTime: true, endTime: true },
      },
    },
  });

  let occurrences = 0;
  let complete = 0;
  let incomplete = 0;
  const offenders: string[] = [];

  for (const job of jobs) {
    const segments = ((job.transcriptJson as { segments?: WhisperSegment[] })
      ?.segments ?? []) as WhisperSegment[];
    for (const clip of job.clips) {
      const cues = segmentsToCues(segments, clip.startTime, clip.endTime);
      for (const s of segments) {
        if (!(s.end > clip.startTime && s.start < clip.endTime)) continue;
        // Partially-overlapping segments are excluded: the window clips them by
        // design and that is not a loss.
        if (s.start < clip.startTime || s.end > clip.endTime) continue;
        if (!s.words || s.words.length === 0) continue;
        occurrences += 1;
        const segStart = s.start - clip.startTime;
        const segEnd = s.end - clip.startTime;
        const mine = cues.filter(
          (c) => c.start >= segStart - 1e-6 && c.end <= segEnd + 1e-6
        );
        const drawn = comparableStream(mine.map((c) => c.text).join(""));
        if (drawn === comparableStream(s.text)) complete += 1;
        else {
          incomplete += 1;
          if (offenders.length < 20) {
            offenders.push(`${job.id} ${JSON.stringify(s.text.trim())}`);
          }
        }
      }
    }
  }

  console.log(`segment occurrences measured  : ${occurrences}`);
  console.log(`cue text carries the sentence : ${complete}`);
  console.log(
    `cue text INCOMPLETE           : ${incomplete}  (${(
      (100 * incomplete) /
      occurrences
    ).toFixed(1)}%)`
  );
  if (offenders.length) {
    console.log("\nremaining:");
    offenders.forEach((o) => console.log("  " + o));
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-subtitle-coverage.ts'
```

Expected, and this is the acceptance criterion:

```
segment occurrences measured  : 1265
cue text carries the sentence : 1263
cue text INCOMPLETE           : 2  (0.2%)
```

Before this work the same script returned **135 incomplete (10.7%)**. The two survivors are the `unresolved` pair from the spec - a loss at both ends, which this repair deliberately does not guess at. **Any other number means something was changed that this work was not aimed at - stop and find out what.**

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/scripts/eval-subtitle-coverage.ts
git commit -m "test(subtitles): the acceptance metric, measured on cues rather than words

135 of 1265 incomplete before, 2 after - the unresolved pair the repair
deliberately does not guess at."
```

---

### Task 8: confirm it in pixels

The acceptance number proves the cue data. Only a rendered frame proves the picture.

**Files:** none - this task produces evidence, not code.

- [ ] **Step 1: Re-render the measured clip set**

```bash
docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-render-set.ts sitcom-friends cmscht6rp001xq41s5rhjx6q0 cmp1apxno0000eeug8to69vi0"
```

Note the new job id it prints.

- [ ] **Step 2: Check the cue data of the new job first**

The clip carrying `"We think Chandler might be having an affair."` is the one whose `startTime` is about 175.1. Replace `<NEW_JOB_ID>` with the id from Step 1:

```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c "
SELECT id, round(\"startTime\"::numeric,1) AS start,
       jsonb_path_query_array(\"subtitleTrack\"->'cues', '\$[*].text') AS cue_text
FROM clips WHERE \"jobId\"='<NEW_JOB_ID>' AND \"startTime\" BETWEEN 174 AND 177;"
```

Expected: the array contains `affair.` - as its own cue or attached to `an`. If it does not, the repair is not running on the render path and Task 5 is wrong; stop here.

- [ ] **Step 3: Confirm the same thing in pixels**

Take the clip id from Step 2 and pull the frame where that line is spoken:

```bash
CID=$(docker compose ps -q worker-render)
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && cat > /tmp/frame.ts <<"EOF"
import { execFile } from "child_process";
import { promisify } from "util";
import { prisma } from "@clipclap/shared";
import { downloadVideo } from "/app/apps/worker/src/processors/download";
const run = promisify(execFile);
async function main() {
  const clip = await prisma.clip.findUniqueOrThrow({
    where: { id: process.argv[2] }, select: { storageKey: true } });
  const path = await downloadVideo(undefined, clip.storageKey);
  await run("ffmpeg", ["-nostdin","-v","error","-ss",process.argv[3],"-i",path,
    "-frames:v","1","-vf","scale=-2:640","-q:v","2","/tmp/proof.jpg","-y"]);
  console.log("wrote /tmp/proof.jpg");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
EOF
npx tsx /tmp/frame.ts <CLIP_ID> 11.5'
docker cp $CID:/tmp/proof.jpg ./proof.jpg
```

Open `proof.jpg`. The caption must read `an affair.` where it previously read `an` alone. If the word is present in the cue data from Step 2 but absent from the frame, the defect is in the ASS burn rather than in this repair, and that is a separate investigation - say so rather than patching here.

Delete `proof.jpg` afterwards; it is evidence, not a repository artifact.

- [ ] **Step 4: Record the result**

Add a short section to `docs/engine-notes.md` under the subtitle material: the before and after numbers, the language split, and the two measurement traps from spec §3.1. Commit.

```bash
git add docs/engine-notes.md
git commit -m "docs(engine): the subtitle word restore, measured before and after"
```

---

## Definition of done

- [ ] `npx vitest run apps/worker` passes.
- [ ] `npx tsc --noEmit -p apps/worker/tsconfig.json` is clean.
- [ ] `eval-subtitle-coverage.ts` reports **2 incomplete of 1265**, down from 135.
- [ ] A rendered frame shows a word that was previously missing.
- [ ] `renderManifest.subtitles` is populated on the new job.
- [ ] `docs/engine-notes.md` carries the before/after numbers.
