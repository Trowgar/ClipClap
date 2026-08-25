import { describe, it, expect } from "vitest";
import {
  chunkWords,
  comparableText,
  dropCarriedPunctuation,
  generateAss,
  restoreDroppedWords,
  segmentsToCues,
  sliceCues,
  splitAtComparable,
  summariseRestores,
} from "../subtitles";
import type { SubtitleCue, SubtitleWord, WhisperSegment } from "@clipclap/shared";

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
    // seg2 has 4 words -> two cues of two, so 4 cues total
    expect(cues).toHaveLength(4);
    expect(cues[0]).toMatchObject({ start: 0, end: 3.5, text: "Hello everyone" });
    expect(cues[1].start).toBeCloseTo(3.5);
    expect(cues[1].end).toBeCloseTo(4.4); // held until the next chunk starts
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
    // Eight words is three cues at a three-word limit, and the split is even
    // rather than greedy: the old fill produced 3+3+2 and stranded nothing
    // here, but on four words it produced 3+1, which is the defect.
    expect(cues.map((c) => c.text)).toEqual([
      "one two",
      "three four five",
      "six seven eight",
    ]);
    expect(cues[0].start).toBe(0);
    // chunk stays on screen until the next one starts (no flicker gaps)
    expect(cues[0].end).toBe(cues[1].start);
    expect(cues.at(-1)!.end).toBe(6);
  });

  it("splits four words evenly instead of stranding the fourth", () => {
    // The defect this cost model exists to remove. Greedy filled to the
    // three-word limit and left "stream" alone on screen for as long as it
    // took to say - 936 of 4083 corpus cues held one word, 537 of them for
    // under half a second.
    const cues = segmentsToCues(segments, 10.0, 25.0);
    expect(cues[1].text).toBe("Welcome to");
    expect(cues[2].text).toBe("the stream");
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

describe("chunkWords", () => {
  /** Evenly spoken words, one per `step` seconds, so timing never decides the
   *  split and the other two terms can be tested in isolation. */
  const evenly = (texts: string[], step = 1): SubtitleWord[] =>
    texts.map((text, i) => ({ text, start: i * step, end: (i + 1) * step }));

  const say = (chunks: SubtitleWord[][]) =>
    chunks.map((c) => c.map((w) => w.text).join(" "));

  it("uses the fewest cues the limits allow, exactly as the greedy fill did", () => {
    // Six words at three per cue is two cues, and no cost term may add a third
    // - the number of times the text changes is the pace of the subtitles, and
    // this change is not allowed to alter it.
    const words = evenly(["a", "bb", "cc", "dd", "ee", "ff"]);
    expect(chunkWords(words, 0, 6)).toHaveLength(2);
  });

  it("never exceeds the character limit by grouping", () => {
    // Three words of eight characters each would be 26 with spaces, over the
    // 18-character budget, so they cannot share a cue however even that is.
    const words = evenly(["eighteen", "eighteen", "eighteen"]);
    for (const chunk of chunkWords(words, 0, 3)) {
      expect(chunk.map((w) => w.text).join(" ").length).toBeLessThanOrEqual(18);
    }
  });

  it("lets a single word exceed the character limit, having nothing to split", () => {
    const words = evenly(["antidisestablishmentarianism"]);
    expect(say(chunkWords(words, 0, 1))).toEqual([
      "antidisestablishmentarianism",
    ]);
  });

  it("splits evenly rather than filling to the limit", () => {
    // W_EVEN. Greedy gave "aa bb cc" then "dd"; the fourth word must not be
    // left alone when the same two cues can hold two words each.
    expect(say(chunkWords(evenly(["aa", "bb", "cc", "dd"]), 0, 4))).toEqual([
      "aa bb",
      "cc dd",
    ]);
  });

  // Both break tests below are built so that 2+3 - what this chunker produces
  // when nothing distinguishes the two splits - is the WRONG answer, and only
  // the break term can move it to 3+2. An earlier pair of these expected 2+3
  // and passed with W_BREAK set to zero, proving nothing at all.
  //
  // The words are also kept short enough that BOTH splits are under the
  // 18-character limit. The second attempt at these used "понятно. Идём
  // дальше", which is 20 characters, so 2+3 was illegal and 3+2 was the only
  // split on offer - the test passed while measuring the character limit
  // instead of the break term. Check both arrangements fit before trusting one
  // of these.

  it("moves the break off a one-or-two-letter word", () => {
    // W_BREAK, the penalty half. Both splits are equally far from an even
    // share and neither flashes, so the break term alone decides: ending a
    // line on "и" strands a conjunction from what it joins.
    const words = evenly(["Оно", "и", "так", "было", "ясно"]);
    expect(say(chunkWords(words, 0, 5))).toEqual(["Оно и так", "было ясно"]);
  });

  it("prefers a break where the sentence already ends", () => {
    // W_BREAK, the reward half, under the same conditions.
    //
    // Note what this does NOT do: it will not strand "понятно." alone in its
    // own cue to reach the punctuation, because a one-word cue costs more in
    // evenness than the reward is worth. The reward picks among balanced
    // splits; it does not buy an unbalanced one.
    const words = evenly(["Да", "всё", "ясно.", "Идём", "уже"]);
    expect(say(chunkWords(words, 0, 5))).toEqual(["Да всё ясно.", "Идём уже"]);
  });

  it("avoids leaving a cue on screen for less than half a second", () => {
    // W_FLASH, on the same 2+3 / 3+2 tie so nothing else can decide it. Five
    // words rattled off in 0.4s and then a long hold: breaking after the
    // second word puts the first cue on screen for 0.2s, breaking after the
    // third gives it 0.3s. Neither reaches half a second - the chunker cannot
    // slow down speech - but it takes the longer of the two.
    const words: SubtitleWord[] = [
      { text: "aaa", start: 0, end: 0.1 },
      { text: "bbb", start: 0.1, end: 0.2 },
      { text: "ccc", start: 0.2, end: 0.3 },
      { text: "ddd", start: 0.3, end: 0.4 },
      { text: "eee", start: 0.4, end: 3 },
    ];
    expect(say(chunkWords(words, 0, 3))).toEqual(["aaa bbb ccc", "ddd eee"]);
  });

  it("returns nothing for no words", () => {
    expect(chunkWords([], 0, 1)).toEqual([]);
  });

  it("is deterministic on a tie", () => {
    const words = evenly(["one", "two", "three", "four", "five", "six", "seven", "eight"]);
    const first = say(chunkWords(words, 0, 8));
    for (let i = 0; i < 5; i += 1) {
      expect(say(chunkWords(words, 0, 8))).toEqual(first);
    }
  });

  it("keeps every word, in order, exactly once", () => {
    const texts = ["Мы", "думали,", "что", "он", "уже", "всё", "понял", "и", "ушёл"];
    const flat = chunkWords(evenly(texts), 0, texts.length).flat();
    expect(flat.map((w) => w.text)).toEqual(texts);
  });
});

describe("chunkWords / segmentsToCues - CJK per-script params (spec 2026-08-25-cjk-subtitles)", () => {
  const evenly = (texts: string[], step = 1): SubtitleWord[] =>
    texts.map((text, i) => ({ text, start: i * step, end: (i + 1) * step }));

  // Whisper's real shape for Japanese: one character per "word" (verified on
  // a real transcriptJson: "今だ" -> ["今","だ"]). Twelve of them, evenly
  // spoken so timing never decides the split, same as the Latin fixtures
  // above. Under the 13-glyph CJK cap this whole segment fits ONE cue.
  const jaWords12 = evenly([
    "今", "だ", "そ", "れ", "は", "違", "う", "と", "思", "い", "ま", "す",
  ]);

  // Twenty single-char words - more than the 13-glyph CJK cap - so a split
  // is forced and the tests below can show what caps it (13 glyphs) and
  // what doesn't (the 3-word Latin cap).
  const jaWords20 = evenly([
    "今", "だ", "そ", "れ", "は", "違", "う", "と", "思", "い",
    "ま", "す", "消", "防", "隊", "火", "強", "す", "ぎ", "る",
  ]);

  it("a 12-word Japanese segment stays in ONE cue under the 13-glyph CJK cap", () => {
    // Under the Latin word cap this would be 4 cues (12 words / 3 per cue).
    // The measured CJK cap (13 glyphs, no separator - see the derivation in
    // subtitles.ts) is wide enough that all 12 single-character words fit
    // one cue without fragmenting.
    const chunks = chunkWords(jaWords12, 0, 12, "ja");
    expect(chunks.length).toBe(1);
  });

  it("a 20-word Japanese segment chunks by the 13-glyph CJK cap, not the 3-word Latin cap", () => {
    const chunks = chunkWords(jaWords20, 0, 20, "ja");
    // Under the Latin word cap every chunk would hold at most 3 words (7
    // cues for 20 words). The CJK cap is wide enough that at least one cue
    // holds more than 3 words - proof the 3-word ceiling is not what is
    // binding here.
    expect(chunks.some((c) => c.length > 3)).toBe(true);
    // And it is still bounded by something: no chunk exceeds the 13-glyph
    // cap (each word here is exactly one glyph and CJK words carry no
    // separator budget, so a chunk's word count IS its glyph count), and
    // covering 20 of them needs exactly ceil(20/13) = 2 cues.
    expect(chunks.every((c) => c.length <= 13)).toBe(true);
    expect(chunks.length).toBe(2);
  });

  it("segmentsToCues joins a CJK cue's words with no separator - Japanese does not write spaces between words", () => {
    const seg: WhisperSegment[] = [
      {
        start: 0,
        end: 20,
        text: jaWords20.map((w) => w.text).join(""),
        words: jaWords20,
      },
    ];
    const cues = segmentsToCues(seg, 0, 20, "ja");
    expect(cues.length).toBeGreaterThan(0);
    for (const c of cues) {
      expect(c.text).not.toMatch(/\s/);
    }
    // The concatenation of every cue's text reconstructs the segment exactly
    // - the join change drops or duplicates no character.
    expect(cues.map((c) => c.text).join("")).toBe(
      jaWords20.map((w) => w.text).join("")
    );
  });

  it("the same-shape 20-word segment in English still joins with a space and obeys the 3-word cap", () => {
    const enWords = evenly([
      "one", "two", "three", "four", "five", "six", "seven", "eight",
      "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
      "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
    ]);
    const chunks = chunkWords(enWords, 0, 20, "en");
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3);

    const seg: WhisperSegment[] = [
      {
        start: 0,
        end: 20,
        text: enWords.map((w) => w.text).join(" "),
        words: enWords,
      },
    ];
    const cues = segmentsToCues(seg, 0, 20, "en");
    for (const c of cues) expect(c.text).toMatch(/\s/);
  });

  it("a Devanagari segment still obeys the 3-word Latin cap and joins with a space", () => {
    // Real Hindi words (from the spec's second affected job, cmt7e24cl):
    // space-delimited and multi-character, unlike Japanese's single-char
    // "words" - so nothing about the CJK budget or the "" join applies here.
    const hiWords = evenly([
      "नमस्ते", "आप", "कैसे", "हैं", "आज", "मौसम",
      "बहुत", "अच्छा", "है", "चलिए", "चलते", "हैं",
    ]);
    const chunks = chunkWords(hiWords, 0, 12, "hi");
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3);
    expect(chunks.length).toBe(4);

    const seg: WhisperSegment[] = [
      {
        start: 0,
        end: 12,
        text: hiWords.map((w) => w.text).join(" "),
        words: hiWords,
      },
    ];
    const cues = segmentsToCues(seg, 0, 12, "hi");
    for (const c of cues) expect(c.text).toMatch(/\s/);
  });

  it("segmentsToCues threads the clip language through to the chunker", () => {
    const seg: WhisperSegment[] = [
      {
        start: 0,
        end: 20,
        text: jaWords20.map((w) => w.text).join(""),
        words: jaWords20,
      },
    ];
    // No language passed: must reproduce today's pre-CJK behaviour exactly
    // (an absent value keeps the Latin budget, same contract as
    // fontForLanguage's own default).
    const withoutLanguage = segmentsToCues(seg, 0, 20);
    const withJapanese = segmentsToCues(seg, 0, 20, "ja");
    expect(withoutLanguage.length).toBe(7); // 20 words / 3-word Latin cap
    expect(withJapanese.length).toBeLessThan(withoutLanguage.length);
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

  // karaokeText builds the Dialogue line directly from cue.words - it never
  // reads cue.text - so fixing the join in segmentsToCues alone would not
  // have touched the actual burn. This is the path almost every real cue
  // takes (chunkWords always hands segmentsToCues a `words` array), so this
  // is the test that would have caught that gap.
  it("emits karaoke word spans with NO separator for a CJK language - Japanese does not write spaces between words", () => {
    const jaCue: SubtitleCue = {
      id: "ja1",
      start: 0,
      end: 1,
      text: "だめか",
      words: [
        { text: "だ", start: 0, end: 0.2 },
        { text: "め", start: 0.2, end: 0.4 },
        { text: "か", start: 0.4, end: 0.6 },
      ],
    };
    const ass = generateAss([jaCue], "ja");
    const line = ass.split("\n").find((l) => l.startsWith("Dialogue:"))!;
    expect(line).toBeDefined();
    // Each word sits directly against the next {\k...} tag, no space between.
    expect(line).toContain("}だ{\\k");
    expect(line).toContain("}め{\\k");
    expect(line.endsWith("}か")).toBe(true);
    expect(line).not.toMatch(/[だめか] [だめか]/);
  });

  // The mirror of the test above: a non-CJK karaoke cue must keep the space
  // it has always had between \k word spans.
  it("still emits a separator between karaoke word spans for a non-CJK language", () => {
    const ruCue: SubtitleCue = {
      id: "ru1",
      start: 0,
      end: 1,
      text: "всё ясно",
      words: [
        { text: "всё", start: 0, end: 0.3 },
        { text: "ясно", start: 0.3, end: 0.6 },
      ],
    };
    const ass = generateAss([ruCue], "ru");
    const line = ass.split("\n").find((l) => l.startsWith("Dialogue:"))!;
    expect(line).toContain("всё {\\k");
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

  it("names the default face when no language is given", () => {
    expect(generateAss(cues)).toContain("Style: Default,Montserrat,");
  });

  it("names the default face for a non-Arabic language", () => {
    expect(generateAss(cues, "ru")).toContain("Style: Default,Montserrat,");
  });

  // The whole point of the change: an Arabic clip must not be drawn with a
  // face that has no Arabic glyphs.
  it("names the Arabic face for an Arabic-script language", () => {
    expect(generateAss(cues, "ar")).toContain("Style: Default,Tajawal,");
    expect(generateAss(cues, "fa")).toContain("Style: Default,Tajawal,");
  });

  // Byte-identity is the safety claim for every existing clip: the frozen
  // render baselines only stay valid if the style line does not move a
  // character when the language is not Arabic.
  it("produces a byte-identical file with no language and with a Latin one", () => {
    expect(generateAss(cues, "en")).toBe(generateAss(cues));
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

describe("dropCarriedPunctuation", () => {
  /** The shape this function had before it was made linear: compare every
   *  prefix (or suffix) of the run by cutting a fresh string for each. Kept
   *  here as the reference the rewrite must agree with everywhere, because the
   *  rewrite is meant to change the cost and nothing else. */
  function naive(
    run: string,
    neighbour: string,
    edge: "leading" | "trailing"
  ): string {
    const cps = [...run];
    for (let n = cps.length; n > 0; n -= 1) {
      if (edge === "leading") {
        if (neighbour.endsWith(cps.slice(0, n).join(""))) return cps.slice(n).join("");
      } else if (neighbour.startsWith(cps.slice(cps.length - n).join(""))) {
        return cps.slice(0, cps.length - n).join("");
      }
    }
    return run;
  }

  it("drops the longest prefix the neighbour already ends with", () => {
    expect(dropCarriedPunctuation("» каждый", "жизнь»", "leading")).toBe(" каждый");
    expect(dropCarriedPunctuation("»» x", "жизнь»»", "leading")).toBe(" x");
  });

  it("drops the longest suffix the neighbour already starts with", () => {
    expect(dropCarriedPunctuation("читал «", "«Наука", "trailing")).toBe("читал ");
  });

  it("keeps the run when the neighbour carries none of it", () => {
    expect(dropCarriedPunctuation(", ", "Nice", "leading")).toBe(", ");
    expect(dropCarriedPunctuation(" - ", "хорошо", "trailing")).toBe(" - ");
    expect(dropCarriedPunctuation("", "Nice", "leading")).toBe("");
    expect(dropCarriedPunctuation("...", "", "trailing")).toBe("...");
  });

  it("never half-matches a surrogate pair", () => {
    // The neighbour ends with the low half of "𝄞" only if the comparison is
    // made in UTF-16 units; in code points there is no overlap at all.
    //
    // This is the ONE input where the rewrite and the reference below disagree,
    // and it is why the random comparison draws whole code points only. The
    // prefix-by-prefix version compared with String.endsWith, i.e. in UTF-16
    // units, so it half-matched here and returned "!" - contradicting the
    // docstring's own code-point promise. The input is malformed (a lone
    // surrogate cannot occur in NFC text), so nothing real changes; the
    // promised behaviour is simply now true.
    expect(dropCarriedPunctuation("\uDD1E!", "x𝄞", "leading")).toBe("\uDD1E!");
    // Well-formed astral characters DO match, on both edges.
    expect(dropCarriedPunctuation("x\u{1D11E}", "\u{1D11E}y", "trailing")).toBe("x");
    expect(dropCarriedPunctuation("\u{1D11E}y", "x\u{1D11E}", "leading")).toBe("y");
  });

  it("agrees with the prefix-by-prefix reference on 4000 random runs", () => {
    // Deterministic PRNG: a flaky property test is worse than none. The
    // alphabet is small on purpose - overlaps have to actually happen for the
    // comparison to mean anything - and it includes an astral character so the
    // code-point contract is exercised, not just asserted.
    let seed = 20260805;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = [...".,-»«'!", "\u{1D11E}", "a", " "];
    const pick = (n: number) =>
      Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
    for (let i = 0; i < 4000; i += 1) {
      const run = pick(Math.floor(rand() * 8));
      const neighbour = pick(Math.floor(rand() * 8));
      const edge = rand() < 0.5 ? "leading" : "trailing";
      expect({ run, neighbour, edge, out: dropCarriedPunctuation(run, neighbour, edge) }).toEqual({
        run,
        neighbour,
        edge,
        out: naive(run, neighbour, edge),
      });
    }
  });

  it("stays fast on a run long enough to make the old shape unusable", () => {
    // Transcript text is model output over user-supplied audio, and Whisper's
    // known failure mode on silence and music is a long run of repeated
    // punctuation. The prefix-by-prefix version cost 5.6s on 32k characters
    // (4x per doubling, measured); this one is linear. The bound is loose by
    // two orders of magnitude so it can only fail on a return to quadratic.
    const run = "!".repeat(16000) + "?" + "!".repeat(16000);
    const neighbour = "!".repeat(32000);
    const started = Date.now();
    expect(dropCarriedPunctuation(run, neighbour, "leading")).toBe(
      "?" + "!".repeat(16000)
    );
    expect(Date.now() - started).toBeLessThan(500);
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
    // unconditional space join writes "во -первых." into the picture. Re-counted
    // 2026-08-05 over every transcript in the database: 4 of 743 tail drops and
    // 5 of 560 head drops have a seam with no whitespace in it. The comment
    // said 34 of 743, which was wrong by 8x. It is rare, and to a viewer a
    // space inside a word is worse than the missing word this repair exists to
    // put back.
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

  it("keeps a dash standing alone at the seam, and gives it to the span it opens", () => {
    // A spaced dash is ordinary typography in both languages and the seam run
    // is then " - ": nothing before its first space, nothing after its last,
    // and the dash between the two. Reconstructing the run from those two ends
    // deleted it and burned "Nice bro." - the same class of defect this whole
    // file exists to remove, and invisible to the acceptance metric because
    // comparableText strips exactly the character being lost.
    const out = restoreDroppedWords(
      "Nice - bro.",
      [{ text: "Nice", start: 42.24, end: 42.44 }],
      42.24,
      42.96
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(2);
    expect(out.words[0]).toEqual({ text: "Nice", start: 42.24, end: 42.44 });
    expect(out.words[1]).toEqual({ text: "- bro.", start: 42.44, end: 42.96 });
  });

  it("keeps a dash standing alone at the seam when the span merges", () => {
    // The merge branch lost it too, and there the whole seam run is rebuilt
    // verbatim, so the source text comes back character for character.
    const out = restoreDroppedWords(
      "Nice - bro.",
      [{ text: "Nice", start: 42.24, end: 42.96 }],
      42.24,
      42.96
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(1);
    expect(out.words[0]).toEqual({ text: "Nice - bro.", start: 42.24, end: 42.96 });
  });

  it("keeps an em dash at the seam, the Russian shape of the same run", () => {
    // The em dash below is SOURCE DATA, not prose: Russian writes a spaced em
    // dash where English writes "is", and it is the commonest way this seam run
    // occurs in the wild. It is also multi-byte, which is why it is worth a
    // case of its own next to the ASCII hyphen.
    const out = restoreDroppedWords(
      "Он читал — Наука",
      [
        { text: "Он", start: 0, end: 0.3 },
        { text: "читал", start: 0.3, end: 0.8 },
      ],
      0,
      1.5
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(3);
    expect(out.words[1]).toEqual({ text: "читал", start: 0.3, end: 0.8 });
    expect(out.words[2]).toEqual({ text: "— Наука", start: 0.8, end: 1.5 });
  });

  it("keeps a multi-character token standing alone at the seam", () => {
    // The interior of the run is copied, not classified: whatever stands
    // between the first space and the last is preserved as written.
    const out = restoreDroppedWords(
      "Hey -- you",
      [{ text: "Hey", start: 0, end: 0.3 }],
      0,
      1.0
    );
    expect(out.outcome).toBe("tail");
    expect(out.words).toHaveLength(2);
    expect(out.words[1]).toEqual({ text: "-- you", start: 0.3, end: 1.0 });
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

  it("keeps a dash standing alone at the seam, and gives it to the word it opens", () => {
    // The head mirror. The dash goes with the word to its right in both
    // branches, so the two entries drawn side by side rebuild "Там - хорошо"
    // exactly - the renderer joins entries with one space.
    const out = restoreDroppedWords(
      "Там - хорошо",
      [{ text: "хорошо", start: 5.4, end: 5.9 }],
      5.0,
      5.9
    );
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(2);
    expect(out.words[0]).toEqual({ text: "Там", start: 5.0, end: 5.4 });
    expect(out.words[1]).toEqual({ text: "- хорошо", start: 5.4, end: 5.9 });
  });

  it("keeps a dash standing alone at the seam when the head merges", () => {
    // No head room, so the span is glued on - and the run comes back verbatim
    // rather than as a single invented space.
    const out = restoreDroppedWords(
      "Там - хорошо",
      [{ text: "хорошо", start: 5.0, end: 5.9 }],
      5.0,
      5.9
    );
    expect(out.outcome).toBe("head");
    expect(out.words).toHaveLength(1);
    expect(out.words[0]).toEqual({ text: "Там - хорошо", start: 5.0, end: 5.9 });
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
      "Welcome to",
      "the stream",
      "Today we are going to talk about AI",
    ]);
    // Float noise: 14.4 - 10.0 is not exactly 4.4, so compare approximately -
    // the same reason the pre-existing tests in this file use toBeCloseTo.
    const bounds = [[0, 3.5], [3.5, 4.4], [4.4, 8], [8, 15]];
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
