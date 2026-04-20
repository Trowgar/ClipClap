import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { Highlight } from "@clipfast/shared";

const execFileAsync = promisify(execFile);

export interface CutResult {
  highlight: Highlight;
  clipPath: string;
}

export async function cutClips(
  videoPath: string,
  highlights: Highlight[]
): Promise<CutResult[]> {
  const results: CutResult[] = [];

  for (const highlight of highlights) {
    const clipPath = join(tmpdir(), `clipfast-clip-${randomUUID()}.mp4`);

    await execFileAsync("ffmpeg", [
      "-ss",
      String(highlight.start),
      "-to",
      String(highlight.end),
      "-i",
      videoPath,
      "-vf",
      buildCropFilter(),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      clipPath,
      "-y",
    ]);

    results.push({ highlight, clipPath });
  }

  return results;
}

/**
 * Builds an FFmpeg filter to crop video to 9:16 vertical format.
 * Centers the crop on the original video.
 */
function buildCropFilter(): string {
  // crop to 9:16 from center of original video
  // if source is 16:9 (1920x1080) → crop to 607x1080 center
  return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920";
}
