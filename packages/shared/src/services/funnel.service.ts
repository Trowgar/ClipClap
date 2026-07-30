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
  /** Bot only: the welcome screen was shown to somebody with no account.
   *
   *  The string is unchanged so the history stays continuous, but what it counts
   *  has narrowed: it used to mean "was shown the two-button New account / I
   *  already have one prompt", and that prompt is gone. It is now simply the top
   *  of the bot funnel - a stranger typed /start. No User row exists at this
   *  point, which is the whole reason the step is worth recording: `signed_up`
   *  cannot see these people. */
  FIRST_SCREEN: "start_first_screen",
  /** Bot only: an account was linked from inside the bot.
   *
   *  Emitted by /link and by the Settings button that replaced the first
   *  screen's "I already have an account". The literal is unchanged because the
   *  question it answers - how many people join a web account to a Telegram one
   *  - is unchanged, and rewriting it would split the series in two. */
  LINK_ACCOUNT: "first_screen_link_account",
  /** Bot only: tapped "Find advertisers" under 💰 Earn.
   *
   *  The offer behind it is not built. The button exists to price the decision:
   *  a count of taps is evidence about whether to build the brokerage at all,
   *  which is cheaper to collect than the brokerage is to write. */
  EARN_ADVERTISERS: "earn_advertisers_tapped",
  /** Both: a User row was created for this person.
   *
   *  Not the same question as FIRST_SCREEN, which is about one
   *  screen in one surface. This is "an account now exists", wherever it came
   *  from: the web register form, a Google or Telegram sign-in the adapter
   *  created a row for, a referral deep link that skips the onboarding screen.
   *  Without it, `users` is a running total with no dates a funnel can slice. */
  SIGNED_UP: "signed_up",
  /** Web only: a verification link was opened and the address is now confirmed.
   *
   *  The pair SIGNED_UP -> EMAIL_VERIFIED is what makes the "Confirm your
   *  email" wall countable. Before it, a person who registered, met the panel
   *  and left emitted one `app_opened` and was indistinguishable from a
   *  verified user idling on the dashboard. There is no bot equivalent: a
   *  Telegram account is anchored by its phone-backed id and is never asked to
   *  confirm anything. */
  EMAIL_VERIFIED: "email_verified",
  /** Both: bot main menu rendered / web dashboard loaded. */
  APP_OPENED: "app_opened",
  /** Both: an attempt to create a job, recorded before the limit checks. */
  VIDEO_SUBMITTED: "video_submitted",
} as const;

export type FunnelEvent = string;
export type FunnelSurface = "bot" | "web";

/** Refusal codes: the shared canSubmitJob ones plus the route-level checks.
 *
 *  `trial_used` and `trial_attempts` were retired here when the gate moved from
 *  counting jobs to spending the free_usage ledger. Rows already written under
 *  those names are untouched and still readable - the column is a String, so
 *  retiring a code in this file does not rewrite the past. Anyone reading the
 *  funnel across that boundary has to union the old suffixes with
 *  `free_exhausted` by hand. */
export type UploadRejectionCode =
  | "FREE_NOT_ANCHORED"
  | "FREE_EXHAUSTED"
  | "FREE_SOURCE_TOO_LONG"
  | "FREE_BUDGET_CLOSED"
  | "QUOTA"
  | "LIFECYCLE"
  | "TOO_LONG"
  | "DAILY_LIMIT"
  | "CONCURRENT"
  | "PROBE_FAILED";

const REJECTION_SUFFIX: Record<UploadRejectionCode, string> = {
  FREE_NOT_ANCHORED: "free_not_anchored",
  FREE_EXHAUSTED: "free_exhausted",
  FREE_SOURCE_TOO_LONG: "free_too_long",
  FREE_BUDGET_CLOSED: "free_budget_closed",
  QUOTA: "quota",
  LIFECYCLE: "lifecycle",
  TOO_LONG: "too_long",
  DAILY_LIMIT: "daily_limit",
  CONCURRENT: "concurrent",
  PROBE_FAILED: "probe_failed",
};

/**
 * READ BEFORE CHASING A ZERO: `upload_rejected_free_not_anchored` is expected
 * to stay at or near zero, and that is not a bug in the recording.
 *
 * The dashboard replaces the upload form with the "Confirm your email" panel
 * for exactly the accounts that would earn this code, so the submit route is
 * unreachable from the UI for them; the only callers left are direct API
 * clients. On `bot` it is unreachable by construction - a Telegram account is
 * anchored by its phone-backed id.
 *
 * It is deliberately NOT synthesised from the panel being rendered. The panel
 * is drawn on every dashboard load, so counting it here would turn a refusal
 * count into a page-view count under a name that says "rejected", and the two
 * would then disagree with the web route's own row for the same code. The wall
 * IS measured, by the pair that was added for it: everyone with SIGNED_UP and
 * no EMAIL_VERIFIED is a person sitting behind it. Keep the recording in the
 * route - it is the honest record of an API refusal and it comes back the day
 * the dashboard stops hiding the form.
 */

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
