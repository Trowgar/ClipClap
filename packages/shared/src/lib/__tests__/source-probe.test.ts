import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  extractVideoUrl,
  isYouTubeUrl,
  probeLocalFile,
  probeVideoUrl,
} from "../source-probe";

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

describe("isYouTubeUrl", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ",
  ])("recognises %s", (url) => {
    expect(isYouTubeUrl(url)).toBe(true);
  });

  it.each([
    "https://www.tiktok.com/@tiktok/video/7106594312292453675",
    "https://www.twitch.tv/videos/123",
    "https://vimeo.com/123",
  ])("leaves %s to the generic message", (url) => {
    expect(isYouTubeUrl(url)).toBe(false);
  });

  // Host-SUFFIX matching, not `includes`. A substring test would hand the
  // "YouTube is blocking us" copy to links that have nothing to do with
  // YouTube, and the user would be told to stop retrying a link that might
  // actually have worked.
  it.each([
    "https://youtube.com.evil.test/watch?v=1",
    "https://notyoutube.com/watch?v=1",
    "https://myyoutu.be/abc",
    "https://example.test/redirect?next=https://youtube.com/watch?v=1",
  ])("does not mistake %s for YouTube", (url) => {
    expect(isYouTubeUrl(url)).toBe(false);
  });

  // A string yt-dlp would reject anyway. It is a bad link, not a blocked one,
  // so it must fall through to the generic copy rather than throw.
  it("returns false for an unparseable URL instead of throwing", () => {
    expect(isYouTubeUrl("youtube.com/watch?v=1")).toBe(false);
    expect(isYouTubeUrl("not a url at all")).toBe(false);
    expect(isYouTubeUrl("")).toBe(false);
  });
});

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

describe("probeVideoUrl rotate-and-retry", () => {
  const BOT_CHECK =
    "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. " +
    "Use --cookies-from-browser or --cookies for the authentication.";

  beforeEach(() => {
    execFileMock.mockReset();
    process.env.WARP_CONTROL_URL = "http://warp:8080";
  });

  afterEach(() => {
    delete process.env.WARP_CONTROL_URL;
    delete process.env.YTDLP_PROXY;
    vi.restoreAllMocks();
  });

  /** nth call fails with the bot check, the rest succeed. */
  function botCheckThenSuccess() {
    let call = 0;
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        call += 1;
        if (call === 1) cb(new Error("exit code 1"), "", BOT_CHECK);
        else cb(null, "42||Recovered\n", "");
        return { kill: vi.fn() };
      }
    );
  }

  it("rotates the exit and re-probes when YouTube refuses us as a bot", async () => {
    botCheckThenSuccess();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ rotated: true, previousIp: "1.1.1.1", ip: "2.2.2.2" }),
        { status: 200 }
      )
    );

    await expect(probeVideoUrl("https://youtube.com/abc")).resolves.toEqual({
      ok: true,
      durationSec: 42,
      title: "Recovered",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  // A cooldown answer means the exit did NOT move. Re-probing would make the
  // user wait twice for the identical refusal.
  it("does not re-probe when the rotation did not move the exit", async () => {
    botCheckThenSuccess();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rotated: false, reason: "cooldown" }), {
        status: 200,
      })
    );

    await expect(probeVideoUrl("https://youtube.com/abc")).resolves.toEqual({
      ok: false,
      reason: "yt-dlp-error",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  // Rotation drops every in-flight download through the shared exit. An
  // ordinary dead link must never trigger it.
  it("never rotates for a failure that is not the bot check", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(new Error("exit code 1"), "", "ERROR: [youtube] abc: Video unavailable");
        return { kill: vi.fn() };
      }
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(probeVideoUrl("https://youtube.com/abc")).resolves.toEqual({
      ok: false,
      reason: "yt-dlp-error",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("passes --proxy to yt-dlp when YTDLP_PROXY is set", async () => {
    process.env.YTDLP_PROXY = "socks5://warp:1080";
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(null, "10||x\n", "");
        return { kill: vi.fn() };
      }
    );

    await probeVideoUrl("https://youtube.com/abc");

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("--proxy");
    expect(args[args.indexOf("--proxy") + 1]).toBe("socks5://warp:1080");
  });
});

describe("probeVideoUrl transient 403", () => {
  const FORBIDDEN =
    "ERROR: unable to download video data: HTTP Error 403: Forbidden";
  const BOT_CHECK =
    "ERROR: [youtube] abc: Sign in to confirm you’re not a bot.";

  beforeEach(() => {
    execFileMock.mockReset();
    process.env.WARP_CONTROL_URL = "http://warp:8080";
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete process.env.WARP_CONTROL_URL;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Scripted stderr per call; a null entry is a success. */
  function script(...stderrs: Array<string | null>) {
    let call = 0;
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        const stderr = stderrs[Math.min(call, stderrs.length - 1)];
        call += 1;
        if (stderr === null) cb(null, "42||Recovered\n", "");
        else cb(new Error("exit code 1"), "", stderr);
        return { kill: vi.fn() };
      }
    );
  }

  // The observed shape: a 403 that clears seconds later. One plain retry, no
  // rotation - rotation would drop every other download to fix a hiccup.
  it("retries once after a pause and never rotates", async () => {
    script(FORBIDDEN, null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const pending = probeVideoUrl("https://youtube.com/abc");
    // The retry waits; nothing has been re-run yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toEqual({
      ok: true,
      durationSec: 42,
      title: "Recovered",
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ONE retry, not a loop: a second 403 is the answer.
  it("gives up after the second 403 without rotating", async () => {
    script(FORBIDDEN, FORBIDDEN, null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const pending = probeVideoUrl("https://youtube.com/abc");
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "yt-dlp-error",
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The retry's answer goes through the ordinary path: a 403 that becomes the
  // bot check on retry still reaches rotation.
  it("still rotates when the retry hits the bot check", async () => {
    script(FORBIDDEN, BOT_CHECK, null);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ rotated: true, previousIp: "1.1.1.1", ip: "2.2.2.2" }),
        { status: 200 }
      )
    );

    const pending = probeVideoUrl("https://youtube.com/abc");
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toEqual({
      ok: true,
      durationSec: 42,
      title: "Recovered",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
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

describe("probeVideoUrl rotation budget", () => {
  const BOT_CHECK = "ERROR: Sign in to confirm you’re not a bot.";

  beforeEach(() => {
    execFileMock.mockReset();
    process.env.WARP_CONTROL_URL = "http://warp:8080";
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
        cb(new Error("exit code 1"), "", BOT_CHECK);
        return { kill: vi.fn() };
      }
    );
  });

  afterEach(() => {
    delete process.env.WARP_CONTROL_URL;
    vi.restoreAllMocks();
  });

  // /api/jobs blocks a browser on this call. A caller must be able to refuse
  // the wait outright rather than hang a POST behind a 75s rotation.
  it("skips rotation entirely when the budget is zero", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      probeVideoUrl("https://youtube.com/abc", 10_000, { rotateBudgetMs: 0 })
    ).resolves.toEqual({ ok: false, reason: "yt-dlp-error" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the rotation request once the budget is spent", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new Error("The operation was aborted."))
        );
      });
    });

    const result = await probeVideoUrl("https://youtube.com/abc", 10_000, {
      rotateBudgetMs: 50,
    });

    // The rotation failed, so the ORIGINAL probe failure is what surfaces -
    // never an error about the control server the user cannot act on.
    expect(result).toEqual({ ok: false, reason: "yt-dlp-error" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
