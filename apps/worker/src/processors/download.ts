import { execFile } from "child_process";
import { promisify } from "util";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { downloadFile } from "@clipclap/shared";
import { SourceUnavailableError } from "./errors";
import type { Readable } from "stream";

const execFileAsync = promisify(execFile);

// TODO(plan-3): after download, ffprobe the file to get authoritative
// sourceDurationSec, persist on Job, and re-evaluate maxSourceDurationMinutes.
// Without this, browser-undecodable codecs (HEVC/AV1/MKV) bypass the submit-time
// 180-min cap because the client probe in upload-zone.tsx returns null.
export async function downloadVideo(
  sourceUrl?: string,
  sourceKey?: string
): Promise<string> {
  const outputPath = join(tmpdir(), `clipclap-${randomUUID()}.mp4`);

  if (sourceUrl) {
    return downloadFromUrl(sourceUrl, outputPath);
  }

  if (sourceKey) {
    return downloadFromR2(sourceKey, outputPath);
  }

  throw new Error("No source URL or storage key provided");
}

async function downloadFromUrl(
  url: string,
  outputPath: string
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("yt-dlp", [
      url,
      "-f",
      "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
      "--merge-output-format",
      "mp4",
      "-o",
      outputPath,
      "--no-playlist",
      "--max-filesize",
      "2G",
    ]));
  } catch (error) {
    // A non-zero exit means we could not get the file from this URL. It does
    // NOT tell us why: a private or removed video looks the same from here as a
    // yt-dlp too old for the site's current player, an HTTP 429, or the
    // --max-filesize guard above. So the typed error carries the classification
    // we can actually defend - "this link did not yield a file" - and the copy
    // hedges the cause while offering the one remedy that works for all of
    // them: send us the file directly. What it must not do is fall through to
    // the untagged path, which promises an automatic retry that re-fetches the
    // same URL three times and then gives up silently.
    //
    // Do not sharpen this into a cause without reading stderr: yt-dlp prints
    // "Private video" / "Video unavailable" / "Sign in to confirm" markers, and
    // only those justify naming the link as the culprit.
    const detail = error instanceof Error ? error.message : String(error);
    throw new SourceUnavailableError(`yt-dlp could not fetch ${url}: ${detail}`);
  }

  console.log("yt-dlp output:", stdout);
  return outputPath;
}

async function downloadFromR2(
  key: string,
  outputPath: string
): Promise<string> {
  const webStream = await downloadFile(key);
  const nodeStream = webStream as unknown as Readable;
  const writeStream = createWriteStream(outputPath);
  await pipeline(nodeStream, writeStream);
  return outputPath;
}
