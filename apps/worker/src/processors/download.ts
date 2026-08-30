import { execFile } from "child_process";
import { promisify } from "util";
import { createWriteStream } from "fs";
import { stat } from "fs/promises";
import { pipeline } from "stream/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  downloadFile,
  isBotCheckFailure,
  potArgs,
  proxyArgs,
  rotateWarpExit,
  MAX_SOURCE_FILESIZE_BYTES,
} from "@clipclap/shared";
import { SourceTooLargeError, SourceUnavailableError } from "./errors";
import type { Readable } from "stream";

import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

// The authoritative ffprobe of the downloaded file now happens one level up, in
// stages/source-recheck.ts, which persists sourceDurationSec and settles the
// free reservation against it. It belongs to the stage, not here: this function
// only has to produce a file, and the stage is what owns the job row and the
// ledger. Still open from the original TODO: the per-plan
// maxSourceDurationMinutes cap (180 for paid) is not re-evaluated there, so a
// browser-undecodable codec still bypasses the submit-time cap on a PAID plan.
export async function downloadVideo(
  sourceUrl?: string,
  sourceKey?: string,
  destinationPath?: string
): Promise<string> {
  const outputPath = destinationPath ?? join(tmpdir(), `clipclap-${randomUUID()}.mp4`);

  if (sourceUrl) {
    return downloadFromUrl(sourceUrl, outputPath);
  }

  if (sourceKey) {
    return downloadFromR2(sourceKey, outputPath);
  }

  throw new Error("No source URL or storage key provided");
}

/** Run yt-dlp, and on a bot check ask WARP for a new exit and run it once more.
 *
 *  Deliberately wraps ONLY the child process, so the caller's error handling
 *  below - which decides what the user is told about their link - keeps seeing
 *  exactly the error shapes it already documents.
 *
 *  ONE retry. A download is minutes long and rotation drops every connection
 *  through the proxy, so a loop here would repeatedly kick other jobs off the
 *  exit to keep re-fetching one file. If a fresh exit is refused too, the link
 *  genuinely failed.
 *
 *  Retried only when the exit actually MOVED: `rotated` is false on a cooldown
 *  hit or an unreachable control server, and re-downloading through the same
 *  refused address would burn minutes to reproduce the same error. */
export async function runYtDlpWithRotation(
  args: string[],
  // The concrete shape the caller passes, NOT `Parameters<typeof
  // execFileAsync>[2]`: the wide type includes the buffer-encoding overloads,
  // which makes stdout `string | Buffer` and breaks every caller downstream.
  options: { maxBuffer: number }
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("yt-dlp", args, options);
  } catch (error) {
    // execFileAsync attaches the child's stderr to the rejection; the bot check
    // is only ever visible there.
    const stderr = (error as { stderr?: string })?.stderr ?? "";
    if (!isBotCheckFailure(stderr)) throw error;

    console.warn(
      "[download] exit refused as a bot; asking WARP to rotate and retrying once"
    );
    const rotation = await rotateWarpExit();
    if (!rotation.rotated) {
      console.warn(
        `[download] rotation did not move the exit (${rotation.reason ?? "unknown"}, ` +
          `${rotation.previousIp ?? "?"} -> ${rotation.ip ?? "?"}` +
          `${rotation.escalated ? ", escalated" : ""}); reporting the original failure`
      );
      throw error;
    }
    console.warn(
      `[download] rotated ${rotation.previousIp ?? "?"} -> ${rotation.ip ?? "?"}, retrying`
    );
    return await execFileAsync("yt-dlp", args, options);
  }
}

async function downloadFromUrl(
  url: string,
  outputPath: string
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await runYtDlpWithRotation(
      [
        url,
        // Empty when YTDLP_PROXY is unset, so this is exactly the pre-WARP
        // command line. YouTube refuses this host's own address outright, so
        // for YouTube links the proxy is the difference between a file and
        // nothing at all.
        ...proxyArgs(),
        // PO-token plugin wiring - empty when the sidecar is unconfigured.
        ...potArgs(),
        "-f",
        "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
        "--merge-output-format",
        "mp4",
        "-o",
        outputPath,
        "--no-playlist",
        // The shared constant, not a literal "2G", because the SOURCE_TOO_LARGE
        // copy quotes this number to the user and the upload path enforces the
        // same one. yt-dlp accepts a plain byte count (verified against
        // 2026.07.04 in the worker image).
        "--max-filesize",
        String(MAX_SOURCE_FILESIZE_BYTES),
      ],
      // yt-dlp streams progress to stdout for the whole download and we buffer
      // all of it. Node's default cap is 1 MiB, which a multi-hour VOD - the
      // core workload - passes long before it finishes; Node then SIGTERMs a
      // download that was working fine. The ceiling is now shared by every
      // child this worker spawns - see child-buffer.ts, which records what the
      // render path cost before it had one.
      { maxBuffer: CHILD_MAX_BUFFER_BYTES }
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
    // region-locked, login-walled, or an extractor too old for the site all
    // exit non-zero alike. So SourceUnavailableError claims only "this link did
    // not yield a file" and the copy hedges the cause. Do not sharpen it
    // without reading stderr for yt-dlp's "Private video" / "Video
    // unavailable" / "Sign in to confirm" markers.
    //
    // NOTE: an earlier version of this comment listed "over --max-filesize"
    // among the non-zero exits. That was wrong and is the whole of F3 - an
    // over-the-cap source exits ZERO and is handled after this block, not here.
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

  // A zero exit from yt-dlp is NOT a promise that a file exists. yt-dlp splits
  // "failed" from "declined", and only the first is an error: when it decides
  // to SKIP a download it prints its reason on stdout, writes nothing, and
  // exits 0. Verified by hand against yt-dlp 2026.07.04 in the worker-download
  // image, each of these exiting 0 with no file at -o:
  //
  //   --max-filesize exceeded   "[download] File is larger than max-filesize
  //                              (300000 bytes > 1024 bytes). Aborting."
  //   --min-filesize undershot  "File is smaller than min-filesize ..."
  //   --match-filter rejected   "... does not pass filter (...), skipping .."
  //   --download-archive dup    "... has already been recorded in the archive"
  //   --skip-download           (silent)
  //
  // Only --max-filesize is in the argument list above, but the class of bug is
  // what matters: returning outputPath here for a file that was never written
  // sends an ENOENT out of uploadFile two calls later in stages/download.ts,
  // untagged, so a clipper who pasted a link to an over-the-cap VOD - the core
  // workload - got the generic "something went wrong" copy on all 3 attempts.
  //
  // Existence is the trigger and stdout only sharpens the diagnosis, never the
  // other way round: matching on message text alone would be a false positive
  // waiting to happen, whereas if a future yt-dlp rewords its abort line we
  // degrade to SourceUnavailableError - still honest, still coded, never back
  // to the generic bucket.
  const bytes = await fileSizeOrNull(outputPath);
  if (bytes === null || bytes === 0) {
    const size = parseMaxFilesizeAbort(stdout);
    if (size) {
      throw new SourceTooLargeError(
        `yt-dlp declined ${url}: source is ${size.actualBytes} bytes, over the ` +
          `${size.limitBytes} byte limit`
      );
    }
    throw new SourceUnavailableError(
      `yt-dlp exited 0 but wrote no file for ${url}: ${lastLine(stdout)}`
    );
  }

  return outputPath;
}

async function fileSizeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** yt-dlp's own verdict, on stdout, e.g.
 *  "[download] File is larger than max-filesize (5368709120 bytes > 2147483648 bytes). Aborting."
 *  Both numbers are worth keeping: the limit proves which cap bit, and the
 *  actual size is the only record of how far over the source was. */
function parseMaxFilesizeAbort(
  stdout: string
): { actualBytes: string; limitBytes: string } | null {
  const match =
    /larger than max-filesize\s*\((\d+)\s*bytes\s*>\s*(\d+)\s*bytes\)/i.exec(
      stdout
    );
  if (!match) return null;
  return { actualBytes: match[1], limitBytes: match[2] };
}

/** yt-dlp's reason is the last thing it printed; the rest is progress noise. */
function lastLine(stdout: string): string {
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  return lines[lines.length - 1]?.trim() ?? "(no output)";
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
