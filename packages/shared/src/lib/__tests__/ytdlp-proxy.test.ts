import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isBotCheckFailure,
  proxyArgs,
  rotateWarpExit,
  warpControlUrl,
  ytdlpProxy,
} from "../ytdlp-proxy";

const ENV_KEYS = ["YTDLP_PROXY", "WARP_CONTROL_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("isBotCheckFailure", () => {
  // THE ONE THAT MATTERS. yt-dlp prints a CURLY apostrophe. A pattern written
  // with a straight one matches nothing, and the failure is silent: rotation
  // simply never fires, the URL path stays dead, and every flag looks right.
  it("matches the real message, which uses a curly apostrophe", () => {
    const real =
      "ERROR: [youtube] 9bZkp7q19f0: Sign in to confirm you’re not a bot. " +
      "Use --cookies-from-browser or --cookies for the authentication.";
    expect(isBotCheckFailure(real)).toBe(true);
  });

  it("also matches a straight apostrophe, in case the wording changes back", () => {
    expect(
      isBotCheckFailure("Sign in to confirm you're not a bot.")
    ).toBe(true);
  });

  // Rotation drops every in-flight download through the proxy. Firing it for
  // an ordinary dead link would damage other jobs to fix nothing.
  it.each([
    "ERROR: [youtube] abc: Video unavailable",
    "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
    "ERROR: [youtube] abc: This live stream recording is not available.",
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "",
  ])("does not fire on %s", (text) => {
    expect(isBotCheckFailure(text)).toBe(false);
  });

  it("tolerates null and undefined", () => {
    expect(isBotCheckFailure(null)).toBe(false);
    expect(isBotCheckFailure(undefined)).toBe(false);
  });
});

describe("proxyArgs", () => {
  it("passes nothing when YTDLP_PROXY is unset - the pre-WARP command line", () => {
    expect(proxyArgs()).toEqual([]);
    expect(ytdlpProxy()).toBeNull();
  });

  it("treats whitespace as unset, so a blanked kill switch really is off", () => {
    process.env.YTDLP_PROXY = "   ";
    expect(proxyArgs()).toEqual([]);
  });

  it("emits --proxy when configured", () => {
    process.env.YTDLP_PROXY = "socks5://warp:1080";
    expect(proxyArgs()).toEqual(["--proxy", "socks5://warp:1080"]);
  });
});

describe("warpControlUrl", () => {
  it("is null when unset", () => {
    expect(warpControlUrl()).toBeNull();
  });

  it("strips a trailing slash so the /rotate path cannot double up", () => {
    process.env.WARP_CONTROL_URL = "http://warp:8080/";
    expect(warpControlUrl()).toBe("http://warp:8080");
  });
});

describe("rotateWarpExit", () => {
  it("does not call out at all when rotation is disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(rotateWarpExit()).resolves.toEqual({
      rotated: false,
      reason: "control-url-unset",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a rotation that moved the exit", async () => {
    process.env.WARP_CONTROL_URL = "http://warp:8080";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ rotated: true, previousIp: "1.1.1.1", ip: "2.2.2.2" }),
        { status: 200 }
      )
    );
    await expect(rotateWarpExit()).resolves.toMatchObject({
      rotated: true,
      previousIp: "1.1.1.1",
      ip: "2.2.2.2",
    });
  });

  // A cooldown answer is NOT a rotation. Callers retry only on `rotated`, so
  // coercing this to true would send them back into the same refused exit.
  it("keeps rotated false for a cooldown answer", async () => {
    process.env.WARP_CONTROL_URL = "http://warp:8080";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ rotated: false, reason: "cooldown", ip: "1.1.1.1" }),
        { status: 200 }
      )
    );
    await expect(rotateWarpExit()).resolves.toMatchObject({
      rotated: false,
      reason: "cooldown",
    });
  });

  // Rotation is a repair attempt. If the repair itself breaks, the ORIGINAL
  // error must still be what the user hears about - so this never throws.
  it("swallows a control-server outage instead of throwing", async () => {
    process.env.WARP_CONTROL_URL = "http://warp:8080";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(rotateWarpExit()).resolves.toEqual({
      rotated: false,
      reason: "ECONNREFUSED",
    });
  });

  it("swallows a non-200 from the control server", async () => {
    process.env.WARP_CONTROL_URL = "http://warp:8080";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 })
    );
    await expect(rotateWarpExit()).resolves.toEqual({
      rotated: false,
      reason: "control-http-500",
    });
  });
});
