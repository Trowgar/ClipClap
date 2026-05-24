import { execFile } from "child_process";
import type { ChildProcess } from "child_process";

export function extractVideoUrl(text: string): string | null {
  const m = /https?:\/\/\S+/.exec(text);
  return m ? m[0] : null;
}

export type ProbeResult =
  | { ok: true; durationSec: number; title: string }
  | { ok: false; reason: "timeout" | "yt-dlp-error" | "no-duration" };

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
