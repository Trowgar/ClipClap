import { unlink } from "fs/promises";
import { getObjectSize, isPermanentTelegramError } from "@clipclap/shared";
import { TelegramApiError } from "./telegram-client";
import { downloadToFile } from "./clip-file";

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

const DEFAULT_UPLOAD_MAX_BYTES = 262_144_000;

function uploadMaxBytes(): number {
  const raw = Number(process.env.TELEGRAM_UPLOAD_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UPLOAD_MAX_BYTES;
}

/** Is this storage failure the object genuinely not being there?
 *
 *  Only that is permanent. Marking a clip unsendable is irreversible - it is
 *  never retried - so a transient 5xx, a credential blip or a network wobble
 *  must NOT reach that path: it would cost the user a clip they paid minutes
 *  for, with no retry and no way back. The ordinary retry budget is bounded
 *  anyway, so letting a wobble through costs at most a couple of minutes.
 *
 *  AWS SDK v3 signals a missing key as name "NotFound" with a 404; matching on
 *  the message text would be fooled by any error that happens to mention it. */
function isObjectGone(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

export interface DeliverableClip {
  id: string;
  storageKey: string;
  telegramFileId: string | null;
  telegramSendError: string | null;
}

export interface ClipDeliveryDeps {
  markSent(clipId: string, fileId: string | undefined): Promise<void>;
  markUnsendable(clipId: string, reason: string): Promise<void>;
}

export interface ClipDeliveryResult {
  /** Clips that reached the chat during THIS pass. */
  delivered: number;
  /** Still owed: no file id, no permanent verdict. The row stays re-pickable. */
  pending: number;
  /** Refused for good. Counted in the summary, never retried. */
  unsendable: number;
}

/** Send every clip that is not already in the chat, one at a time.
 *
 *  ONE CLIP'S FAILURE COSTS ONLY ITSELF. That is the defect this exists to fix:
 *  the previous loop had no per-clip catch, so the first refusal threw and every
 *  later clip - all deliverable - was never attempted.
 *
 *  SEQUENTIAL ON PURPOSE. Do not map this into Promise.all. Uploads are
 *  file-backed rather than buffered, but concurrency here would also multiply
 *  temp files and Telegram rate pressure, and the poller already serialises
 *  rows. */
export async function deliverClips<C extends DeliverableClip>(
  client: { sendVideoUpload(chatId: string | number, filePath: string, caption?: string): Promise<string | undefined> },
  chatId: string,
  clips: readonly C[],
  captionFor: (clip: C) => string,
  deps: ClipDeliveryDeps
): Promise<ClipDeliveryResult> {
  const result: ClipDeliveryResult = { delivered: 0, pending: 0, unsendable: 0 };
  const maxBytes = uploadMaxBytes();

  for (const clip of clips) {
    if (clip.telegramFileId) continue;
    if (clip.telegramSendError) {
      result.unsendable += 1;
      continue;
    }

    // Before a byte is read: an absurd file must not be downloaded at all.
    //
    // getObjectSize THROWS for a key that is gone (NotFound) and returns null
    // only for "answered but reported no length" - two different things, and
    // conflating them would treat a vanished clip as merely unmeasured and try
    // to download it anyway. A gone object is permanent: nothing brings it back,
    // so it must not burn the attempt budget either.
    //
    // But only a GONE object is permanent - see isObjectGone. Any other throw
    // from the probe (5xx, credentials, network) leaves the clip untouched so
    // the next poll picks it up again.
    let size: number | null;
    try {
      size = await getObjectSize(clip.storageKey);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!isObjectGone(error)) {
        console.warn(`[delivery] ${clip.id}: transient storage probe failure:`, detail);
        result.pending += 1;
        continue;
      }
      const reason = `clip is no longer in storage: ${detail}`;
      console.error(`[delivery] ${clip.id}: ${reason}`);
      await deps.markUnsendable(clip.id, reason);
      result.unsendable += 1;
      continue;
    }

    if (size !== null && size > maxBytes) {
      const reason = `clip is too large to send: ${size} bytes exceeds ${maxBytes}`;
      console.error(`[delivery] ${clip.id}: ${reason}`);
      await deps.markUnsendable(clip.id, reason);
      result.unsendable += 1;
      continue;
    }

    let path: string | undefined;
    try {
      path = await downloadToFile(clip.storageKey);
      const fileId = await client.sendVideoUpload(chatId, path, captionFor(clip));
      await deps.markSent(clip.id, fileId);
      result.delivered += 1;
    } catch (error) {
      const kind = classifySendFailure(error);
      if (kind === "chat-permanent") throw error;

      if (kind === "ambiguous") {
        // Logged distinctly because retrying this one can duplicate: the send
        // may have landed and we never heard. The rate needs to be observable
        // rather than assumed.
        console.warn(
          `[delivery] ${clip.id}: no response from Telegram, retrying may duplicate:`,
          error instanceof Error ? error.message : error
        );
      } else {
        console.warn(
          `[delivery] ${clip.id}: transient send failure:`,
          error instanceof Error ? error.message : error
        );
      }
      result.pending += 1;
    } finally {
      if (path) await unlink(path).catch(() => undefined);
    }
  }

  return result;
}
