/** Per-clip feedback vocabulary and kill switches.
 *
 *  Deliberately import-free: the bot, the web routes, the admin page and the
 *  digest script all read it, and a stray import here has cost this repo a
 *  suite of mocked tests before.
 *
 *  The codes are plain string unions rather than Prisma enums for the same
 *  reason funnel_events and upload_refusals use strings: adding a verdict or a
 *  reason must not be a migration on a table the request path writes to. */

export const FEEDBACK_VERDICTS = ["AS_IS", "EDIT", "NO"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const FEEDBACK_REASONS = [
  "BORING",
  "CUTOFF",
  "FRAMING",
  "SUBS",
  "QUALITY",
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export type FeedbackSurface = "bot" | "web";

export function isFeedbackVerdict(value: string): value is FeedbackVerdict {
  return (FEEDBACK_VERDICTS as readonly string[]).includes(value);
}

export function isFeedbackReason(value: string): value is FeedbackReason {
  return (FEEDBACK_REASONS as readonly string[]).includes(value);
}

/** Fail-closed, exactly like SUBMISSION_QUEUE.
 *
 *  This gates RENDERING, not acceptance. Keyboards already sitting in other
 *  people's Telegram chats cannot be recalled, so the callback handler keeps
 *  recording after the switch is thrown - otherwise those chats fill with
 *  buttons that answer with an error. The web has no stale-button problem but
 *  behaves the same way so both surfaces have one contract. */
export function isClipFeedbackEnabled(surface: FeedbackSurface): boolean {
  const raw =
    surface === "bot"
      ? process.env.CLIP_FEEDBACK_BOT
      : process.env.CLIP_FEEDBACK_WEB;
  return raw === "on";
}
