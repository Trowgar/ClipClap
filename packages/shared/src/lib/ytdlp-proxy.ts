/** The WARP proxy that yt-dlp goes through, and the rotation that repairs it.
 *
 *  YouTube refuses this host's Hetzner address outright, on IPv4 and IPv6
 *  alike. Everything else we measured - player clients, PO tokens, a real JS
 *  runtime, the Invidious fallback, a newer yt-dlp - failed. Routing yt-dlp
 *  through Cloudflare WARP is what worked, so the proxy is not an optimisation
 *  here: without it the URL path is dead.
 *
 *  WARP exits are SHARED Cloudflare addresses. Ours is not residential, and an
 *  exit can pick up the bot check through no fault of ours when enough other
 *  people hit YouTube from it. That is what rotation is for, and why the code
 *  below distinguishes the bot check from every other failure: rotating on a
 *  dead link would drop other jobs' downloads to fix nothing.
 */

/** `socks5://warp:1080`, or empty to bypass the proxy entirely.
 *
 *  A KILL SWITCH, deliberately read per call rather than cached at import: if
 *  WARP turns out to be worse than nothing, clearing this in `.env` and
 *  recreating the containers restores the old behaviour with no code change. */
export function ytdlpProxy(): string | null {
  const raw = process.env.YTDLP_PROXY?.trim();
  return raw ? raw : null;
}

/** Base URL of the WARP control server, or empty to disable rotation.
 *
 *  Separate from the proxy on purpose: a proxy with rotation switched off is a
 *  sane, testable state, and it is the one to fall back to if rotation ever
 *  misbehaves in a way the proxy itself does not. */
export function warpControlUrl(): string | null {
  const raw = process.env.WARP_CONTROL_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** yt-dlp args for the proxy, or nothing when unconfigured. */
export function proxyArgs(): string[] {
  const proxy = ytdlpProxy();
  return proxy ? ["--proxy", proxy] : [];
}

/** Base URL of the GVS PO-token provider sidecar, or null to run tokenless.
 *
 *  Same kill-switch shape as the proxy: read per call, cleared in .env to
 *  disable, and the bgutil plugin inside the images stays inert without it.
 *  See docker-compose.yml's potprovider service and spec
 *  2026-08-19-youtube-flap-survival 2 for why this exists: YouTube's
 *  "metadata fine, every segment 403" mode is a Proof-of-Origin demand. */
export function potProviderUrl(): string | null {
  const raw = process.env.YTDLP_POT_PROVIDER_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** yt-dlp args pointing the bgutil PO-token plugin at the sidecar, or nothing. */
export function potArgs(): string[] {
  const url = potProviderUrl();
  return url
    ? ["--extractor-args", `youtubepot-bgutilhttp:base_url=${url}`]
    : [];
}

/** Did YouTube refuse this exit as a bot?
 *
 *  Matched loosely ON PURPOSE. The live message uses a CURLY apostrophe
 *  ("you’re"), so any pattern spelling it with a straight one silently never
 *  fires - the failure mode being that rotation quietly never happens and the
 *  URL path stays dead while every flag looks correctly set. The wording has
 *  also changed before. So: the two stable words, and tolerance for whatever
 *  sits between them. */
export function isBotCheckFailure(text: string | undefined | null): boolean {
  if (!text) return false;
  return /confirm\s+you.{0,3}re\s+not\s+a\s+bot/i.test(text);
}

/** A bare `HTTP Error 403: Forbidden` from yt-dlp - NOT the bot check.
 *
 *  These are transient. worker-download logged nine of them on 2026-08-14..16
 *  ("unable to download video data: HTTP Error 403"), and every one cleared on
 *  the next BullMQ attempt seconds later; a bot user who got one at the probe
 *  resent the same link 25s later and it went through. So the right response
 *  is one plain retry after a short pause - and NEVER a rotation: rotation
 *  drops every connection through the shared exit, and treating a
 *  self-clearing 403 as a blocked exit would turn a routine hiccup into a
 *  proxy-wide outage several times a day. Kept apart from the bot check for
 *  exactly that reason: the two failures want opposite repairs. */
export function isTransient403(text: string | undefined | null): boolean {
  if (!text) return false;
  return /HTTP Error 403/i.test(text) && !isBotCheckFailure(text);
}

export interface RotateOutcome {
  /** True only when the exit address actually MOVED. A rotation that returned
   *  the same address must not be reported as success: the caller would retry
   *  into the identical block believing it had a fresh IP. */
  rotated: boolean;
  ip?: string | null;
  previousIp?: string | null;
  /** "cooldown" | "pinned" | "escalation-no-move" | "egress-unreadable" from
   *  the control server, or a transport reason set here. Absent on success. */
  reason?: string;
  /** The control server went as far as a fresh registration. */
  escalated?: boolean;
}

/** Ask WARP for a new exit address.
 *
 *  Never throws and never rejects: rotation is a repair attempt, and a failed
 *  repair must leave the original error to be reported as-is rather than
 *  replacing it with a confusing one about the control server. */
export async function rotateWarpExit(
  // Above the control server's own 75s deadline, so a slow-but-succeeding
  // rotation is not abandoned here and reported as a failure while it is still
  // working - which would leave the caller giving up on an exit that just came
  // good.
  timeoutMs = 120_000
): Promise<RotateOutcome> {
  const base = warpControlUrl();
  if (!base) return { rotated: false, reason: "control-url-unset" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/rotate`, {
      method: "POST",
      signal: controller.signal,
    });
    if (!res.ok) {
      return { rotated: false, reason: `control-http-${res.status}` };
    }
    const body = (await res.json()) as RotateOutcome;
    return { ...body, rotated: Boolean(body?.rotated) };
  } catch (error) {
    return {
      rotated: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
