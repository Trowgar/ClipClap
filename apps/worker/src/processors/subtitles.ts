import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { SubtitleCue, SubtitleWord, WhisperSegment } from "@clipfast/shared";

const execFileAsync = promisify(execFile);

// One burned-in style for everyone. White Montserrat Bold with a black
// outline, bottom-centered on a 1080x1920 canvas; the active word flips to
// yellow via ASS karaoke when word timings exist.
// Font size is in PlayRes pixels: 64 on a 1920-tall canvas ≈ TikTok-size text.
const DEFAULT_STYLE = {
  fontName: "Montserrat",
  fontSize: 64,
  primaryColor: "&H00FFFFFF", // white (AABBGGRR)
  karaokeFillColor: "&H00FFFF&", // yellow (BBGGRR inline override)
  outlineColor: "&H00000000",
  backColor: "&H80000000",
  outline: 4,
  shadow: 0,
  marginV: 80,
} as const;

// Viral-style chunking: at most this many words / characters per burned cue,
// so subtitles stay short and fit a 1080-wide vertical frame.
const MAX_CHUNK_WORDS = 4;
const MAX_CHUNK_CHARS = 24;

// assets/ ships beside src/ in dev (tsx) and beside dist/ in the production
// image, so __dirname/../.. lands on apps/worker in both.
export function resolveFontsDir(): string {
  return (
    process.env.SUBTITLE_FONTS_DIR || join(__dirname, "..", "..", "assets", "fonts")
  );
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
      const words = s.words
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

export async function burnSubtitles(
  videoPath: string,
  cues: SubtitleCue[]
): Promise<string> {
  const assContent = generateAss(cues);
  const assPath = join(tmpdir(), `clipfast-subs-${randomUUID()}.ass`);
  const outputPath = join(tmpdir(), `clipfast-subbed-${randomUUID()}.mp4`);

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
        "fast",
        "-crf",
        "23",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
        "-y",
      ]);
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
