import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { extractVideoUrl, probeVideoUrl } from "../url-probe";

describe("extractVideoUrl", () => {
  it("returns a clean https URL", () => {
    expect(extractVideoUrl("https://youtube.com/watch?v=abc")).toBe(
      "https://youtube.com/watch?v=abc"
    );
  });

  it("returns a clean http URL", () => {
    expect(extractVideoUrl("http://example.com/v.mp4")).toBe(
      "http://example.com/v.mp4"
    );
  });

  it("finds a URL embedded in surrounding text", () => {
    expect(
      extractVideoUrl("check this out https://twitch.tv/videos/123 lol")
    ).toBe("https://twitch.tv/videos/123");
  });

  it("returns the first URL when two are present", () => {
    expect(
      extractVideoUrl("https://a.com/1 and https://b.com/2")
    ).toBe("https://a.com/1");
  });

  it("returns null for non-http schemes", () => {
    expect(extractVideoUrl("ftp://example.com/file.mp4")).toBeNull();
    expect(extractVideoUrl("magnet:?xt=...")).toBeNull();
  });

  it("returns null for plain text without URLs", () => {
    expect(extractVideoUrl("hello world")).toBeNull();
    expect(extractVideoUrl("")).toBeNull();
    expect(extractVideoUrl("just talking about https")).toBeNull();
  });
});

describe("probeVideoUrl", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns durationSec and title on success", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "3661||Test Video Title\n", "");
      return { kill: vi.fn() } as never;
    });
    const result = await probeVideoUrl("https://youtube.com/abc");
    expect(result).toEqual({
      ok: true,
      durationSec: 3661,
      title: "Test Video Title",
    });
  });

  it("returns ok=false with reason 'yt-dlp-error' on non-zero exit", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(new Error("exit code 1"), "", "ERROR: unavailable\n");
      return { kill: vi.fn() } as never;
    });
    const result = await probeVideoUrl("https://invalid.example/x");
    expect(result).toEqual({
      ok: false,
      reason: "yt-dlp-error",
      error: "ERROR: unavailable",
    });
  });

  it("returns ok=false with reason 'no-duration' when duration is NA", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "NA||Live Stream\n", "");
      return { kill: vi.fn() } as never;
    });
    const result = await probeVideoUrl("https://twitch.tv/live/x");
    expect(result).toEqual({ ok: false, reason: "no-duration" });
  });

  it("returns ok=false with reason 'no-duration' when stdout is empty", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return { kill: vi.fn() } as never;
    });
    const result = await probeVideoUrl("https://example.com/x");
    expect(result).toEqual({ ok: false, reason: "no-duration" });
  });

  it("returns ok=false with reason 'timeout' when probe exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    const killSpy = vi.fn();
    execFileMock.mockImplementation((_cmd, _args, _opts, _cb: any) => {
      // Never invoke callback - simulates a hung process
      return { kill: killSpy } as never;
    });

    const resultPromise = probeVideoUrl("https://slow.example/x", 100);
    await vi.advanceTimersByTimeAsync(150);
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(killSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
