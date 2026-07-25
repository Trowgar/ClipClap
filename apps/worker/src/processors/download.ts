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
    ({ stdout } = await execFileAsync(
      "yt-dlp",
      [
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
      ],
      // yt-dlp streams progress to stdout for the whole download and we buffer
      // all of it. Node's default cap is 1 MiB, which a multi-hour VOD - the
      // core workload - passes long before it finishes; Node then SIGTERMs a
      // download that was working fine. 16 MiB matches the ceiling the reframe
      // modules already use for chatty children (reframe/shots.ts,
      // reframe/faces.ts) and is far above the few hundred KiB a 3-hour fetch
      // actually prints.
      { maxBuffer: 16 * 1024 * 1024 }
    ));
  } catch (error) {
    // Only yt-dlp's own verdict may be turned into a verdict about the user's
    // link. promisify(execFile) rejects with four distinguishable shapes:
    //
    //   non-zero exit  code: <number>, killed: false  <- yt-dlp ran and refused
    //   spawn failure  code: "ENOENT" (string), syscall: "spawn yt-dlp"
    //   maxBuffer blow code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" (RangeError)
    //   killed         code: null, killed: true, signal: "SIGTERM"
    //
    // The last three are OUR environment failing to run yt-dlp at all - a
    // broken image, our own buffer cap, our own timeout. Telling that user the
    // link may be private or removed sends them to a browser where it opens
    // fine and hides our fault from us, so they fall through untagged to the
    // generic path. A numeric exit status is the one signal that yt-dlp
    // actually looked at the URL and could not produce a file.
    //
    // Even then the exit code does not say WHY: private, removed,
    // region-locked, login-walled, over --max-filesize, or an extractor too old
    // for the site all exit non-zero alike. So SourceUnavailableError claims
    // only "this link did not yield a file" and the copy hedges the cause. Do
    // not sharpen it without reading stderr for yt-dlp's "Private video" /
    // "Video unavailable" / "Sign in to confirm" markers.
    const detail = error instanceof Error ? error.message : String(error);
    if (isProcessExitFailure(error)) {
      throw new SourceUnavailableError(
        `yt-dlp could not fetch ${url}: ${detail}`
      );
    }
    throw new Error(`yt-dlp failed to run for ${url}: ${detail}`, {
      cause: error,
    });
  }

  console.log("yt-dlp output:", stdout);
  return outputPath;
}

/** True only when the child process ran and exited with a non-zero status.
 *  Node reports that as a numeric `code`; spawn and stdio errors carry a string
 *  code (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER) and a kill carries
 *  code null with killed true. */
function isProcessExitFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, killed } = error as { code?: unknown; killed?: unknown };
  return typeof code === "number" && killed !== true;
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
