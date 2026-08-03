import { execFile } from "child_process";
import type { ChildProcess } from "child_process";
import { isBotCheckFailure, proxyArgs, rotateWarpExit } from "./ytdlp-proxy";

export function extractVideoUrl(text: string): string | null {
  const m = /https?:\/\/\S+/.exec(text);
  return m ? m[0] : null;
}

/** Is this a YouTube link?
 *
 *  Exists so a failed probe can say WHICH failure it was. YouTube refuses this
 *  host's IP ("Sign in to confirm you're not a bot") for every ordinary video,
 *  measured over v4 and v6 alike, while TikTok and Twitch extract fine. Every
 *  link a real bot user has ever submitted died on that refusal, and the copy
 *  they got told them to try another link - so they did, five times, three
 *  times, twice, and left.
 *
 *  Host-suffix matching, never `includes`: `youtube.com.evil.test` and a
 *  `?next=youtube.com` query must not be read as YouTube. A malformed URL is
 *  not YouTube - it is just a bad link, and gets the generic message. */
export function isYouTubeUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  );
}

export type ProbeResult =
  | { ok: true; durationSec: number; title: string }
  // "yt-dlp-error" stays specific to the URL probe; "probe-error" is the local
  // ffprobe failure. Callers that only branch on `ok` are unaffected, and
  // nothing gets to blame yt-dlp for a file it never saw.
  //
  // "probe-unavailable" is the binary missing from PATH. It must not share a
  // reason with a dead link: a container without yt-dlp would otherwise tell
  // every user "check the link is public" while the gate silently never runs -
  // wrong message to them, no signal to us. This one is our fault, not theirs.
  | {
      ok: false;
      reason:
        | "timeout"
        | "yt-dlp-error"
        | "no-duration"
        | "probe-error"
        | "probe-unavailable";
    };

/** execFile reports a binary that is not on PATH as ENOENT on the callback
 *  error, which is an operational fault rather than anything the submitter
 *  did. Logged with the binary name so it is greppable. */
function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** One probe attempt. `probeVideoUrl` wraps this with the rotate-and-retry. */
function probeOnce(
  url: string,
  timeoutMs: number
): Promise<{ result: ProbeResult; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const timerRef = { id: undefined as ReturnType<typeof setTimeout> | undefined };

    const finish = (result: ProbeResult, stderr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timerRef.id);
      resolve({ result, stderr });
    };

    const child: ChildProcess = execFile(
      "yt-dlp",
      [
        // Proxy first so it is visible at the head of any logged command line.
        // Empty when unconfigured, which is the pre-WARP behaviour exactly.
        ...proxyArgs(),
        "--simulate",
        "--no-playlist",
        "--print",
        "%(duration)s||%(title)s",
        "--socket-timeout",
        "10",
        url,
      ],
      { timeout: timeoutMs + 1000 },
      // stderr is READ now, where it used to be dropped: it carries the bot
      // check, and without it a refused exit is indistinguishable from a dead
      // link - so nothing could ever decide to rotate.
      (err, stdout, stderr) => {
        if (err) {
          if (isMissingBinary(err)) {
            console.error(
              "[source-probe] yt-dlp is not on PATH in this container; " +
                "URL probing is unavailable and no duration can be enforced"
            );
            finish({ ok: false, reason: "probe-unavailable" });
            return;
          }
          finish({ ok: false, reason: "yt-dlp-error" }, stderr ?? "");
          return;
        }
        const line = stdout.split("\n").find((l) => l.trim().length > 0);
        if (!line) {
          finish({ ok: false, reason: "no-duration" });
          return;
        }
        const [durRaw, ...titleParts] = line.split("||");
        const durationSec = Number(durRaw);
        if (!Number.isFinite(durationSec) || durationSec <= 0) {
          finish({ ok: false, reason: "no-duration" });
          return;
        }
        finish({
          ok: true,
          durationSec,
          title: titleParts.join("||").trim() || "Untitled",
        });
      }
    );

    timerRef.id = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
}

export interface ProbeOptions {
  /** How long to wait for WARP to hand back a new exit, or 0 to skip rotation.
   *
   *  Exists because the two callers have very different patience. The bot is
   *  asynchronous - the user has been told "checking your link" and a slow
   *  answer still lands in their chat - so it can afford the control server's
   *  full worst case. `/api/jobs` is a BLOCKING HTTP request with a browser and
   *  a person on the other end, and an 80-second POST reads as a hang and
   *  invites a double submit. */
  rotateBudgetMs?: number;
}

export function probeVideoUrl(
  url: string,
  timeoutMs = 10_000,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  return probeWithRotation(url, timeoutMs, options.rotateBudgetMs ?? 120_000);
}

/** Probe, and on a bot check ask WARP for a new exit and probe once more.
 *
 *  ONE retry, not a loop. The control server already coalesces concurrent
 *  callers and enforces a cooldown, so a loop here would mostly spin against a
 *  refusal it is not allowed to fix - while holding open the request the bot
 *  user is waiting on. If one fresh exit is also refused, the honest answer is
 *  that the link failed.
 *
 *  Retrying only when the exit MOVED matters: `rotated` is false for a cooldown
 *  hit or an unreachable control server, and re-running the same probe against
 *  the same address would just double the user's wait for the same refusal. */
async function probeWithRotation(
  url: string,
  timeoutMs: number,
  rotateBudgetMs: number
): Promise<ProbeResult> {
  const first = await probeOnce(url, timeoutMs);
  if (first.result.ok || !isBotCheckFailure(first.stderr)) {
    return first.result;
  }
  if (rotateBudgetMs <= 0) return first.result;

  console.warn(
    "[source-probe] exit refused as a bot; asking WARP to rotate and retrying once"
  );
  const rotation = await rotateWarpExit(rotateBudgetMs);
  if (!rotation.rotated) {
    console.warn(
      `[source-probe] rotation did not move the exit (${rotation.reason ?? "unknown"}); ` +
        "reporting the original failure"
    );
    return first.result;
  }

  console.warn(
    `[source-probe] rotated ${rotation.previousIp ?? "?"} -> ${rotation.ip ?? "?"}, re-probing`
  );
  const second = await probeOnce(url, timeoutMs);
  return second.result;
}

/** Duration of a local file. Used for uploads, where there is no URL to ask. */
export function probeLocalFile(path: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          if (isMissingBinary(err)) {
            console.error(
              "[source-probe] ffprobe is not on PATH in this container; " +
                "local file probing is unavailable"
            );
            resolve({ ok: false, reason: "probe-unavailable" });
            return;
          }
          resolve({ ok: false, reason: "probe-error" });
          return;
        }
        const durationSec = Number(stdout.trim());
        if (!Number.isFinite(durationSec) || durationSec <= 0) {
          resolve({ ok: false, reason: "no-duration" });
          return;
        }
        resolve({ ok: true, durationSec, title: "Upload" });
      }
    );
  });
}
