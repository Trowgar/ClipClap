import { Prisma } from "@prisma/client";
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
  /** Bot: the plans-and-prices screen was shown to somebody.
   *
   *  Added 2026-08-23 because the whole revenue question sat in an unlit gap.
   *  Twelve checkouts had been opened and none completed, and nothing recorded
   *  what happened before the order row: a person who looked at the prices and
   *  walked away and a person who never saw them at all were the same absence
   *  of data. With this, PLANS_OPENED -> CHECKOUT_STARTED is the price
   *  question, and CHECKOUT_STARTED -> a paid order is the Tribute-page
   *  question. Five people were asked what stopped them and none answered, so
   *  the answer has to be recorded rather than requested. */
  PLANS_OPENED: "plans_opened",
  /** Bot: a plan button was tapped, an order exists, and the pay link has been
   *  handed over. `tribute_orders` already holds the row; this is here so the
   *  step is readable in the same table as the ones on either side of it, and
   *  so the reused-fresh-order path (a second tap within 15 minutes) counts as
   *  the intent it is rather than vanishing for want of a new row. */
  CHECKOUT_STARTED: "checkout_started",
  /** Bot: creating the order at Tribute threw, and the person was shown an
   *  error instead of a pay link.
   *
   *  Until 2026-08-23 this went to console.error and nowhere else, which means
   *  a failure on OUR side of the checkout was indistinguishable from a person
   *  changing their mind - the two possibilities the whole revenue diagnosis
   *  hangs on. */
  CHECKOUT_ERROR: "checkout_error",
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
  /** Both: a submission was accepted into the queue (not refused) because a
   *  job was already running. Counts people who ever waited; the jobs table
   *  holds the how-often. NOT a refusal - upload_rejected_concurrent stops
   *  being written the day the flag turns on. */
  VIDEO_QUEUED: "video_queued",
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
  /** Under SOURCE_FLOOR.minDurationSec - see plans.ts for the numbers. */
  | "TOO_SHORT"
  /** Telegram media groups - one album is rejected as a unit. */
  | "MEDIA_GROUP"
  /** The same source again while its job runs, or after it finished with clips
   *  still in storage (which are handed back instead). findDuplicateJob. */
  | "DUPLICATE"
  | "DAILY_LIMIT"
  | "CONCURRENT"
  | "PROBE_FAILED"
  /** The per-user submit lock was held by somebody else for longer than we wait
   *  for it. Not a limit and not the user's fault - the honest answer is "try
   *  again in a moment" - but it IS a refusal, and it used to be an uncaught
   *  P2028 that reached the browser as a 500 and left no row here at all. */
  | "BUSY"
  /** Anything else the submit path threw. A catch-all exists so that a bare 500
   *  is never again invisible in the funnel; if this stops being near zero, the
   *  logs beside it name the actual error. */
  | "SUBMIT_FAILED";

const REJECTION_SUFFIX: Record<UploadRejectionCode, string> = {
  FREE_NOT_ANCHORED: "free_not_anchored",
  FREE_EXHAUSTED: "free_exhausted",
  FREE_SOURCE_TOO_LONG: "free_too_long",
  FREE_BUDGET_CLOSED: "free_budget_closed",
  QUOTA: "quota",
  LIFECYCLE: "lifecycle",
  TOO_LONG: "too_long",
  TOO_SHORT: "too_short",
  MEDIA_GROUP: "media_group",
  DUPLICATE: "duplicate",
  DAILY_LIMIT: "daily_limit",
  CONCURRENT: "concurrent",
  PROBE_FAILED: "probe_failed",
  BUSY: "busy",
  SUBMIT_FAILED: "submit_failed",
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
 * The event name for a stranger who reached the bot through a tagged link, e.g.
 * "bot_start_src_tg_clipperschat" from `t.me/clipclapio_bot?start=src_tg_clipperschat`.
 *
 * It exists because until 2026-08-20 the bot silently discarded every start payload it did not
 * recognise, so a bought placement and an organic arrival were indistinguishable - which makes
 * any paid test unmeasurable and therefore not worth running. `site_visits` cannot cover this:
 * it instruments the web app, and a Telegram ad never touches the web app at all.
 *
 * The slug is sanitised by the caller rather than here, because an event name is a database key
 * and an unbounded one lets a stranger write arbitrary rows by editing a link.
 */
export function campaignStartEvent(slug: string): string {
  return `bot_start_src_${slug}`;
}

/** Lowercase, [a-z0-9_-] only, 32 characters at most - or null if nothing survives. */
export function sanitiseCampaignSlug(raw: string): string | null {
  const slug = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  return slug.length ? slug : null;
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

/**
 * The per-code shape of `upload_refusals.detail`. Loose on purpose - it is a
 * JSON column read by hand in SQL - but every key here is one somebody has
 * already needed and not had:
 *
 *   PROBE_FAILED          url, host, reason (source-probe's), error (yt-dlp's
 *                         last ERROR line), rotation {reason, previousIp, ip}
 *   FREE_EXHAUSTED        durationSec, remainingSec, lifetimeSec
 *   FREE_SOURCE_TOO_LONG  durationSec, maxMinutes
 *   TOO_LONG              durationSec, maxMinutes
 *   TOO_SHORT             durationSec, minSec
 *   DUPLICATE             fingerprint, priorJobId, priorStatus, resent (clips)
 *   QUOTA                 durationSec, usedMinutes, limitMinutes, topUpMinutes
 *   LIFECYCLE             phase
 *   DAILY_LIMIT           jobsToday, limit
 *   CONCURRENT            inFlight, limit
 *   BUSY, SUBMIT_FAILED   error (message) when there is one
 *   plus `durationSec` and `source: "url" | "file"` wherever the caller knows.
 */
export type RefusalDetail = Record<string, unknown>;

/** Hostname of a submitted URL, lowercased, without `www.` - or null when the
 *  string does not parse. Cheap to store, and "which sites do people paste"
 *  is the first question a probe-failure query asks. */
export function refusalHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * Records a refused submission TWICE, on purpose: the people-count in
 * funnel_events (unchanged) and one row in upload_refusals with the detail.
 * Every `upload_rejected_*` call site should go through here, so the two
 * cannot disagree about what counts as a refusal.
 *
 * NEVER THROWS, for the same reason as recordFunnelEvent - and each half is
 * guarded separately, so a Prisma client that predates the upload_refusals
 * migration still records the funnel step it always did.
 */
export async function recordUploadRefusal(
  surface: FunnelSurface,
  subjectId: string | number,
  code: UploadRejectionCode,
  detail?: RefusalDetail,
  locale?: string | null
): Promise<void> {
  await recordFunnelEvent(surface, subjectId, uploadRejectedEvent(code), locale);
  try {
    await prisma.uploadRefusal.create({
      data: {
        surface,
        subjectId: String(subjectId),
        code,
        // Prisma's Json input rejects `undefined` values inside the object;
        // stripping them here keeps callers free to pass optional fields.
        detail: detail
          ? (JSON.parse(JSON.stringify(detail)) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        locale: locale ?? null,
      },
    });
  } catch (error) {
    console.error(
      `Refusal ledger: could not record ${code} for ${surface}:${subjectId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
