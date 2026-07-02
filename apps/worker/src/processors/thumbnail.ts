import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFile);

/**
 * Extracts a single representative still frame near `atSeconds` and writes it
 * as a JPEG, returning the local path.
 *
 * Uses FFmpeg's `thumbnail` filter, which scores a window of frames and picks
 * the most representative one - this sidesteps black intro/transition frames
 * without needing to know the source duration (URL jobs often don't have it).
 *
 * The frame keeps the source's native aspect ratio (scaled to 640px wide), so a
 * 16:9 source yields a 16:9 thumbnail that fills the dashboard card without
 * cropping - unlike the 9:16 clips, whose heads get chopped in a 16:9 frame.
 */
export async function generateThumbnail(
  videoPath: string,
  atSeconds: number
): Promise<string> {
  const thumbPath = join(tmpdir(), `clipclap-thumb-${randomUUID()}.jpg`);

  await execFileAsync("ffmpeg", [
    // Input seek (fast, keyframe-accurate) to the interesting moment.
    "-ss",
    String(Math.max(0, atSeconds)),
    "-i",
    videoPath,
    // thumbnail picks the best of the next batch of frames; take just that one.
    "-frames:v",
    "1",
    "-vf",
    "thumbnail,scale=640:-2",
    "-q:v",
    "3",
    thumbPath,
    "-y",
  ]);

  return thumbPath;
}
