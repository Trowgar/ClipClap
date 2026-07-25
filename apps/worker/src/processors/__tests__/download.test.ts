import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

const downloadFileMock = vi.hoisted(() => vi.fn());

const MAX_SOURCE_FILESIZE_BYTES = vi.hoisted(() => 2 * 1024 * 1024 * 1024);

vi.mock("@clipclap/shared", () => ({
  downloadFile: downloadFileMock,
  MAX_SOURCE_FILESIZE_BYTES,
}));

import { writeFileSync } from "fs";
import { readFile, unlink } from "fs/promises";
import { Readable } from "stream";
import { downloadVideo } from "../download";
import { SourceTooLargeError, SourceUnavailableError } from "../errors";

/** The exact shapes promisify(execFile) rejects with, verified against the
 *  worker image's Node (see the probe in the F5 report):
 *
 *    non-zero exit  -> Error,      code: <number>, killed: false, signal: null
 *    spawn failure  -> Error,      code: "ENOENT", errno: -2, syscall: "spawn ..."
 *    maxBuffer blow -> RangeError, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
 *    timeout/kill   -> Error,      code: null, killed: true, signal: "SIGTERM"
 *
 *  Only the first is yt-dlp reporting on the URL. The other three are our own
 *  environment failing to run yt-dlp at all. */
function exitError(code: number): Error {
  return Object.assign(new Error(`Command failed: yt-dlp\nERROR: unavailable`), {
    code,
    killed: false,
    signal: null,
    stdout: "",
    stderr: "ERROR: Video unavailable",
  });
}

function spawnEnoent(): Error {
  return Object.assign(new Error("spawn yt-dlp ENOENT"), {
    code: "ENOENT",
    errno: -2,
    syscall: "spawn yt-dlp",
    path: "yt-dlp",
  });
}

function maxBufferError(): Error {
  return Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    cmd: "yt-dlp",
  });
}

function signalKill(): Error {
  return Object.assign(new Error("Command failed: yt-dlp\n"), {
    code: null,
    killed: true,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
  });
}

/** promisify(execFile) calls the original with a node-style callback last. */
function rejectWith(error: Error) {
  execFileMock.mockImplementation((_file, _args, _opts, cb) => {
    const done = typeof _opts === "function" ? _opts : cb;
    done(error, { stdout: "", stderr: "" });
  });
}

function outputPathFrom(args: string[]): string {
  return args[args.indexOf("-o") + 1];
}

/** A REAL yt-dlp success: it writes the file at -o and then exits zero. A mock
 *  that only resolves is simulating the F3 bug, not a success, so every test
 *  that means "the download worked" has to write the file too. */
function resolveWritingFile(bytes = "videobytes") {
  execFileMock.mockImplementation((_file, args, _opts, cb) => {
    const done = typeof _opts === "function" ? _opts : cb;
    writeFileSync(outputPathFrom(args), bytes);
    done(null, { stdout: "[download] 100%", stderr: "" });
  });
}

/** yt-dlp EXITS ZERO and writes nothing whenever it decides to SKIP a download
 *  rather than fail it. Verified by hand against yt-dlp 2026.07.04 in the
 *  worker-download image (F3):
 *
 *    --max-filesize exceeded  -> exit 0, "[download] File is larger than
 *                                max-filesize (N bytes > M bytes). Aborting."
 *    --min-filesize undershot -> exit 0, "File is smaller than min-filesize"
 *    --match-filter rejected  -> exit 0, "does not pass filter ..., skipping"
 *    --download-archive dup   -> exit 0, "has already been recorded"
 *
 *  Only --max-filesize is in our argument list today, but the class is the
 *  point: a zero exit is NOT proof that a file exists. All four messages go to
 *  stdout, which is the stream we capture. */
function resolveWritingNothing(stdout: string) {
  execFileMock.mockImplementation((_file, _args, _opts, cb) => {
    const done = typeof _opts === "function" ? _opts : cb;
    done(null, { stdout, stderr: "" });
  });
}

const OVERSIZED_STDOUT = [
  "[generic] Extracting URL: https://www.youtube.com/watch?v=abc123",
  "[info] abc123: Downloading 1 format(s): 137+140",
  "[download] File is larger than max-filesize (5368709120 bytes > 2147483648 bytes). Aborting.",
].join("\n");

const URL = "https://www.youtube.com/watch?v=abc123";

describe("downloadFromUrl", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    resolveWritingFile();
  });

  it("bounds yt-dlp stdout with a maxBuffer large enough for a long download", async () => {
    await downloadVideo(URL).then((p) => unlink(p).catch(() => {}));

    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file).toBe("yt-dlp");
    expect(args).toContain(URL);
    // Without an explicit maxBuffer, Node's 1 MiB default applies while yt-dlp
    // streams unbounded progress output - a 2-hour VOD blows past it and Node
    // SIGTERMs a download that was working. The reframe modules already set
    // 16 MiB (reframe/shots.ts, reframe/faces.ts); match that floor.
    expect(typeof options).toBe("object");
    expect(options.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  describe("classification", () => {
    it("blames the source only when yt-dlp itself exited non-zero", async () => {
      rejectWith(exitError(1));
      await expect(downloadVideo(URL)).rejects.toBeInstanceOf(
        SourceUnavailableError
      );
    });

    it("does not blame the link when yt-dlp is missing from the image", async () => {
      // A deploy fault. Telling the user their link may be private sends them
      // to a browser where it opens fine, and hides a broken image from us.
      rejectWith(spawnEnoent());
      const err = await downloadVideo(URL).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SourceUnavailableError);
      expect(String(err.message)).toContain("ENOENT");
    });

    it("does not blame the link when our own maxBuffer killed the child", async () => {
      rejectWith(maxBufferError());
      const err = await downloadVideo(URL).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SourceUnavailableError);
    });

    it("does not blame the link when the child was killed by a signal", async () => {
      // code is null and killed is true - nothing here is a verdict on the URL.
      rejectWith(signalKill());
      const err = await downloadVideo(URL).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SourceUnavailableError);
    });

    it("does not blame the link for a non-exec rejection", async () => {
      rejectWith(new Error("boom"));
      const err = await downloadVideo(URL).catch((e) => e);
      expect(err).not.toBeInstanceOf(SourceUnavailableError);
    });

    it("keeps the failing url and the underlying detail in the message", async () => {
      rejectWith(exitError(1));
      const err = await downloadVideo(URL).catch((e) => e);
      expect(String(err.message)).toContain(URL);
      expect(String(err.message)).toContain("Command failed");
    });
  });

  // F3. yt-dlp does not treat "I decided not to download this" as an error: it
  // prints its reason, writes no file and exits 0. execFileAsync resolves, the
  // classification catch above is never entered, and the function used to
  // return outputPath for a file that does not exist - which then blew up two
  // calls later as an untagged ENOENT from uploadFile and reached the user as
  // the generic "something went wrong" bucket, identically on all 3 attempts.
  // The pasted-a-long-VOD case is the core workload, so it may not land there.
  describe("a zero exit that produced no file", () => {
    it("names the size cap when yt-dlp refused the source for being too large", async () => {
      resolveWritingNothing(OVERSIZED_STDOUT);

      const err = await downloadVideo(URL).catch((e) => e);

      expect(err).toBeInstanceOf(SourceTooLargeError);
    });

    it("keeps the size yt-dlp reported in the diagnostic message", async () => {
      resolveWritingNothing(OVERSIZED_STDOUT);

      const err = await downloadVideo(URL).catch((e) => e);

      // Job.error is our only record of what actually happened; the user-facing
      // copy is a static string, so the numbers have to survive here.
      expect(String(err.message)).toContain("5368709120");
      expect(String(err.message)).toContain(URL);
    });

    it("blames the source, not the size, when yt-dlp skipped for some other reason", async () => {
      // A skip we do not recognise is still "this link did not yield a file",
      // which is exactly what SourceUnavailableError claims - and it must not
      // fall through to the generic bucket. Wording-only drift in a future
      // yt-dlp release degrades to this, never back to generic.
      resolveWritingNothing(
        "[download] abc123 does not pass filter (duration>99999), skipping .."
      );

      const err = await downloadVideo(URL).catch((e) => e);

      expect(err).toBeInstanceOf(SourceUnavailableError);
      expect(err).not.toBeInstanceOf(SourceTooLargeError);
    });

    it("does not accept a zero-byte file as a download", async () => {
      resolveWritingFile("");

      const err = await downloadVideo(URL).catch((e) => e);

      expect(err).toBeInstanceOf(SourceUnavailableError);
    });
  });

  it("asks yt-dlp for the same size cap the plans enforce on uploads", async () => {
    // The copy states "2 GB" as fact on both surfaces. If this argument and
    // ABUSE_CAPS.maxFileSizeBytes ever drift, that sentence becomes a lie.
    await downloadVideo(URL).then((p) => unlink(p).catch(() => {}));

    const [, args] = execFileMock.mock.calls[0];
    expect(args[args.indexOf("--max-filesize") + 1]).toBe(
      String(MAX_SOURCE_FILESIZE_BYTES)
    );
  });

  it("returns an mp4 temp path on success", async () => {
    const out = await downloadVideo(URL);
    expect(out).toMatch(/clipclap-.*\.mp4$/);
    await expect(readFile(out, "utf8")).resolves.toBe("videobytes");
    await unlink(out).catch(() => {});
  });
});

describe("source routing", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    downloadFileMock.mockReset();
    resolveWritingFile();
  });

  // The uploaded-file path is the primary workload and the stage mocks
  // downloadVideo wholesale, so nothing else in the suite ever streams an R2
  // object to disk. A body that resolved the path without writing it would hand
  // the next stage a file that does not exist, and the job would fail as a
  // generic ffmpeg error long after the real fault.
  it("streams the R2 object to the temp file and returns its path", async () => {
    downloadFileMock.mockResolvedValue(Readable.from([Buffer.from("videobytes")]));

    const out = await downloadVideo(undefined, "uploads/u1/clip.mp4");

    expect(downloadFileMock).toHaveBeenCalledWith("uploads/u1/clip.mp4");
    expect(execFileMock).not.toHaveBeenCalled();
    await expect(readFile(out, "utf8")).resolves.toBe("videobytes");
    await unlink(out).catch(() => {});
  });

  it("prefers the pasted url over a storage key", async () => {
    await downloadVideo(URL, "uploads/u1/clip.mp4").then((p) =>
      unlink(p).catch(() => {})
    );

    expect(execFileMock).toHaveBeenCalled();
    expect(downloadFileMock).not.toHaveBeenCalled();
  });

  it("refuses a job with neither a url nor a key instead of inventing a path", async () => {
    // Without the guard this returns a path to a file that was never created,
    // and the failure surfaces several stages downstream as an unreadable file.
    await expect(downloadVideo()).rejects.toThrow(
      "No source URL or storage key provided"
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(downloadFileMock).not.toHaveBeenCalled();
  });
});
