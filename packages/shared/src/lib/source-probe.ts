import { execFile } from "child_process";
import type { ChildProcess } from "child_process";

export function extractVideoUrl(text: string): string | null {
  const m = /https?:\/\/\S+/.exec(text);
  return m ? m[0] : null;
}

export type ProbeResult =
  | { ok: true; durationSec: number; title: string }
  // "yt-dlp-error" stays specific to the URL probe; "probe-error" is the local
  // ffprobe failure. Callers that only branch on `ok` are unaffected, and
  // nothing gets to blame yt-dlp for a file it never saw.
  | {
      ok: false;
      reason: "timeout" | "yt-dlp-error" | "no-duration" | "probe-error";
    };

export function probeVideoUrl(
  url: string,
  timeoutMs = 10_000
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timerRef = { id: undefined as ReturnType<typeof setTimeout> | undefined };

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerRef.id);
      resolve(result);
    };

    const child: ChildProcess = execFile(
      "yt-dlp",
      [
        "--simulate",
        "--no-playlist",
        "--print",
        "%(duration)s||%(title)s",
        "--socket-timeout",
        "10",
        url,
      ],
      { timeout: timeoutMs + 1000 },
      (err, stdout) => {
        if (err) {
          finish({ ok: false, reason: "yt-dlp-error" });
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
