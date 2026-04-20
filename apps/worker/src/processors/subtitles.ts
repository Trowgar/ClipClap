import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { WhisperSegment, SubtitlePreset } from "@clipfast/shared";

const execFileAsync = promisify(execFile);

interface SubtitleStyle {
  fontName: string;
  fontSize: number;
  primaryColor: string; // ASS color format: &HAABBGGRR
  outlineColor: string;
  backColor: string;
  bold: boolean;
  outline: number;
  shadow: number;
  marginV: number;
}

const PRESETS: Record<SubtitlePreset, SubtitleStyle> = {
  tiktok: {
    fontName: "Arial",
    fontSize: 18,
    primaryColor: "&H00FFFFFF", // white
    outlineColor: "&H00000000", // black
    backColor: "&H80000000",
    bold: true,
    outline: 3,
    shadow: 0,
    marginV: 60,
  },
  minimal: {
    fontName: "Arial",
    fontSize: 14,
    primaryColor: "&H00FFFFFF",
    outlineColor: "&H00000000",
    backColor: "&H00000000",
    bold: false,
    outline: 1,
    shadow: 1,
    marginV: 40,
  },
  bold: {
    fontName: "Impact",
    fontSize: 22,
    primaryColor: "&H0000FFFF", // yellow
    outlineColor: "&H00000000",
    backColor: "&H80000000",
    bold: true,
    outline: 4,
    shadow: 0,
    marginV: 80,
  },
};

export function generateAss(
  segments: WhisperSegment[],
  clipStart: number,
  clipEnd: number,
  preset: SubtitlePreset = "tiktok"
): string {
  const style = PRESETS[preset];
  const boldFlag = style.bold ? -1 : 0;

  const header = `[Script Info]
Title: ClipFast Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontName},${style.fontSize},${style.primaryColor},&H000000FF,${style.outlineColor},${style.backColor},${boldFlag},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},2,20,20,${style.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  // Filter and adjust segments to clip timeframe
  const events = segments
    .filter((s) => s.end > clipStart && s.start < clipEnd)
    .map((s) => {
      const start = Math.max(0, s.start - clipStart);
      const end = Math.min(clipEnd - clipStart, s.end - clipStart);
      const text = s.text.replace(/\n/g, "\\N");
      return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
}

function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

export async function burnSubtitles(
  videoPath: string,
  segments: WhisperSegment[],
  clipStart: number,
  clipEnd: number,
  preset: SubtitlePreset = "tiktok"
): Promise<string> {
  const assContent = generateAss(segments, clipStart, clipEnd, preset);
  const assPath = join(tmpdir(), `clipfast-subs-${randomUUID()}.ass`);
  const outputPath = join(tmpdir(), `clipfast-subbed-${randomUUID()}.mp4`);

  await writeFile(assPath, assContent, "utf-8");

  try {
    // Escape colons and backslashes in path for FFmpeg filter
    const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

    await execFileAsync("ffmpeg", [
      "-i",
      videoPath,
      "-vf",
      `ass=${escapedAssPath}`,
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

    return outputPath;
  } finally {
    await unlink(assPath).catch(() => {});
  }
}
