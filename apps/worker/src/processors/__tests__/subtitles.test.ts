import { describe, it, expect } from "vitest";
import {
  comparableText,
  generateAss,
  restoreDroppedWords,
  segmentsToCues,
  sliceCues,
  splitAtComparable,
  summariseRestores,
} from "../subtitles";
import type { SubtitleCue, WhisperSegment } from "@clipclap/shared";

const segments: WhisperSegment[] = [
  { start: 10.0, end: 13.5, text: "Hello everyone" },
  {
    start: 13.5,
    end: 18.0,
    text: "Welcome to the stream",
    words: [
      { text: "Welcome", start: 13.5, end: 14.2 },
      { text: "to", start: 14.2, end: 14.4 },
      { text: "the", start: 14.4, end: 14.6 },
      { text: "stream", start: 14.6, end: 15.1 },
    ],
  },
  { start: 18.0, end: 25.0, text: "Today we are going to talk about AI" },
  { start: 50.0, end: 55.0, text: "This is outside the clip range" },
];

describe("segmentsToCues", () => {
  it("filters to the clip window and shifts times to clip-relative", () => {
    const cues = segmentsToCues(segments, 10.0, 25.0);
    // seg2 has 4 words -> two 3-word-max chunks, so 4 cues total
    expect(cues).toHaveLength(4);
    expect(cues[0]).toMatchObject({ start: 0, end: 3.5, text: "Hello everyone" });
    expect(cues[1].start).toBeCloseTo(3.5);
    expect(cues[1].end).toBeCloseTo(4.6); // held until the next chunk starts
    expect(cues[2].end).toBeCloseTo(8.0); // last chunk runs to segment end
  });

  it("shifts word timings along with the cue and assigns ids", () => {
    const cues = segmentsToCues(segments, 10.0, 25.0);
    expect(cues[1].words?.[0]?.text).toBe("Welcome");
    expect(cues[1].words?.[0]?.start).toBeCloseTo(3.5);
    expect(cues[1].words?.[0]?.end).toBeCloseTo(4.2);
    expect(new Set(cues.map((c) => c.id)).size).toBe(4);
  });

  it("chunks word-timed segments into short viral-style cues", () => {
    const long: WhisperSegment[] = [
      {
        start: 0,
        end: 6,
        text: "one two three four five six seven eight",
        words: [
          { text: "one", start: 0, end: 0.5 },
          { text: "two", start: 0.5, end: 1 },
          { text: "three", start: 1, end: 1.5 },
          { text: "four", start: 1.5, end: 2 },
          { text: "five", start: 2, end: 2.5 },
          { text: "six", start: 2.5, end: 3 },
          { text: "seven", start: 3, end: 3.5 },
          { text: "eight", start: 3.5, end: 6 },
        ],
      },
    ];
    const cues = segmentsToCues(long, 0, 6);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0].text).toBe("one two three");
    expect(cues[0].start).toBe(0);
    // chunk stays on screen until the next one starts (no flicker gaps)
    expect(cues[0].end).toBe(cues[1].start);
    expect(cues.at(-1)!.end).toBe(6);
    expect(cues[0].words).toHaveLength(3);
  });

  it("keeps segments without words as a single cue", () => {
    const cues = segmentsToCues(segments, 10.0, 25.0);
    expect(cues[0].text).toBe("Hello everyone");
  });

  it("clamps cues that straddle the clip edges", () => {
    const cues = segmentsToCues(segments, 12.0, 16.0);
    expect(cues[0].start).toBe(0);
    expect(cues.at(-1)!.end).toBeCloseTo(4.0);
  });
});

describe("sliceCues", () => {
  const cues: SubtitleCue[] = [
    { id: "a", start: 0, end: 3, text: "one" },
    {
      id: "b",
      start: 3,
      end: 6,
      text: "two words",
      words: [
        { text: "two", start: 3, end: 4 },
        { text: "words", start: 4, end: 5.5 },
      ],
    },
    { id: "c", start: 6, end: 9, text: "three" },
  ];

  it("re-windows clip-relative cues to a sub-range", () => {
    const out = sliceCues(cues, 2, 7);
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(out[0]).toMatchObject({ start: 0, end: 1 });
    expect(out[1]).toMatchObject({ start: 1, end: 4 });
    expect(out[1].words?.[1]).toEqual({ text: "words", start: 2, end: 3.5 });
    expect(out[2]).toMatchObject({ start: 4, end: 5 });
  });

  it("drops cues fully outside the range", () => {
    const out = sliceCues(cues, 3.2, 5.8);
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("generateAss", () => {
  const cues = segmentsToCues(segments, 10.0, 25.0);

  it("emits the single default style (Montserrat Bold, white on black outline)", () => {
    const ass = generateAss(cues);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    const style = ass.split("\n").find((l) => l.startsWith("Style: Default,"));
    expect(style).toBeDefined();
    const fields = style!.replace("Style: ", "").split(",");
    expect(fields[1]).toBe("Montserrat");
    expect(Number(fields[2])).toBeGreaterThanOrEqual(96); // CC-size on 1080x1920
    expect(fields[3]).toBe("&H00FFFFFF"); // white primary
    expect(fields[7]).toBe("-1"); // bold
    expect(fields[21]).toBe("160"); // marginV
  });

  it("renders cue times relative to the clip", () => {
    const ass = generateAss(cues);
    expect(ass).toContain("0:00:00.00,0:00:03.50");
    expect(ass).not.toContain("outside the clip range");
  });

  it("emits karaoke word timing when words are present", () => {
    const ass = generateAss(cues);
    const karaokeLine = ass
      .split("\n")
      .find((l) => l.startsWith("Dialogue:") && l.includes("Welcome"));
    expect(karaokeLine).toContain("\\k70}Welcome");
    expect(karaokeLine).toContain("{\\1c&H00FFFF&}"); // active-word highlight colour
  });

  it("falls back to plain text when a cue has no words", () => {
    const ass = generateAss(cues);
    const plain = ass
      .split("\n")
      .find((l) => l.startsWith("Dialogue:") && l.includes("Hello everyone"));
    expect(plain).not.toContain("\\k");
  });

  it("escapes newlines and strips brace characters", () => {
    const ass = generateAss([
      { id: "x", start: 0, end: 1, text: "line1\nline2 {evil}" },
    ]);
    expect(ass).toContain("line1\\Nline2 (evil)");
  });
});

describe("comparableText", () => {
  it("keeps letters and digits, drops everything else, folds case", () => {
    expect(comparableText("It was 5.30 in the morning,")).toBe("itwas530inthemorning");
    expect(comparableText("Bing?")).toBe("bing");
    expect(comparableText("Y-O-U-R means you're.")).toBe("yourmeansyoure");
  });

  it("is empty for empty and punctuation-only input", () => {
    expect(comparableText("")).toBe("");
    expect(comparableText("...!?")).toBe("");
  });

  it("does not erase Cyrillic", () => {
    expect(comparableText("Там хорошая компания подбирается.")).toBe(
      "тамхорошаякомпанияподбирается"
    );
  });

  it("normalises composed and decomposed forms to the same NFC letter", () => {
    // U+0439 as one code point, vs U+0438 + U+0306 combining breve. Literal
    // expectations, not f(x) === f(y): a tool that NFC-normalises this file
    // would turn that comparison into a tautology without anyone noticing.
    expect(comparableText("й")).toBe("й");
    expect(comparableText("й")).toBe("й");
  });

  it("does not fold compatibility forms - NFC, not NFKC", () => {
    // U+FB01 LATIN SMALL LIGATURE FI. NFKC would decompose it to "fi" and make
    // these compare equal; NFC leaves it alone. Two visibly different strings
    // must not be treated as the same text (spec 3.1).
    expect(comparableText("ﬁ")).toBe("ﬁ");
    expect(comparableText("ﬁ")).not.toBe(comparableText("fi"));
  });

  it("agrees when Whisper splits a number into two tokens", () => {
    expect(comparableText("5.30")).toBe("530");
    expect(comparableText(["5", "30"].join(""))).toBe("530");
  });
});

describe("splitAtComparable", () => {
  it("splits right after the Nth comparable character", () => {
    expect(splitAtComparable("We think an affair.", 9)).toEqual([
      "We think an",
      " affair.",
    ]);
  });

  it("returns the whole string as the head when N covers everything", () => {
    expect(splitAtComparable("Там", 3)).toEqual(["Там", ""]);
  });

  it("returns the whole string as the head when N overshoots", () => {
    expect(splitAtComparable("abc.", 99)).toEqual(["abc.", ""]);
  });

  it("returns an empty head for N of 0", () => {
    expect(splitAtComparable("Там", 0)).toEqual(["", "Там"]);
  });

  it("handles an empty string", () => {
    expect(splitAtComparable("", 3)).toEqual(["", ""]);
  });

  it("puts an all-punctuation string in the head, the mirror of the N-of-0 branch", () => {
    expect(splitAtComparable("...!?", 1)).toEqual(["...!?", ""]);
  });

  it("splits the NFC form, so a decomposed letter is not cut in two", () => {
    // U+0438 + U+0306 composes to U+0439. Splitting the raw string put the
    // bare "и" in the head and left the combining breve opening the tail.
    expect(splitAtComparable("й хорошо", 1)).toEqual([
      "й",
      " хорошо",
    ]);
  });

  it("keeps a combining mark with its base letter even in NFC", () => {
    // Devanagari vowel signs are Mc and never compose, so NFC alone does not
    // save this: "कि" is क (Lo) + ि (Mc). Splitting between them orphans the
    // vowel sign into the tail, where it renders as a dotted circle.
    expect(splitAtComparable("कितना समय", 1)).toEqual(["कि", "तना समय"]);
  });

  it("never cuts a surrogate pair in half", () => {
    // U+20BB7 and U+20BB8 are astral CJK: two UTF-16 units each, one code
    // point each. This is the claim the doc comment makes.
    expect(splitAtComparable("\u{20BB7}\u{20BB8} tail", 1)).toEqual([
      "\u{20BB7}",
      "\u{20BB8} tail",
    ]);
  });

  it("keeps an astral combining mark with its base letter", () => {
    // U+1D167 MUSICAL SYMBOL COMBINING TREMOLO-1, category Mn, two UTF-16
    // units. Indexing the mark by code unit would see a lone high surrogate,
    // which \p{M} does not match, and orphan it into the tail.
    expect(splitAtComparable("a\u{1D167}bc", 1)).toEqual(["a\u{1D167}", "bc"]);
  });

  it("head + tail reconstructs the NFC input, and the head carries exactly N", () => {
    const cases = [
      "a\u{1D167}bc",
      "We think an affair.",
      "Там хорошая компания подбирается.",
      "й хорошо",
      "कितना समय",
      "\u{20BB7}\u{20BB8} tail",
      "It was 5.30 in the morning,",
      "...!?",
      "",
    ];
    for (const text of cases) {
      const total = [...comparableText(text)].length;
      for (let keep = 0; keep <= total + 2; keep++) {
        const [head, tail] = splitAtComparable(text, keep);
        expect(head + tail).toBe(text.normalize("NFC"));
        expect([...comparableText(head)].length).toBe(Math.min(keep, total));
      }
    }
  });
});

describe("restoreDroppedWords - tail", () => {
  it("restores the last word Whisper never timed", () => {
    // Text verbatim from job cmscht6rp001xq41s5rhjx6q0, where "affair" is absent
    // from words[]. Timings ADJUSTED to reach this branch: the real segment ends
    // on its last timed word, so in production it merges.
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

  it("counts comparable characters in code points, not UTF-16 units", () => {
    // "𠮷" is one letter and two code units. Counting units ran the split one
    // character too far and restored "ord" instead of "word".
    const out = restoreDroppedWords("𠮷 word", [{ text: "𠮷", start: 0, end: 1 }], 0, 2);
    expect(out.outcome).toBe("tail");
    expect(out.words[1].text).toBe("word");
  });

  it("gives the restored text its own entry when the gap is exactly the floor", () => {
    // 0.13 - 0.05 is bit-identical to MIN_RESTORED_SEC, so this pins the
    // boundary as inclusive. Reachable only in the first tenth of a second of
    // a source - every two-decimal pair that hits it exactly has the last word
    // ending below 0.117 - but the boundary itself is a decision, not trivia.
    const out = restoreDroppedWords("a bc", [{ text: "a", start: 0, end: 0.05 }], 0, 0.13);
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(2);
    expect(out.words[1]).toEqual({ text: "bc", start: 0.05, end: 0.13 });
  });

  it("merges into the last word when the gap is too short to be a duration", () => {
    const words = [
      { text: "It", start: 0, end: 0.2 },
      { text: "was", start: 0.2, end: 0.4 },
      { text: "5", start: 0.4, end: 0.6 },
      { text: "30", start: 0.6, end: 0.9 },
      { text: "in", start: 0.9, end: 1.0 },
      { text: "the", start: 1.0, end: 1.2 },
    ];
    // 0.05s of room left: too short to hand "morning," a duration of its own,
    // so it rides along on the word before it rather than getting a made-up one.
    const out = restoreDroppedWords("It was 5.30 in the morning,", words, 0, 1.25);
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(6);
    expect(out.words[5]).toEqual({ text: "the morning,", start: 1.0, end: 1.2 });
  });

  it("merges when the last word ends exactly on the segment boundary", () => {
    // 698 of 743 measured drops look like this - Whisper's last timed word
    // ends on the boundary, leaving no room at all. This is the common path,
    // not the exception the constant's name suggests.
    const out = restoreDroppedWords(
      "We think Chandler might be having an affair.",
      [
        { text: "We", start: 10.0, end: 10.2 },
        { text: "think", start: 10.2, end: 10.5 },
        { text: "Chandler", start: 10.5, end: 10.9 },
        { text: "might", start: 10.9, end: 11.1 },
        { text: "be", start: 11.1, end: 11.3 },
        { text: "having", start: 11.3, end: 11.7 },
        { text: "an", start: 11.7, end: 12.6 },
      ],
      10.0,
      12.6
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(7);
    expect(out.words[6]).toEqual({ text: "an affair.", start: 11.7, end: 12.6 });
  });

  it("never invents a negative duration when a word outruns the segment end", () => {
    // transcribe.ts assigns words to segments by time overlap, so a word
    // straddling a boundary lands in both and can end after its own segment.
    // 157 such segments exist in the corpus. The negative gap falls into the
    // merge, which reuses the word's own timings and cannot go backwards.
    const out = restoreDroppedWords(
      "We think an affair.",
      [
        { text: "We", start: 10.0, end: 10.2 },
        { text: "think", start: 10.2, end: 10.5 },
        { text: "an", start: 10.5, end: 12.9 },
      ],
      10.0,
      12.6
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(3);
    expect(out.words[2]).toEqual({ text: "an affair.", start: 10.5, end: 12.9 });
    for (const w of out.words) expect(w.end).toBeGreaterThanOrEqual(w.start);
  });

  it("rejoins a hyphenated word with no space at the seam", () => {
    // Whisper tokenises "во-первых" as "во" plus an untimed "-первых.", so an
    // unconditional space join writes "во -первых." into the picture. 34 of 743
    // measured tail drops look like this, and to a viewer a space inside a word
    // is worse than the missing word this repair exists to put back.
    const out = restoreDroppedWords(
      "Это во-первых.",
      [
        { text: "Это", start: 0, end: 0.3 },
        { text: "во", start: 0.3, end: 0.6 },
      ],
      0,
      0.6
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(2);
    expect(out.words[1]).toEqual({ text: "во-первых.", start: 0.3, end: 0.6 });
  });

  it("gives the seam punctuation to the word it was written on and times the rest", () => {
    // Verbatim from job cmsd6vaop002gq41s3wobd2w3, timings included and rounded
    // to two decimals: "bro." has
    // 0.52s of its own. A comma at the seam is a word boundary, not a
    // continuation - "bro." is a separate word and gets a separate entry, while
    // the comma stays on "Nice" where it was written. 45 measured restores have
    // this shape, and folding them into the previous entry buried up to 1.16s
    // of speech in a neighbour's timing.
    const out = restoreDroppedWords(
      "Nice, bro.",
      [{ text: "Nice", start: 42.24, end: 42.44 }],
      42.24,
      42.96
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(2);
    expect(out.words[0]).toEqual({ text: "Nice,", start: 42.24, end: 42.44 });
    expect(out.words[1]).toEqual({ text: "bro.", start: 42.44, end: 42.96 });
  });

  it("still merges a seam-punctuated span when there is no room to time it", () => {
    // Same shape with the segment ending on the last timed word: the split is
    // not available, so the whole span rides along and must rebuild the source
    // text exactly - comma, space and all.
    const out = restoreDroppedWords(
      "Nice, bro.",
      [{ text: "Nice", start: 42.24, end: 42.96 }],
      42.24,
      42.96
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(1);
    expect(out.words[0]).toEqual({ text: "Nice, bro.", start: 42.24, end: 42.96 });
  });

  it("does not draw punctuation the timed word already carries", () => {
    // Whisper attaches punctuation to word tokens - 2023 of 75378 in the corpus
    // - and the span rules anchor on comparable characters, so they cannot see
    // it. Without this the closing guillemet is drawn twice: "жизнь»»".
    const out = restoreDroppedWords(
      "«Это наша жизнь» каждый месяц.",
      [
        { text: "«Это", start: 0, end: 0.3 },
        { text: "наша", start: 0.3, end: 0.6 },
        { text: "жизнь»", start: 0.6, end: 1.0 },
      ],
      0,
      2.0
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(4);
    expect(out.words[2]).toEqual({ text: "жизнь»", start: 0.6, end: 1.0 });
    expect(out.words[3]).toEqual({ text: "каждый месяц.", start: 1.0, end: 2.0 });
  });

  it("merges a span that continues the adjacent word, however much room there is", () => {
    // "во-первых" is one word Whisper tokenised in two. A separate entry would
    // put a space inside the word and give half of it its own karaoke
    // highlight, so the gap is not the right question to ask here.
    const out = restoreDroppedWords(
      "Это во-первых.",
      [
        { text: "Это", start: 0, end: 0.4 },
        { text: "во", start: 0.4, end: 0.7 },
      ],
      0,
      2.0
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(2);
    expect(out.words[1]).toEqual({ text: "во-первых.", start: 0.4, end: 0.7 });
  });

  it("rejoins an apostrophised word with no space at the seam", () => {
    // The English shape of the same defect: "y" is timed, "'all." is not.
    const out = restoreDroppedWords(
      "Alright, see y'all.",
      [
        { text: "Alright", start: 0, end: 0.4 },
        { text: "see", start: 0.4, end: 0.6 },
        { text: "y", start: 0.6, end: 0.7 },
      ],
      0,
      0.7
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(3);
    expect(out.words[2]).toEqual({ text: "y'all.", start: 0.6, end: 0.7 });
  });

  it("keeps a multi-word span as ONE timing entry", () => {
    // The worst measured span holds nine lexical words and 36 characters. The
    // docstring calls the span indivisible on purpose - splitting it would need
    // a per-word timestamp nothing here can produce honestly - and this is the
    // invariant a future contributor is most likely to "fix", so it is pinned.
    const out = restoreDroppedWords(
      "Honestly I'm not sure I'm going to be able to",
      [{ text: "Honestly", start: 0, end: 0.5 }],
      0,
      3.0
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(2);
    expect(out.words[1]).toEqual({
      text: "I'm not sure I'm going to be able to",
      start: 0.5,
      end: 3.0,
    });
    expect(out.words[1].text).toHaveLength(36);
  });

  it("takes the tail branch when words[] carries no comparable character", () => {
    // A words[] of pure punctuation flattens to "", and "" is both a prefix and
    // a suffix of the text, so both branches are eligible. The tail branch wins
    // because it is written first, and this pins that precedence rather than
    // leaving it to the order of two if-statements. 136 punctuation-only word
    // entries exist in the corpus; no segment where every entry is one does.
    //
    // It merges rather than taking its own entry, and that follows from the
    // seam rule rather than from the gap: with no timed comparable character
    // there is nothing for the span to be separated FROM, so the seam reads as
    // carrying no whitespace and the span is glued on. The whole text is drawn
    // either way - which is what the repair is for - but it inherits the
    // punctuation entry's timing instead of running to segEnd. Left as the
    // rule produces it: nothing in the corpus reaches this, and a special case
    // here could not be checked against anything real.
    const out = restoreDroppedWords(
      "Hello there.",
      [{ text: "-", start: 0, end: 0.5 }],
      0,
      2.0
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(1);
    expect(out.words[0]).toEqual({ text: "-Hello there.", start: 0, end: 0.5 });
  });

  it("changes nothing when the mismatch is at neither end", () => {
    // Whisper timed a word the text does not contain, so the drift is interior:
    // no prefix and no suffix agrees, and there is no honest place to put it.
    const words = [
      { text: "We", start: 10.0, end: 10.2 },
      { text: "think", start: 10.2, end: 10.5 },
      { text: "xyz", start: 10.5, end: 10.9 },
      { text: "affair.", start: 10.9, end: 11.4 },
    ];
    const out = restoreDroppedWords("We think an affair.", words, 10.0, 11.4);
    expect(out.outcome).toBe("unresolved");
    expect(out.words).toEqual(words);
  });
});

describe("restoreDroppedWords - head", () => {
  it("restores the first word, the Russian shape of the defect", () => {
    // Text verbatim from job cms2c8ahm000droa7tcqh30ho. Timings ADJUSTED to reach
    // this branch: the real segment has a head gap of 0.000 and merges in
    // production.
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

  it("merges into the first word when there is no gap, the common head shape", () => {
    // Verbatim from job cms7jhcbz0003nb7fkfdki0lp, timings included, rounded to
    // two decimals. 500 of 560 measured head drops have a gap of exactly 0.000,
    // so this - not the branch above - is what nearly all real traffic takes.
    const words = [
      { text: "сексом", start: 34.74, end: 35.14 },
      { text: "и", start: 35.14, end: 35.36 },
      { text: "заботиться", start: 35.36, end: 35.66 },
      { text: "о", start: 35.66, end: 35.9 },
      { text: "младенчиках", start: 35.9, end: 36.46 },
    ];
    const out = restoreDroppedWords(
      "Заниматься сексом и заботиться о младенчиках.",
      words,
      34.74,
      36.46
    );
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(5);
    expect(out.words[0]).toEqual({
      text: "Заниматься сексом",
      start: 34.74,
      end: 35.14,
    });
  });

  it("merges a gap that is real but under the floor", () => {
    // Verbatim from job cms2c8ahm000droa7tcqh30ho, timings included, rounded to
    // two decimals. 0.06s of head room: too
    // little to be a duration, and unlike the tail side this band is populated
    // - 14 measured head drops sit strictly between 0 and the floor, so the
    // floor decides real segments here rather than being decorative.
    const words = [
      { text: "для", start: 967.28, end: 967.4 },
      { text: "человека", start: 967.4, end: 967.8 },
      { text: "это", start: 967.8, end: 968.02 },
      { text: "проблема", start: 968.02, end: 968.48 },
    ];
    const out = restoreDroppedWords(
      "Естественно, для человека это проблема.",
      words,
      967.22,
      968.48
    );
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(4);
    // The comma at the seam IS kept: the head span reaches to the timed words
    // rather than stopping after the last missing letter, so the punctuation
    // between the two halves stays on the side it was written on. 68 of 560
    // measured head drops lose one without this. The space is kept too,
    // because this seam really did carry one.
    expect(out.words[0]).toEqual({
      text: "Естественно, для",
      start: 967.28,
      end: 967.4,
    });
  });

  it("keeps the seam punctuation on a head that gets its own timing entry", () => {
    // The same measured segment, timings ADJUSTED to give the span room of its
    // own: the comma belongs to the head in both branches, not only the merge.
    const words = [
      { text: "для", start: 967.5, end: 967.7 },
      { text: "человека", start: 967.7, end: 968.1 },
      { text: "это", start: 968.1, end: 968.3 },
      { text: "проблема", start: 968.3, end: 968.48 },
    ];
    const out = restoreDroppedWords(
      "Естественно, для человека это проблема.",
      words,
      967.22,
      968.48
    );
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(5);
    expect(out.words[0]).toEqual({
      text: "Естественно,",
      start: 967.22,
      end: 967.5,
    });
  });

  it("does not draw punctuation the timed word already carries", () => {
    // The head mirror: the opening guillemet is part of the "«Наука" token, so
    // the head span must not bring its own copy - "Он читал ««Наука".
    const words = [
      { text: "«Наука", start: 1.0, end: 1.5 },
      { text: "и", start: 1.5, end: 1.6 },
      { text: "жизнь».", start: 1.6, end: 2.2 },
    ];
    const out = restoreDroppedWords("Он читал «Наука и жизнь».", words, 0, 2.2);
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(4);
    expect(out.words[0]).toEqual({ text: "Он читал", start: 0, end: 1.0 });
    expect(out.words[1]).toEqual({ text: "«Наука", start: 1.0, end: 1.5 });
  });

  it("gives an opening mark to the word it opens, not to the span before it", () => {
    // Same text, but Whisper left the guillemet out of the token. It sits at
    // the seam, and the source says which side it belongs to: the whitespace is
    // before it, so it opens "Наука" rather than closing "читал".
    const words = [
      { text: "Наука", start: 1.0, end: 1.5 },
      { text: "и", start: 1.5, end: 1.6 },
      { text: "жизнь».", start: 1.6, end: 2.2 },
    ];
    const out = restoreDroppedWords("Он читал «Наука и жизнь».", words, 0, 2.2);
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(4);
    expect(out.words[0]).toEqual({ text: "Он читал", start: 0, end: 1.0 });
    expect(out.words[1]).toEqual({ text: "«Наука", start: 1.0, end: 1.5 });
  });

  it("merges a head that continues the adjacent word, however much room there is", () => {
    // The head mirror: 0.5s of head room, and the span is still glued on,
    // because "Во-" is not a word that can hold a timing of its own.
    const words = [
      { text: "первых", start: 12.5, end: 12.9 },
      { text: "это", start: 12.9, end: 13.1 },
    ];
    const out = restoreDroppedWords("Во-первых, это.", words, 12.0, 13.1);
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(2);
    expect(out.words[0]).toEqual({ text: "Во-первых", start: 12.5, end: 12.9 });
  });

  it("rejoins a hyphenated head with no space at the seam", () => {
    // The head mirror of the tail's "во-первых": the hyphen sits at the seam,
    // so an unconditional space would split the word in the picture.
    const words = [
      { text: "первых", start: 12.0, end: 12.4 },
      { text: "это", start: 12.4, end: 12.6 },
      { text: "работает", start: 12.6, end: 13.1 },
    ];
    const out = restoreDroppedWords("Во-первых, это работает.", words, 12.0, 13.1);
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(3);
    expect(out.words[0]).toEqual({ text: "Во-первых", start: 12.0, end: 12.4 });
  });

  it("strips leading whitespace off the restored head", () => {
    // The head split never leaves TRAILING space - it ends on a letter - so the
    // only thing trim() can remove here is a leading space on the segment text.
    // That is 0 of 560 in the current corpus, but it is exactly the shape
    // Whisper's verbose_json emits, and without this the trim is untested: the
    // mutation that deletes it survived the rest of the suite.
    const out = restoreDroppedWords(
      " Там хорошая компания.",
      [
        { text: "хорошая", start: 5.4, end: 5.9 },
        { text: "компания", start: 5.9, end: 6.4 },
      ],
      5.0,
      6.4
    );
    expect(out.outcome).toBe("head");
    expect(out.words[0]).toEqual({ text: "Там", start: 5.0, end: 5.4 });
  });

  it("reports unresolved when both ends are missing and changes nothing", () => {
    const words = [{ text: "middle", start: 1.0, end: 1.5 }];
    const out = restoreDroppedWords("start middle end", words, 0.5, 2.0);
    expect(out.outcome).toBe("unresolved");
    expect(out.words).toEqual(words);
  });
});

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
    const drawn = comparableText(cues.map((c) => c.text).join(""));
    expect(drawn).toBe(comparableText(dropped[0].text));
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
    const bounds = [[0, 3.5], [3.5, 4.6], [4.6, 8], [8, 15]];
    cues.forEach((c, i) => {
      expect(c.start).toBeCloseTo(bounds[i][0]);
      expect(c.end).toBeCloseTo(bounds[i][1]);
    });
  });

  // The next two pin the ARGUMENT, not the call site: the restore is handed the
  // segment's own bounds. Every test above uses a window whose edges coincide
  // with the segment's, where clip bounds and segment bounds are the same
  // numbers and the mutation that swaps them survives untouched. Here the clip
  // is far longer than the segment, so the two disagree, and the restored span
  // - the only entry whose timing is invented rather than measured - is given
  // the clip's edge instead of the sentence's.
  it("times a restored tail against the segment end, not the clip end", () => {
    const cues = segmentsToCues(dropped, 10.0, 30.0);
    const last = cues[cues.length - 1].words!.slice(-1)[0];
    expect(last.text).toBe("affair.");
    // 12.6 - 10.0. With the clip end it would be 20, and the karaoke fill would
    // creep across the word for another 17 seconds of silence.
    expect(last.end).toBeCloseTo(2.6);
  });

  it("times a restored head against the segment start, not the clip start", () => {
    const headDropped: WhisperSegment[] = [
      {
        start: 20.0,
        end: 22.0,
        text: "Honestly, that was the whole joke.",
        words: [
          { text: "that", start: 20.5, end: 20.8 },
          { text: "was", start: 20.8, end: 21.0 },
          { text: "the", start: 21.0, end: 21.2 },
          { text: "whole", start: 21.2, end: 21.6 },
          { text: "joke.", start: 21.6, end: 22.0 },
        ],
      },
    ];
    const cues = segmentsToCues(headDropped, 10.0, 30.0);
    const first = cues[0].words![0];
    expect(first.text).toBe("Honestly,");
    // 20.0 - 10.0. With the clip start it would be 0, and the word would be
    // highlighted from the first frame of a clip it is not spoken in until
    // ten seconds later.
    expect(first.start).toBeCloseTo(10.0);
  });
});

describe("summariseRestores", () => {
  it("counts occurrences and outcomes over a clip window", () => {
    const segs: WhisperSegment[] = [
      { start: 0, end: 2, text: "one two", words: [{ text: "one", start: 0, end: 0.5 }] },
      { start: 2, end: 4, text: "три четыре", words: [{ text: "четыре", start: 3, end: 3.5 }] },
      { start: 4, end: 6, text: "all here", words: [
        { text: "all", start: 4, end: 4.5 },
        { text: "here", start: 4.5, end: 5 },
      ] },
    ];
    expect(summariseRestores(segs, 0, 6)).toEqual({
      segmentOccurrences: 3,
      restoredHead: 1,
      restoredTail: 1,
      unresolved: 0,
      merged: 0,
    });
  });

  it("skips segments with no word timings, so they are not counted as intact", () => {
    const segs: WhisperSegment[] = [
      { start: 0, end: 2, text: "no timings at all" },
      { start: 2, end: 4, text: "empty timings", words: [] },
      { start: 4, end: 6, text: "all here", words: [
        { text: "all", start: 4, end: 4.5 },
        { text: "here", start: 4.5, end: 5 },
      ] },
    ];
    expect(summariseRestores(segs, 0, 6)).toEqual({
      segmentOccurrences: 1,
      restoredHead: 0,
      restoredTail: 0,
      unresolved: 0,
      merged: 0,
    });
  });

  it("counts only segments overlapping the window, on the same rule as segmentsToCues", () => {
    const segs: WhisperSegment[] = [
      // Ends exactly at the clip start: excluded, as `s.end > clipStart`.
      { start: 8, end: 10, text: "before it", words: [{ text: "before", start: 8, end: 9 }] },
      // Straddles the start: counted whole, restore reads the segment not the window.
      { start: 9.5, end: 11, text: "straddle it", words: [{ text: "straddle", start: 9.5, end: 10.5 }] },
      { start: 12, end: 14, text: "inside it", words: [{ text: "inside", start: 12, end: 13 }] },
      // Starts exactly at the clip end: excluded, as `s.start < clipEnd`.
      { start: 20, end: 22, text: "after it", words: [{ text: "after", start: 20, end: 21 }] },
    ];
    expect(summariseRestores(segs, 10, 20)).toEqual({
      segmentOccurrences: 2,
      restoredHead: 0,
      restoredTail: 2,
      unresolved: 0,
      merged: 0,
    });
  });

  it("counts a merge separately from a restore with its own timing entry", () => {
    // The tail gap is 0.03s, under MIN_RESTORED_SEC, so "bc" is glued onto "a".
    // Read against the CLIP end (20) instead of the segment end it would clear
    // the floor easily and take an entry of its own.
    const segs: WhisperSegment[] = [
      { start: 10, end: 10.53, text: "a bc", words: [{ text: "a", start: 10, end: 10.5 }] },
    ];
    expect(summariseRestores(segs, 10, 20)).toEqual({
      segmentOccurrences: 1,
      restoredHead: 0,
      restoredTail: 1,
      unresolved: 0,
      merged: 1,
    });
  });

  it("counts a merged head against the segment start, not the clip start", () => {
    // 0.04s of head room: merged. Against the clip start (10) the gap would
    // read as 2.5s and the head would take its own entry.
    const segs: WhisperSegment[] = [
      { start: 12.46, end: 14, text: "Там хорошо", words: [{ text: "хорошо", start: 12.5, end: 13 }] },
    ];
    expect(summariseRestores(segs, 10, 20)).toEqual({
      segmentOccurrences: 1,
      restoredHead: 1,
      restoredTail: 0,
      unresolved: 0,
      merged: 1,
    });
  });

  it("counts text missing at both ends as unresolved, never as a restore", () => {
    const segs: WhisperSegment[] = [
      { start: 0, end: 3, text: "lost middle lost", words: [{ text: "middle", start: 1, end: 2 }] },
    ];
    expect(summariseRestores(segs, 0, 6)).toEqual({
      segmentOccurrences: 1,
      restoredHead: 0,
      restoredTail: 0,
      unresolved: 1,
      merged: 0,
    });
  });
});
