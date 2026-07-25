import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("@clipclap/shared", () => ({
  downloadFile: vi.fn(),
}));

import { downloadVideo } from "../download";
import { SourceUnavailableError } from "../errors";

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

const URL = "https://www.youtube.com/watch?v=abc123";

describe("downloadFromUrl", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_file, _args, _opts, cb) => {
      const done = typeof _opts === "function" ? _opts : cb;
      done(null, { stdout: "[download] 100%", stderr: "" });
    });
  });

  it("bounds yt-dlp stdout with a maxBuffer large enough for a long download", async () => {
    await downloadVideo(URL);

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

  it("returns an mp4 temp path on success", async () => {
    const out = await downloadVideo(URL);
    expect(out).toMatch(/clipclap-.*\.mp4$/);
  });
});
