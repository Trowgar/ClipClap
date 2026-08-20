import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { copyObject } from "../lib/r2";
import { sendTelegramMessage } from "./telegram-notification.service";
import type {
  FeedbackReason,
  FeedbackSurface,
  FeedbackVerdict,
} from "../config/feedback";

/** Where a permanent copy of a rated clip lives. Outside every retention rule
 *  by construction: the sweep selects on Clip rows, and nothing sweeps this
 *  prefix. */
export const FEEDBACK_EVIDENCE_PREFIX = "feedback/";

/** Transcript text is stored for the agent to read, not for exact replay.
 *  4000 characters is roughly a five-minute window and keeps a pathological
 *  source from putting a megabyte into every row. */
const TRANSCRIPT_CAP = 4000;

export interface RecordClipFeedbackInput {
  clipId: string;
  userId: string;
  surface: FeedbackSurface;
  /** Omitted when the caller is only attaching a reason or a note. */
  verdict?: FeedbackVerdict;
  /** Omitted when the caller is only setting a verdict. */
  reason?: FeedbackReason;
  /** Free text: a Telegram reply, or the web field. */
  note?: string;
  locale?: string | null;
}

export type RecordClipFeedbackResult =
  | { ok: true; verdict: string | null; reason: string | null }
  | { ok: false; code: "NOT_FOUND" };

interface TranscriptSegment {
  start?: number;
  end?: number;
  text?: string;
}

/** Text of every segment that overlaps the clip window, joined and capped. */
export function sliceTranscript(
  transcriptJson: unknown,
  startTime: number,
  endTime: number
): string | null {
  const segments = (transcriptJson as { segments?: TranscriptSegment[] })
    ?.segments;
  if (!Array.isArray(segments)) return null;

  const text = segments
    .filter(
      (s) =>
        typeof s.start === "number" &&
        typeof s.end === "number" &&
        s.end > startTime &&
        s.start < endTime
    )
    .map((s) => (s.text ?? "").trim())
    .filter(Boolean)
    .join(" ");

  if (!text) return null;
  return text.length <= TRANSCRIPT_CAP ? text : text.slice(0, TRANSCRIPT_CAP);
}

/** A cropPlan is large and mostly per-frame noise. What a framing complaint is
 *  actually read against is: how many keyframes, which layout, and whether the
 *  crop moved at all. */
function digestCropPlan(cropPlan: unknown): Record<string, unknown> | null {
  if (!cropPlan || typeof cropPlan !== "object") return null;
  const plan = cropPlan as { keyframes?: unknown[]; layout?: unknown };
  const keyframes = Array.isArray(plan.keyframes) ? plan.keyframes.length : 0;
  return {
    keyframes,
    layout: typeof plan.layout === "string" ? plan.layout : null,
    static: keyframes <= 1,
  };
}

/** The only writer of clip_feedback.
 *
 *  Ownership is checked on the clip row, not taken from the caller: clipId
 *  arrives from a Telegram callback or an HTTP body on both surfaces and is
 *  forgeable.
 *
 *  Nothing here throws for an operational failure. A tap has already been
 *  acknowledged by the time this runs, and losing an answer is worse than
 *  losing an evidence copy. */
export async function recordClipFeedback(
  input: RecordClipFeedbackInput
): Promise<RecordClipFeedbackResult> {
  const clip = await prisma.clip.findFirst({
    where: { id: input.clipId, userId: input.userId },
    select: {
      id: true,
      jobId: true,
      userId: true,
      title: true,
      storageKey: true,
      duration: true,
      startTime: true,
      endTime: true,
      score: true,
      clipKind: true,
      lowQuality: true,
      hookStart: true,
      hookEnd: true,
      payoffAt: true,
      cropPlan: true,
      job: {
        select: {
          analyzeEngine: true,
          highlightsVersion: true,
          language: true,
          sourceDurationSec: true,
          transcriptJson: true,
        },
      },
    },
  });
  if (!clip) return { ok: false, code: "NOT_FOUND" };

  const existing = await prisma.clipFeedback.findUnique({
    where: { clipId_userId: { clipId: clip.id, userId: input.userId } },
    select: { id: true, evidenceKey: true, verdict: true },
  });

  let evidenceKey = existing?.evidenceKey ?? null;
  if (!evidenceKey && clip.storageKey) {
    const destination = `${FEEDBACK_EVIDENCE_PREFIX}${clip.id}.mp4`;
    try {
      await copyObject(clip.storageKey, destination);
      evidenceKey = destination;
    } catch (error) {
      // The object may already be swept. Feedback on an old clip is still
      // worth having; a tap is never refused because the video expired.
      console.warn(
        `[feedback] evidence copy failed for ${clip.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  const snapshot = {
    title: clip.title,
    startTime: clip.startTime,
    endTime: clip.endTime,
    duration: clip.duration,
    score: clip.score,
    clipKind: clip.clipKind,
    lowQuality: clip.lowQuality,
    hookStart: clip.hookStart,
    hookEnd: clip.hookEnd,
    payoffAt: clip.payoffAt,
    analyzeEngine: clip.job?.analyzeEngine ?? null,
    highlightsVersion: clip.job?.highlightsVersion ?? null,
    language: clip.job?.language ?? null,
    sourceDurationSec: clip.job?.sourceDurationSec ?? null,
    cropPlan: digestCropPlan(clip.cropPlan),
    transcript: sliceTranscript(
      clip.job?.transcriptJson,
      clip.startTime,
      clip.endTime
    ),
  };

  // A verdict change invalidates the reason it was given under; a note arrives
  // on its own path and must survive one. Hence three separate partial updates
  // rather than one object with undefined holes.
  const update: Prisma.ClipFeedbackUpdateInput = {
    surface: input.surface,
    snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
    evidenceKey,
  };
  if (input.verdict !== undefined) {
    update.verdict = input.verdict;
    update.reason = null;
  }
  if (input.reason !== undefined) update.reason = input.reason;
  if (input.note !== undefined) update.note = input.note;
  if (input.locale !== undefined) update.locale = input.locale ?? null;

  const row = await prisma.clipFeedback.upsert({
    where: { clipId_userId: { clipId: clip.id, userId: input.userId } },
    create: {
      clipId: clip.id,
      jobId: clip.jobId,
      userId: input.userId,
      surface: input.surface,
      // A note-only or reason-only first touch is possible (a reply before any
      // tap). "NO" would be a lie and "AS_IS" flattery, so the column carries
      // the honest empty string and the digest reports it as "no verdict".
      verdict: input.verdict ?? "",
      reason: input.reason ?? null,
      note: input.note ?? null,
      snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
      evidenceKey,
      locale: input.locale ?? null,
    },
    update,
  });

  // Upsert keeps no history, and at this volume a change of mind is itself a
  // signal. One line, deliberately cheap.
  console.log(
    `[feedback] ${input.surface} clip=${clip.id} user=${input.userId} ` +
      `verdict=${existing?.verdict ?? "-"}->${input.verdict ?? "(unchanged)"} ` +
      `reason=${input.reason ?? "-"} note=${input.note ? "yes" : "no"}`
  );

  if (input.note) await relayToOwner(clip.title, input, row.id);

  return {
    ok: true,
    verdict: input.verdict ?? existing?.verdict ?? null,
    reason: input.reason ?? null,
  };
}

/** Text is rare and is the most valuable thing this system collects, so it goes
 *  straight to the owner rather than waiting for a digest. Bare taps do not:
 *  twelve clips per job would make that a firehose. */
async function relayToOwner(
  clipTitle: string,
  input: RecordClipFeedbackInput,
  feedbackId: string
): Promise<void> {
  const chat = process.env.SUPPORT_CHAT_ID?.trim();
  if (!chat) return;
  const lines = [
    `Clip feedback (${input.surface})`,
    `Clip: ${clipTitle}`,
    `Verdict: ${input.verdict ?? "-"}  Reason: ${input.reason ?? "-"}`,
    "",
    input.note ?? "",
    "",
    `clipId ${input.clipId} - feedbackId ${feedbackId}`,
  ];
  // sendTelegramMessage swallows its own failures and reports them as false, so
  // there is nothing to catch here - only a boolean worth logging. A lost relay
  // costs a notification, never the feedback row, which is already written.
  const sent = await sendTelegramMessage(chat, lines.join("\n"));
  if (!sent) {
    console.warn(`[feedback] relay to the owner failed for ${input.clipId}`);
  }
}
