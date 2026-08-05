import { describe, it, expect } from "vitest";
import {
  comparableText,
  generateAss,
  restoreDroppedWords,
  segmentsToCues,
  sliceCues,
  splitAtComparable,
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
