import type { FeedbackReason, FeedbackVerdict } from "@clipclap/shared";
import type { Dict } from "./i18n/types";

/** Telegram truncates callback_data past 64 BYTES, silently. Verdicts and
 *  reasons are therefore one-letter and one-digit codes rather than their full
 *  names: `fr:3:<cuid>` is 30 bytes where `fr:FRAMING:<cuid>` is 36 - both fit
 *  today, but the short form leaves room for a longer id later. */
const VERDICT_TO_CODE: Record<FeedbackVerdict, string> = {
  AS_IS: "a",
  EDIT: "e",
  NO: "n",
};
const CODE_TO_VERDICT: Record<string, FeedbackVerdict> = {
  a: "AS_IS",
  e: "EDIT",
  n: "NO",
};
const REASON_TO_CODE: Record<FeedbackReason, string> = {
  BORING: "1",
  CUTOFF: "2",
  FRAMING: "3",
  SUBS: "4",
  QUALITY: "5",
};
const CODE_TO_REASON: Record<string, FeedbackReason> = {
  "1": "BORING",
  "2": "CUTOFF",
  "3": "FRAMING",
  "4": "SUBS",
  "5": "QUALITY",
};

export function encodeVerdict(verdict: FeedbackVerdict, clipId: string): string {
  return `fb:${VERDICT_TO_CODE[verdict]}:${clipId}`;
}

export function encodeReason(reason: FeedbackReason, clipId: string): string {
  return `fr:${REASON_TO_CODE[reason]}:${clipId}`;
}

export type FeedbackCallback =
  | { kind: "verdict"; verdict: FeedbackVerdict; clipId: string }
  | { kind: "reason"; reason: FeedbackReason; clipId: string };

/** Null for anything that is not ours, including a well-formed prefix with an
 *  unknown code - the router must fall through to its other branches rather
 *  than swallow a stranger's callback. */
export function parseFeedbackCallback(data: string): FeedbackCallback | null {
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, code, clipId] = parts;
  if (!clipId) return null;

  if (prefix === "fb") {
    const verdict = CODE_TO_VERDICT[code];
    return verdict ? { kind: "verdict", verdict, clipId } : null;
  }
  if (prefix === "fr") {
    const reason = CODE_TO_REASON[code];
    return reason ? { kind: "reason", reason, clipId } : null;
  }
  return null;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}
export interface Keyboard {
  inline_keyboard: InlineButton[][];
}

/** One row - three short labels fit on a phone; the question lives in the
 *  caption. */
export function verdictKeyboard(clipId: string, dict: Dict): Keyboard {
  return {
    inline_keyboard: [
      [
        { text: dict.feedbackVerdictAsIs, callback_data: encodeVerdict("AS_IS", clipId) },
        { text: dict.feedbackVerdictEdit, callback_data: encodeVerdict("EDIT", clipId) },
        { text: dict.feedbackVerdictNo, callback_data: encodeVerdict("NO", clipId) },
      ],
    ],
  };
}

/** 2/2/1. Five in a row truncates to a few characters on a phone. */
export function reasonKeyboard(clipId: string, dict: Dict): Keyboard {
  return {
    inline_keyboard: [
      [
        { text: dict.feedbackReasonBoring, callback_data: encodeReason("BORING", clipId) },
        { text: dict.feedbackReasonCutoff, callback_data: encodeReason("CUTOFF", clipId) },
      ],
      [
        { text: dict.feedbackReasonFraming, callback_data: encodeReason("FRAMING", clipId) },
        { text: dict.feedbackReasonSubs, callback_data: encodeReason("SUBS", clipId) },
      ],
      [
        { text: dict.feedbackReasonQuality, callback_data: encodeReason("QUALITY", clipId) },
      ],
    ],
  };
}

/** Label for a reason code, for the confirmation line. */
export function reasonLabel(reason: FeedbackReason, dict: Dict): string {
  switch (reason) {
    case "BORING":
      return dict.feedbackReasonBoring;
    case "CUTOFF":
      return dict.feedbackReasonCutoff;
    case "FRAMING":
      return dict.feedbackReasonFraming;
    case "SUBS":
      return dict.feedbackReasonSubs;
    case "QUALITY":
      return dict.feedbackReasonQuality;
  }
}
