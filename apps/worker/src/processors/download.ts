import { execFile } from "child_process";
import { promisify } from "util";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { downloadFile } from "@clipfast/shared";
import type { Readable } from "stream";

const execFileAsync = promisify(execFile);

export async function downloadVideo(
  sourceUrl?: string,
  sourceKey?: string
): Promise<string> {
  const outputPath = join(tmpdir(), `clipfast-${randomUUID()}.mp4`);

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
  const { stdout } = await execFileAsync("yt-dlp", [
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
  ]);

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
