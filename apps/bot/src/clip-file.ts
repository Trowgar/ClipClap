import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { downloadFile } from "@clipclap/shared";

/** Pull a stored clip to a temp file and return the path.
 *
 *  A file rather than a buffer so `openAsBlob` can stream it into the upload:
 *  the point of the whole change is that a 36 MB clip never has to be resident. */
export async function downloadToFile(storageKey: string): Promise<string> {
  const path = join(tmpdir(), `clipclap-send-${randomUUID()}.mp4`);
  const body = await downloadFile(storageKey);
  await pipeline(
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(path)
  );
  return path;
}
