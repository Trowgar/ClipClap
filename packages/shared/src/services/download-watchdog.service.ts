import { prisma } from "../lib/prisma";
import { getRedis } from "../lib/redis";
import { sendTelegramMessage } from "./telegram-notification.service";

/**
 * How far back the watchdog looks for link submissions.
 *
 * 24 hours, not "since the last run" (hourly): a short blip that clears
 * within the hour must not get diluted towards zero by a wide window of
 * healthy jobs and hide a real, sustained outage. A full day is also the
 * natural unit an owner reasons in when asking "did anything work today".
 */
export const WATCHDOG_WINDOW_HOURS = 24;

/**
 * How long the watchdog stays quiet after it fires, even if the condition it
 * alerted on is still true an hour later.
 *
 * Without this, an unresolved outage pages the owner every hour for as long
 * as it lasts, which trains them to ignore the very channel this feature
 * depends on - the exact failure mode ("nobody noticed for three days")
 * that this feature exists to prevent, one level up.
 */
export const WATCHDOG_SUPPRESS_HOURS = 6;

/**
 * How much of a failed job's stored error rides along in the alert. These
 * strings can carry an entire yt-dlp command line and its output, and the
 * point of including one at all is to save the reader a database session -
 * not to reproduce the whole failure inside a chat message.
 */
const ERROR_EXCERPT_LENGTH = 200;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The Redis key that remembers "already alerted, still cooling down". A TTL
 * key rather than a database column, on purpose: it needs no migration, and
 * it self-heals - if Redis is ever flushed, the worst case is one extra
 * alert, never a stuck suppression that silences the watchdog for good.
 */
export const DOWNLOAD_WATCHDOG_SUPPRESS_KEY = "download-watchdog:suppress-until";

export function watchdogWindowCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - WATCHDOG_WINDOW_HOURS * MS_PER_HOUR);
}

export interface DownloadWatchdogResult {
  /** Link jobs (sourceUrl not null) created inside the window. */
  submitted: number;
  /** Of those, how many reached DONE. */
  done: number;
  /** Of those, how many are FAILED. A job still mid-pipeline is neither. */
  failed: number;
  /** True only when a Telegram message was actually sent on this run. */
  alerted: boolean;
}

/**
 * The error string that recurs most often among the failed jobs, so the
 * alert can show ONE representative line instead of a wall of duplicates -
 * in practice, almost every failure inside a real outage is the identical
 * yt-dlp refusal, repeated across users and retries. Ties keep whichever
 * error was seen first, which is deterministic and good enough: the job of
 * this function is to name A real recurring error, not to rank them.
 */
function mostCommonError(rows: { error: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.error) continue;
    counts.set(row.error, (counts.get(row.error) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [error, count] of counts) {
    if (count > bestCount) {
      best = error;
      bestCount = count;
    }
  }
  return best;
}

function buildAlertMessage(
  submitted: number,
  failed: number,
  commonError: string | null
): string {
  const errorLine = commonError
    ? `Most common error: ${commonError.slice(0, ERROR_EXCERPT_LENGTH)}`
    : "No error text was captured for the failed jobs.";
  return (
    `⚠️ Link downloads look broken: ${submitted} submitted in the last ` +
    `${WATCHDOG_WINDOW_HOURS}h, ${failed} failed, 0 completed.\n\n${errorLine}`
  );
}

/**
 * Hourly check: over the last 24h, were any link submissions made, and did
 * NONE of them complete?
 *
 * WHY `submitted > 0` gates everything else. The failure this watchdog
 * exists to catch is "users are trying to submit links and it isn't
 * working" - not "nobody happened to submit a link". A quiet day with zero
 * link submissions is not evidence of anything, and alerting on it would
 * page the owner on every slow night, which is exactly the kind of noise
 * that gets a channel muted.
 *
 * WHY `done === 0`, not "every submission failed". At the moment this runs a
 * job can still be mid-pipeline (PENDING/DOWNLOADING/...) without having
 * reached FAILED yet - on a queue with retries and flap-wait parking that
 * can take hours, so requiring an explicit FAILED on every row would leave
 * a real outage unreported for as long as the last attempt takes to exhaust
 * its retries. "Not one submission has finished" is the earliest true
 * signal that the download path is dead.
 */
export async function runDownloadWatchdog(
  now: Date = new Date()
): Promise<DownloadWatchdogResult> {
  const cutoff = watchdogWindowCutoff(now);
  const jobs = await prisma.job.findMany({
    where: {
      sourceUrl: { not: null },
      createdAt: { gte: cutoff },
    },
    select: { status: true, error: true },
  });

  const submitted = jobs.length;
  const done = jobs.filter((job) => job.status === "DONE").length;
  const failedJobs = jobs.filter((job) => job.status === "FAILED");
  const failed = failedJobs.length;

  if (submitted === 0 || done > 0) {
    return { submitted, done, failed, alerted: false };
  }

  // Same rule as every other owner notification in this codebase (see
  // relayToOwner in clip-feedback.service.ts): an unset SUPPORT_CHAT_ID means
  // do nothing, silently, rather than throw or fall back to some other sink.
  const chat = process.env.SUPPORT_CHAT_ID?.trim();
  if (!chat) return { submitted, done, failed, alerted: false };

  const redis = getRedis();
  const suppressed = await redis.get(DOWNLOAD_WATCHDOG_SUPPRESS_KEY);
  if (suppressed) return { submitted, done, failed, alerted: false };

  const text = buildAlertMessage(submitted, failed, mostCommonError(failedJobs));
  const sent = await sendTelegramMessage(chat, text);
  if (sent) {
    // Only a CONFIRMED send starts the cooldown. A send that failed must not
    // buy six hours of silence on top of the outage it failed to report.
    await redis.set(
      DOWNLOAD_WATCHDOG_SUPPRESS_KEY,
      now.toISOString(),
      "EX",
      WATCHDOG_SUPPRESS_HOURS * 60 * 60
    );
  } else {
    console.warn(
      "[download-watchdog] alert send failed - will retry on the next hourly run"
    );
  }

  return { submitted, done, failed, alerted: sent };
}
