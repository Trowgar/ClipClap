import { isPermanentTelegramError } from "@clipclap/shared";
import { TelegramApiError } from "./telegram-client";

/** What a failed send means for what happens next.
 *
 *  There is no `clip-permanent` here on purpose: a clip that can never be sent
 *  (gone from storage, or over the upload ceiling) is caught before anything is
 *  sent, so this function only ever sees failures that came back from an actual
 *  send attempt. */
export type SendFailureKind = "chat-permanent" | "transient" | "ambiguous";

/** Did Telegram answer, and if so, was the answer about the chat?
 *
 *  A parsed refusal (TelegramApiError) proves the call did not take effect, so
 *  a retry cannot duplicate. Anything else means no response arrived, the send
 *  may have landed, and a retry risks a duplicate - the "ambiguous" case, which
 *  the design accepts on purpose because a missing clip costs the user minutes
 *  they already paid while a duplicate costs them a scroll. */
export function classifySendFailure(error: unknown): SendFailureKind {
  if (!(error instanceof TelegramApiError)) return "ambiguous";
  return isPermanentTelegramError(error.message) ? "chat-permanent" : "transient";
}
