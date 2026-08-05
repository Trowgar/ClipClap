import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { SubtitleCue, SubtitleWord, WhisperSegment } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

// One burned-in style for everyone. White Montserrat Bold with a black
// outline, bottom-centered on a 1080x1920 canvas; the active word flips to
// yellow via ASS karaoke when word timings exist.
// Font size is in PlayRes pixels: 100 on a 1920-tall canvas ≈ CapCut/CC-size text.
const DEFAULT_STYLE = {
  fontName: "Montserrat",
  fontSize: 100,
  primaryColor: "&H00FFFFFF", // white (AABBGGRR)
  karaokeFillColor: "&H00FFFF&", // yellow (BBGGRR inline override)
  outlineColor: "&H00000000",
  backColor: "&H80000000",
  outline: 5,
  shadow: 0,
  marginV: 160,
} as const;

// Viral-style chunking: at most this many words / characters per burned cue,
// so subtitles stay short and fit a 1080-wide vertical frame.
const MAX_CHUNK_WORDS = 3;
const MAX_CHUNK_CHARS = 18;

// assets/ ships beside src/ in dev (tsx) and beside dist/ in the production
// image, so __dirname/../.. lands on apps/worker in both.
export function resolveFontsDir(): string {
  return (
    process.env.SUBTITLE_FONTS_DIR || join(__dirname, "..", "..", "assets", "fonts")
  );
}

// Comparison form ONLY. Never rendered, never stored, never shown to a user -
// what reaches the viewer is always an exact substring of the NFC form of the
// segment's own text. NFC and not NFKC: NFKC folds compatibility forms, which
// would let two visibly different strings compare equal, the opposite of what
// this is for.
// \p{L}\p{N} and not [a-z0-9]: the latter reduces every Russian segment to the
// empty string and would report a total loss on the whole language.
export function comparableText(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const COMPARABLE_CHAR = /[\p{L}\p{N}]/u;
const COMBINING_MARK = /\p{M}/u;

/** Splits `text` immediately after its `keepComparable`-th comparable
 *  character, so the head carries exactly that many of them and the tail
 *  carries the rest with its original punctuation and spacing intact.
 *  Iterates code points, not code units, so a surrogate pair is never cut in
 *  half. */
export function splitAtComparable(
  text: string,
  keepComparable: number
): [string, string] {
  // Slice from the NFC form, the same form comparableText counts, so a caller
  // can spend a count produced there. Canonically equivalent, so the viewer
  // sees identical glyphs.
  const src = text.normalize("NFC");
  if (keepComparable <= 0) return ["", src];
  let seen = 0;
  let idx = 0;
  for (const ch of src) {
    idx += ch.length;
    if (COMPARABLE_CHAR.test(ch)) {
      seen += 1;
      if (seen === keepComparable) {
        // A combining mark belongs to the letter before it. Splitting between
        // them orphans the mark into the tail and strips it from the head, so
        // the last drawn word loses its diacritic. Code points here too, to
        // match the loop above: src[idx] would be a lone surrogate for an
        // astral mark, which \p{M} does not match.
        while (idx < src.length) {
          const next = String.fromCodePoint(src.codePointAt(idx)!);
          if (!COMBINING_MARK.test(next)) break;
          idx += next.length;
        }
        return [src.slice(0, idx), src.slice(idx)];
      }
    }
  }
  return [src, ""];
}

export type RestoreOutcome = "none" | "head" | "tail" | "unresolved";

// Below this, the gap between the segment boundary and the nearest timed word
// is too small to be a duration. The text is merged into its neighbour rather
// than given a made-up one.
//
// Two different quantities live in this decision and an earlier version of this
// comment ran them together. The GAP DISTRIBUTION: on the tail the gap is
// exactly 0 in 698 of 743 measured drops and >= 0.08 in the other 45, with
// nothing in between, so the exact value of the floor is not load-bearing
// there; on the head 500 of 560 are exactly 0 and 14 more sit strictly inside
// (0, 0.08), the smallest at 0.020, so moving the floor anywhere in 0.021 to
// 0.08 changes what real head segments do. The PATH TAKEN is a different count,
// because a seam with no whitespace merges whatever the gap says: measured 698
// of 743 tails and 514 of 560 heads merge. The two agree in today's corpus only
// because no drop lands on a continuation seam that also has room to spare.
const MIN_RESTORED_SEC = 0.08;

// The run of non-comparable characters at either end of a span: everything
// between the restored words and the timed word beside them.
const LEADING_NON_COMPARABLE = /^[^\p{L}\p{N}]*/u;
const TRAILING_NON_COMPARABLE = /[^\p{L}\p{N}]*$/u;

/** How the seam between a restored span and the timed word beside it divides
 *  between the two, read off the source text and nothing else.
 *
 *  Whitespace anywhere in the run makes it a word boundary, and then what sits
 *  BEFORE the whitespace belongs to the word on the left and what sits AFTER it
 *  to the word on the right: `", "` leaves its comma on "Nice" and `" «"` gives
 *  its guillemet to "«Наука". Testing only the run's first character called
 *  `", bro."` a continuation of "Nice", which is how 45 restores lost their own
 *  timing.
 *
 *  A run with NO whitespace is not a boundary at all: the two pieces are one
 *  word Whisper tokenised in two ("во" + "-первых."), and the whole run belongs
 *  to the left, where the source wrote it.
 *
 *  That last rule is right for "во-первых" and WRONG for Chinese, Japanese and
 *  Thai, which never write whitespace at a seam: there every restore reads as a
 *  continuation, so a whole untimed phrase folds into the neighbouring entry and
 *  is drawn with its timing. Nothing available here can tell where a CJK word
 *  boundary falls, and the corpus holds no CJK at all, so a heuristic could not
 *  be checked against anything. Stated rather than papered over. */
function divideSeam(run: string): { left: string; right: string; isWordBoundary: boolean } {
  if (!/\s/u.test(run)) return { left: run, right: "", isWordBoundary: false };
  return {
    left: run.match(/^\S*/u)?.[0] ?? "",
    right: run.match(/\S*$/u)?.[0] ?? "",
    isWordBoundary: true,
  };
}

/** Drops from a seam run the punctuation the adjacent timed word already
 *  carries, so it is not drawn twice.
 *
 *  Whisper attaches punctuation to word tokens - 2023 of 75378 corpus tokens
 *  carry some - while the span rules anchor on comparable characters and cannot
 *  see it. A token of `"жизнь»"` beside a span of `"» каждый месяц."` burns
 *  "жизнь»»" into the video, and a burned glyph cannot be repaired downstream.
 *  Zero occurrences today against 1362 drop boundaries, but 45 tokens have the
 *  enabling shape.
 *
 *  Code points, never UTF-16 units, so a surrogate pair is never half-matched.
 *  Only the run is searched, never the span's words: a comparable character is
 *  by construction absent from the timed side, so an overlap reaching one would
 *  mean the two helpers had desynced. */
function dropCarriedPunctuation(
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
 * what already ships - over all 1866 cues in the corpus the wordless fallback
 * path draws median 30 and up to 115 characters, and a restored entry tops out
 * at 54.
 */
export function restoreDroppedWords(
  text: string,
  words: SubtitleWord[],
  segStart: number,
  segEnd: number
): { words: SubtitleWord[]; outcome: RestoreOutcome } {
  if (words.length === 0) return { words, outcome: "none" };
  const flatText = comparableText(text);
  const flatWords = comparableText(words.map((w) => w.text).join(""));
  if (flatText === flatWords) return { words, outcome: "none" };
  // Code POINTS, not code units. splitAtComparable counts comparable
  // characters as code points; String.length counts UTF-16 units and the two
  // disagree on every astral letter - CJK Extension B, mathematical
  // alphanumerics. Measured before the fix: a one-letter astral word made the
  // split run one character too far and eat the next word's first letter,
  // restoring "ord" for "word".
  const wordChars = [...flatWords].length;
  const textChars = [...flatText].length;

  // Both branches when flatWords is empty: "" is a prefix AND a suffix of any
  // text, so a words[] of pure punctuation makes both tests true and the tail
  // wins purely by being written first. That is the intended precedence - with
  // no comparable character to anchor either end, restoring the whole text
  // after the punctuation is as good as before it - and it is pinned by a test
  // rather than left to the order of two if-statements. 136 punctuation-only
  // word entries exist in the corpus; no segment where every entry is one.
  if (flatText.startsWith(flatWords)) {
    // Everything after the LAST comparable character that belongs to words[],
    // so punctuation sitting at the seam comes back with the missing span
    // instead of being stranded on the timed side. The head branch reaches to
    // the FIRST such character for the same reason.
    const rawMissing = splitAtComparable(text, wordChars)[1];
    const last = words[words.length - 1];
    const run = rawMissing.match(LEADING_NON_COMPARABLE)?.[0] ?? "";
    const body = rawMissing.slice(run.length).trim();
    // Unreachable: the two guards above mean the tail holds at least one
    // comparable character, which cannot trim away. Kept as insurance against
    // the helpers desyncing, which has now happened twice - and if it does,
    // "unresolved" makes it visible instead of passing for a healthy segment.
    if (!body) return { words, outcome: "unresolved" };
    const { left, right, isWordBoundary } = divideSeam(
      dropCarriedPunctuation(run, last.text, "leading")
    );
    // The seam decides whether there are two words here at all, and only then
    // does the gap decide whether the second can be timed on its own.
    // MIN_RESTORED_SEC answers "can this word have an entry of its own", which
    // is not a question to ask of half a word: splitting "во" from "-первых."
    // would hand half a word its own karaoke highlight and let whatever draws
    // the two entries put a space between them.
    if (isWordBoundary && segEnd - last.end >= MIN_RESTORED_SEC) {
      return {
        words: [
          ...words.slice(0, -1),
          // The seam's left half stays on the word it was written on - the
          // comma of "Nice, bro." belongs to "Nice" - and its right half opens
          // the restored span, which keeps the timing that is genuinely its own.
          { ...last, text: `${last.text}${left}` },
          { text: `${right}${body}`, start: last.end, end: segEnd },
        ],
        outcome: "tail",
      };
    }
    return {
      words: [
        ...words.slice(0, -1),
        // Merged, so the two halves of the seam meet again and the source text
        // is rebuilt exactly: comma, space and all.
        {
          ...last,
          text: `${last.text}${left}${isWordBoundary ? " " : ""}${right}${body}`,
        },
      ],
      outcome: "tail",
    };
  }

  if (flatText.endsWith(flatWords)) {
    // The count is what the timed words do NOT cover, so the split keeps
    // exactly the missing comparable characters. The tail branch spends
    // wordChars because there the timed words come first; here they come last.
    const [before, after] = splitAtComparable(text, textChars - wordChars);
    // ...and then the span is extended TO the timed words. splitAtComparable
    // cuts right after the last missing letter, which leaves the punctuation
    // separating the two halves at the front of `after`, where trim() cannot
    // save it: "Естественно, для человека это проблема." restored as
    // "Естественно" and the comma was gone, on 68 of 560 measured head drops.
    // So the head span is everything before the FIRST comparable character
    // that belongs to words[], the mirror of the tail's LAST.
    const rawMissing = before + (after.match(LEADING_NON_COMPARABLE)?.[0] ?? "");
    const first = words[0];
    const run = rawMissing.match(TRAILING_NON_COMPARABLE)?.[0] ?? "";
    const body = rawMissing.slice(0, rawMissing.length - run.length).trim();
    // Unreachable for the same reason as the tail branch's guard, and
    // "unresolved" for the same reason: a desync between the two helpers must
    // not pass for a healthy segment.
    if (!body) return { words, outcome: "unresolved" };
    // The mirror of the tail branch, asking its two questions in the same order
    // for the same reasons - the seam first, the gap second. "Во-" is not a
    // word, however much head room there is.
    const { left, right, isWordBoundary } = divideSeam(
      dropCarriedPunctuation(run, first.text, "trailing")
    );
    if (isWordBoundary && first.start - segStart >= MIN_RESTORED_SEC) {
      return {
        words: [
          // Mirror of the tail's division: the seam's left half closes the
          // restored span ("Естественно,") and its right half opens the timed
          // word it was written against ("«" + "Наука").
          { text: `${body}${left}`, start: segStart, end: first.start },
          { ...first, text: `${right}${first.text}` },
          ...words.slice(1),
        ],
        outcome: "head",
      };
    }
    return {
      words: [
        // Merged into the FIRST word rather than given a duration, the mirror
        // of the tail branch. "Во-" + "первых" must not become "Во- первых".
        {
          ...first,
          text: `${body}${left}${isWordBoundary ? " " : ""}${right}${first.text}`,
        },
        ...words.slice(1),
      ],
      outcome: "head",
    };
  }

  return { words, outcome: "unresolved" };
}

export function segmentsToCues(
  segments: WhisperSegment[],
  clipStart: number,
  clipEnd: number
): SubtitleCue[] {
  return segments
    .filter((s) => s.end > clipStart && s.start < clipEnd)
    .flatMap((s) => {
      const segStart = Math.max(0, s.start - clipStart);
      const segEnd = Math.min(clipEnd - clipStart, s.end - clipStart);
      // Restore BEFORE windowing: reconciling after the filter would read every
      // segment straddling the window edge as a loss and append text the window
      // deliberately excludes (spec 4).
      const whole =
        s.words && s.words.length > 0
          ? restoreDroppedWords(s.text, s.words, s.start, s.end).words
          : s.words;
      const words = whole
        ?.filter((w) => w.end > clipStart && w.start < clipEnd)
        .map((w) => shiftWord(w, clipStart));

      if (!words || words.length === 0) {
        return [{ id: randomUUID(), start: segStart, end: segEnd, text: s.text }];
      }

      // Word timings let us chunk the segment into short punchy cues.
      const chunks = chunkWords(words);
      return chunks.map((chunk, i) => {
        const next = chunks[i + 1];
        return {
          id: randomUUID(),
          start: i === 0 ? segStart : chunk[0].start,
          // Hold each chunk until the next one starts so text never flickers
          // off mid-sentence; the last chunk runs to the segment end.
          end: next ? next[0].start : segEnd,
          text: chunk.map((w) => w.text).join(" "),
          words: chunk,
        };
      });
    });
}

function chunkWords(words: SubtitleWord[]): SubtitleWord[][] {
  const chunks: SubtitleWord[][] = [];
  let current: SubtitleWord[] = [];
  let chars = 0;
  for (const word of words) {
    const addition = word.text.length + (current.length > 0 ? 1 : 0);
    if (
      current.length > 0 &&
      (current.length >= MAX_CHUNK_WORDS || chars + addition > MAX_CHUNK_CHARS)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(word);
    chars += word.text.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Re-window clip-relative cues to a [start, end] sub-range of the same clip. */
export function sliceCues(
  cues: SubtitleCue[],
  start: number,
  end: number
): SubtitleCue[] {
  return cues
    .filter((c) => c.end > start && c.start < end)
    .map((c) => {
      const words = c.words
        ?.filter((w) => w.end > start && w.start < end)
        .map((w) => shiftWord(w, start));
      return {
        ...c,
        start: Math.max(0, c.start - start),
        end: Math.min(end - start, c.end - start),
        words: words && words.length > 0 ? words : undefined,
      };
    });
}

function shiftWord(w: SubtitleWord, offset: number): SubtitleWord {
  return {
    text: w.text,
    start: Math.max(0, w.start - offset),
    end: Math.max(0, w.end - offset),
  };
}

export function generateAss(cues: SubtitleCue[]): string {
  const s = DEFAULT_STYLE;
  const header = `[Script Info]
Title: ClipClap Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.fontName},${s.fontSize},${s.primaryColor},${s.primaryColor},${s.outlineColor},${s.backColor},-1,0,0,0,100,100,0,0,1,${s.outline},${s.shadow},2,20,20,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = cues
    .filter((c) => c.end > c.start)
    .map((c) => {
      const text =
        c.words && c.words.length > 0 ? karaokeText(c) : escapeAssText(c.text);
      return `Dialogue: 0,${formatAssTime(c.start)},${formatAssTime(c.end)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
}

// ASS karaoke: \k fills words with PrimaryColour as they are spoken, unsung
// text shows SecondaryColour. The line-level \1c override turns the primary
// yellow, so spoken words highlight while unspoken ones stay white (the
// style's secondary colour).
function karaokeText(cue: SubtitleCue): string {
  const words = cue.words!;
  const parts: string[] = [`{\\1c${DEFAULT_STYLE.karaokeFillColor}}`];
  let cursor = cue.start;
  for (const w of words) {
    // Fold any silence gap before the word into its own \k delay so the
    // karaoke cursor stays in sync with real time.
    const durationCs = Math.max(
      1,
      Math.round((Math.max(w.end, cursor) - cursor) * 100)
    );
    parts.push(`{\\k${durationCs}}${escapeAssText(w.text)} `);
    cursor = Math.max(w.end, cursor);
  }
  return parts.join("").trimEnd();
}

function escapeAssText(text: string): string {
  return text.replace(/\n/g, "\\N").replace(/\{/g, "(").replace(/\}/g, ")");
}

function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

/**
 * Writes the cues to a temp .ass file and returns an FFmpeg filter snippet
 * that burns them, plus the temp path for cleanup. Lets callers combine the
 * burn with other filters (crop) in a single encode pass.
 */
export async function createAssFilter(
  cues: SubtitleCue[]
): Promise<{ filter: string; assPath: string }> {
  const assPath = join(tmpdir(), `clipclap-subs-${randomUUID()}.ass`);
  await writeFile(assPath, generateAss(cues), "utf-8");
  const escapeFilterPath = (p: string) =>
    p.replace(/\\/g, "/").replace(/:/g, "\\:");
  return {
    filter: `ass=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(resolveFontsDir())}`,
    assPath,
  };
}

export async function burnSubtitles(
  videoPath: string,
  cues: SubtitleCue[]
): Promise<string> {
  const assContent = generateAss(cues);
  const assPath = join(tmpdir(), `clipclap-subs-${randomUUID()}.ass`);
  const outputPath = join(tmpdir(), `clipclap-subbed-${randomUUID()}.mp4`);

  await writeFile(assPath, assContent, "utf-8");

  try {
    // Escape colons and backslashes for the FFmpeg filter argument parser
    const escapeFilterPath = (p: string) =>
      p.replace(/\\/g, "/").replace(/:/g, "\\:");

    try {
      await execFileAsync("ffmpeg", [
        "-nostdin",
        "-i",
        videoPath,
        "-vf",
        `ass=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(resolveFontsDir())}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
        "-y",
      ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      throw new Error(
        `ffmpeg subtitle burn failed: ${stderr.slice(-2000) || String(error)}`
      );
    }

    const out = await stat(outputPath).catch(() => null);
    if (!out || out.size === 0) {
      throw new Error("ffmpeg subtitle burn produced an empty output file");
    }

    return outputPath;
  } finally {
    await unlink(assPath).catch(() => {});
  }
}
