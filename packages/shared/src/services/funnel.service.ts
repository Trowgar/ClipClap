import { prisma } from "../lib/prisma";

/**
 * Funnel steps for the Telegram bot and the web app.
 *
 * Only the steps that are otherwise invisible live here. Job creation, clip
 * delivery, zero-clip outcomes and repeat use are NOT events: they are already
 * rows in `jobs`, `telegram_deliveries` and `clips`, and a second counter would
 * drift from them. Repeat attempts come from `occurrences` on VIDEO_SUBMITTED.
 *
 * The values are wire format. They are written to a String column and read by
 * hand in SQL, so they must not be renamed casually.
 */
export const FUNNEL_EVENTS = {
  /** Bot only: the two-button screen was shown to somebody with no account. */
  FIRST_SCREEN: "start_first_screen",
  /** Bot only: pressed "New account". */
  NEW_ACCOUNT: "first_screen_new_account",
  /** Bot only: pressed "Link account". */
  LINK_ACCOUNT: "first_screen_link_account",
  /** Both: bot main menu rendered / web dashboard loaded. */
  APP_OPENED: "app_opened",
  /** Both: an attempt to create a job, recorded before the limit checks. */
  VIDEO_SUBMITTED: "video_submitted",
} as const;

export type FunnelEvent = string;
export type FunnelSurface = "bot" | "web";

/** Refusal codes: the shared canSubmitJob ones plus the route-level checks. */
export type UploadRejectionCode =
  | "FREE_TRIAL_USED"
  | "FREE_TRIAL_ATTEMPTS"
  | "FREE_SOURCE_TOO_LONG"
  | "QUOTA"
  | "LIFECYCLE"
  | "TOO_LONG"
  | "DAILY_LIMIT"
  | "CONCURRENT";

const REJECTION_SUFFIX: Record<UploadRejectionCode, string> = {
  FREE_TRIAL_USED: "trial_used",
  FREE_TRIAL_ATTEMPTS: "trial_attempts",
  FREE_SOURCE_TOO_LONG: "free_too_long",
  QUOTA: "quota",
  LIFECYCLE: "lifecycle",
  TOO_LONG: "too_long",
  DAILY_LIMIT: "daily_limit",
  CONCURRENT: "concurrent",
};

/** The event name for a refusal, e.g. "upload_rejected_quota". */
export function uploadRejectedEvent(code: UploadRejectionCode): string {
  return `upload_rejected_${REJECTION_SUFFIX[code]}`;
}

/**
 * Records that `subjectId` reached `event` on `surface`. Counts people, not
 * presses: the row is unique per (surface, subjectId, event) and a repeat
 * bumps `occurrences`.
 *
 * NEVER THROWS, and never rejects. This is called on a stranger's first
 * interaction with the product, and a telemetry write that can turn that
 * interaction into silence is worse than having no telemetry at all. The
 * swallow lives here rather than at each call site so no caller can forget it -
 * but it logs, so a suspiciously flat funnel can be traced to failing writes
 * instead of to a dead product.
 *
 * Callers must still await it AFTER the user has been answered, not before.
 */
export async function recordFunnelEvent(
  surface: FunnelSurface,
  subjectId: string | number,
  event: FunnelEvent,
  locale?: string | null
): Promise<void> {
  try {
    const id = String(subjectId);
    await prisma.funnelEvent.upsert({
      where: { surface_subjectId_event: { surface, subjectId: id, event } },
      create: { surface, subjectId: id, event, locale: locale ?? null },
      update: {
        occurrences: { increment: 1 },
        lastSeenAt: new Date(),
        ...(locale ? { locale } : {}),
      },
    });
  } catch (error) {
    // Includes the case where the Prisma client in this container predates the
    // migration and `funnelEvent` is undefined - a synchronous TypeError,
    // caught here as well because the throw happens inside the try.
    console.error(
      `Funnel telemetry: could not record ${event} for ${surface}:${subjectId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
