import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { extractVideoUrl, probeLocalFile, probeVideoUrl } from "../source-probe";

type ExecCb = (
  err: (Error & { code?: string }) | null,
  stdout: string,
  stderr: string
) => void;

/** What execFile hands back when the binary is not on PATH. */
function enoent(binary: string): Error & { code: string } {
  return Object.assign(new Error(`spawn ${binary} ENOENT`), {
    code: "ENOENT",
  });
}

describe("extractVideoUrl", () => {
  it("finds a URL embedded in surrounding text", () => {
    expect(
      extractVideoUrl("check this out https://twitch.tv/videos/123 lol")
    ).toBe("https://twitch.tv/videos/123");
  });

  it("returns null when there is no URL", () => {
    expect(extractVideoUrl("hello world")).toBeNull();
    expect(extractVideoUrl("")).toBeNull();
  });
});

describe("probeVideoUrl", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("reads duration and title from the duration||title line", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(null, "3661||Test Video Title\n", "");
        return { kill: vi.fn() };
      }
    );

    await expect(probeVideoUrl("https://youtube.com/abc")).resolves.toEqual({
      ok: true,
      durationSec: 3661,
      title: "Test Video Title",
    });
  });

  // Without --simulate, yt-dlp downloads the video the probe is supposed to be
  // cheaply asking about - which defeats the whole point of probing before the
  // gate. Pin the flag, not just the behaviour.
  it("passes --simulate so no bytes are downloaded", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(null, "10||x\n", "");
        return { kill: vi.fn() };
      }
    );

    await probeVideoUrl("https://youtube.com/abc");

    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("yt-dlp");
    expect(args).toContain("--simulate");
    expect(args).toContain("--no-playlist");
    expect(args[args.length - 1]).toBe("https://youtube.com/abc");
  });

  it("reports the yt-dlp error for a dead link", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(new Error("exit code 1"), "", "ERROR: video unavailable\n");
        return { kill: vi.fn() };
      }
    );

    await expect(
      probeVideoUrl("https://invalid.example/x")
    ).resolves.toEqual({ ok: false, reason: "yt-dlp-error" });
  });

  // A container without yt-dlp must not tell the user their link is dead. The
  // gate silently never running is our fault and has to say so.
  it("reports probe-unavailable, not yt-dlp-error, when yt-dlp is missing", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(enoent("yt-dlp"), "", "");
        return { kill: vi.fn() };
      }
    );

    await expect(
      probeVideoUrl("https://youtube.com/abc")
    ).resolves.toEqual({ ok: false, reason: "probe-unavailable" });
    expect(logSpy.mock.calls[0]?.[0]).toContain("yt-dlp");
    logSpy.mockRestore();
  });

  it("reports no-duration for a live stream with no duration", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(null, "NA||Live Stream\n", "");
        return { kill: vi.fn() };
      }
    );

    await expect(probeVideoUrl("https://twitch.tv/live/x")).resolves.toEqual({
      ok: false,
      reason: "no-duration",
    });
  });

  it("reports no-duration when yt-dlp prints nothing", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(null, "", "");
        return { kill: vi.fn() };
      }
    );

    await expect(probeVideoUrl("https://example.com/x")).resolves.toEqual({
      ok: false,
      reason: "no-duration",
    });
  });

  // A hung probe holds the submit path open, so the timeout must both settle
  // the promise and kill the child.
  it("kills the child and reports timeout when the probe hangs", async () => {
    vi.useFakeTimers();
    const killSpy = vi.fn();
    execFileMock.mockImplementation(() => ({ kill: killSpy }));

    const resultPromise = probeVideoUrl("https://slow.example/x", 100);
    await vi.advanceTimersByTimeAsync(150);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(killSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("probeLocalFile", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("parses the ffprobe duration", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(null, "128.451000\n", "");
        return { kill: vi.fn() };
      }
    );

    await expect(probeLocalFile("/tmp/clip.mp4")).resolves.toEqual({
      ok: true,
      durationSec: 128.451,
      title: "Upload",
    });

    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("ffprobe");
    expect(args[args.length - 1]).toBe("/tmp/clip.mp4");
  });

  // ffprobe is not yt-dlp, so its failures must not claim to be. ffprobe
  // itself exits non-zero on an unreadable file - the process ran, so this is
  // "probe-error", distinct from ffprobe not existing at all.
  it("reports probe-error on an unreadable file", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(
          Object.assign(new Error("Command failed"), { code: 1 as never }),
          "",
          "No such file or directory\n"
        );
        return { kill: vi.fn() };
      }
    );

    await expect(probeLocalFile("/tmp/missing.mp4")).resolves.toEqual({
      ok: false,
      reason: "probe-error",
    });
  });

  it("reports probe-unavailable when ffprobe itself is missing", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(enoent("ffprobe"), "", "");
        return { kill: vi.fn() };
      }
    );

    await expect(probeLocalFile("/tmp/clip.mp4")).resolves.toEqual({
      ok: false,
      reason: "probe-unavailable",
    });
    expect(logSpy.mock.calls[0]?.[0]).toContain("ffprobe");
    logSpy.mockRestore();
  });

  it("reports no-duration when ffprobe prints N/A", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(null, "N/A\n", "");
        return { kill: vi.fn() };
      }
    );

    await expect(probeLocalFile("/tmp/stream.m3u8")).resolves.toEqual({
      ok: false,
      reason: "no-duration",
    });
  });
});
