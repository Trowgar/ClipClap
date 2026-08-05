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

  it("merges into the first word when there is no gap, the common head shape", () => {
    // Verbatim from job cms2c8ahm000droa7tcqh30ho. 500 of 560 measured head
    // drops have a gap of exactly 0.000, so this - not the branch above - is
    // what nearly all real traffic takes.
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
    // Verbatim from job cms2c8ahm000droa7tcqh30ho. 0.06s of head room: too
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
    // The same measured segment with room to time the restored span: the comma
    // belongs to the head in both branches, not only in the merge.
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
