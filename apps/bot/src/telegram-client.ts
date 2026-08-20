import { createReadStream, createWriteStream, openAsBlob } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type {
  InlineKeyboardMarkup,
  ReplyMarkup,
  TelegramApiResponse,
  TelegramFile,
  TelegramUpdate,
} from "./types";

/** Telegram answered and refused.
 *
 *  The distinction this type carries is load-bearing for delivery: a parsed
 *  refusal means the call did NOT take effect, so retrying cannot duplicate
 *  anything. An error that is not this one means we never heard back, the send
 *  may have landed, and a retry risks a duplicate. Nothing else can tell those
 *  two apart after the fact. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient {
  private readonly apiBase: string;
  private readonly fileBase: string;

  constructor(private readonly token: string, baseUrl?: string) {
    const root = (baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.apiBase = `${root}/bot${token}`;
    this.fileBase = `${root}/file/bot${token}`;
  }

  async getUpdates(offset: number | undefined, timeout = 25) {
    return this.request<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
  }

  /** Returns the sent message, so a caller that means to edit it later - the
   *  progress board - can keep its message_id. Existing callers ignore it. */
  async sendMessage(
    chatId: string | number,
    text: string,
    options?: {
      replyMarkup?: ReplyMarkup;
      parseMode?: "HTML" | "MarkdownV2";
      /** Anchors the reply in the thread of the user's own message. This is what
       *  gives a job its identity: with two videos in flight, an unanchored
       *  "Done, 3 clips" does not say which one it belongs to. */
      replyToMessageId?: number;
    }
  ) {
    return this.request<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: options?.replyMarkup,
      parse_mode: options?.parseMode,
      reply_to_message_id: options?.replyToMessageId,
      // The anchor message can be deleted between submit and the send. Without
      // this Telegram refuses the whole send with "message to reply not found",
      // which would cost the user their acknowledgement over a cosmetic detail.
      allow_sending_without_reply: options?.replyToMessageId ? true : undefined,
    });
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    options?: { replyMarkup?: InlineKeyboardMarkup }
  ) {
    return this.request("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: options?.replyMarkup,
    });
  }

  /** Swap the keyboard under a message that is already sent.
   *
   *  This is what turns a feedback keyboard into the reason row, and then into
   *  a confirmation, without posting anything new into the chat. Telegram
   *  answers "message is not modified" if the markup is identical; callers
   *  swallow that. */
  async editMessageReplyMarkup(
    chatId: string | number,
    messageId: number,
    replyMarkup?: InlineKeyboardMarkup
  ) {
    return this.request("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  /** Removes one of the bot's own messages. Telegram allows this for 48 hours,
   *  and the longest run measured in production is 13 minutes, so the progress
   *  board is always well inside the window. */
  async deleteMessage(chatId: string | number, messageId: number) {
    return this.request("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async setMyDescription(description: string, languageCode?: string) {
    return this.request("setMyDescription", {
      description,
      language_code: languageCode,
    });
  }

  async setMyShortDescription(shortDescription: string, languageCode?: string) {
    return this.request("setMyShortDescription", {
      short_description: shortDescription,
      language_code: languageCode,
    });
  }

  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    languageCode?: string
  ) {
    return this.request("setMyCommands", {
      commands,
      language_code: languageCode,
    });
  }

  /* The three readers below exist so configureBotProfile can skip writes whose
   * value is already in place.
   *
   * Telegram rate-limits the setMy* family hard - measured here as
   * "Too Many Requests: retry after 156" on all three methods at once, after a
   * run of container restarts. The bot re-synced 21 values (7 slots x 3 fields)
   * on EVERY boot, and with tsx watch a boot happens on every source edit, so a
   * copy-editing session is guaranteed to trip the limit and leave the profile
   * half-written. The getMy* family took dozens of calls across that same
   * session without a single 429, which is why reading first is cheap enough to
   * be the default. */
  async getMyDescription(languageCode?: string) {
    return this.request<{ description: string }>("getMyDescription", {
      language_code: languageCode,
    });
  }

  async getMyShortDescription(languageCode?: string) {
    return this.request<{ short_description: string }>(
      "getMyShortDescription",
      { language_code: languageCode }
    );
  }

  async getMyCommands(languageCode?: string) {
    return this.request<Array<{ command: string; description: string }>>(
      "getMyCommands",
      { language_code: languageCode }
    );
  }

  /** The ☰ button next to the input field, per chat.
   *
   *  Omitting chatId would change it for every private chat at once, which is
   *  never what we want here - the web_app variant is set for one admin. */
  async setChatMenuButton(
    chatId: string | number,
    menuButton:
      | { type: "web_app"; text: string; web_app: { url: string } }
      | { type: "commands" }
      | { type: "default" }
  ) {
    return this.request("setChatMenuButton", {
      chat_id: chatId,
      menu_button: menuButton,
    });
  }

  async sendVideo(
    chatId: string | number,
    video: string,
    caption?: string,
    replyMarkup?: unknown
  ) {
    return this.request<{ message_id: number }>("sendVideo", {
      chat_id: chatId,
      video,
      caption,
      supports_streaming: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  /** Upload a file as multipart/form-data.
   *
   *  Separate from `request()` because that one is hard-wired to
   *  `Content-Type: application/json`. The header is deliberately NOT set here:
   *  fetch derives the multipart boundary from the FormData, and setting it by
   *  hand produces a body Telegram cannot parse. */
  private async requestMultipart<T>(
    method: string,
    form: FormData
  ): Promise<T> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      body: form,
    });
    const payload = (await response.json()) as TelegramApiResponse<T>;

    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(
        payload.description || `Telegram API failed: ${method}`,
        method
      );
    }

    return payload.result as T;
  }

  /** Send a local video file; return the ids Telegram assigned it.
   *
   *  `openAsBlob` rather than reading the file: it hands fetch a file-backed
   *  Blob, so a 36 MB clip is streamed off disk instead of sitting in the
   *  worker's heap. The size gate in the delivery loop is still the guard - this
   *  just means the ordinary case costs no memory.
   *
   *  message_id is returned because a user's reply to this exact message is the
   *  free-text feedback channel; without it there is nothing to map a reply to.
   *  Both ids are optional in the result for the same reason telegramFileId
   *  falls back to "sent": Telegram sometimes confirms a send with a payload we
   *  cannot fully parse. */
  async sendVideoUpload(
    chatId: string | number,
    filePath: string,
    caption?: string,
    replyMarkup?: InlineKeyboardMarkup
  ): Promise<{ fileId: string | undefined; messageId: number | undefined }> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption);
    form.set("supports_streaming", "true");
    // Multipart carries no types: Telegram reads reply_markup as a JSON string
    // here, and an object would be stringified as "[object Object]" and dropped.
    if (replyMarkup) form.set("reply_markup", JSON.stringify(replyMarkup));
    form.set("video", await openAsBlob(filePath), "clip.mp4");

    const sent = await this.requestMultipart<{
      message_id?: number;
      video?: { file_id?: string };
    }>("sendVideo", form);
    return { fileId: sent.video?.file_id, messageId: sent.message_id };
  }

  async copyMessage(
    chatId: string | number,
    fromChatId: string | number,
    messageId: number,
    options?: { caption?: string }
  ) {
    return this.request("copyMessage", {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      caption: options?.caption,
    });
  }

  async getFile(fileId: string) {
    return this.request<TelegramFile>("getFile", { file_id: fileId });
  }

  async downloadFile(fileId: string, destinationPath: string) {
    const file = await this.getFile(fileId);
    if (!file.file_path) {
      throw new Error(`Telegram did not return file_path for ${fileId}`);
    }

    if (file.file_path.startsWith("/")) {
      await pipeline(
        createReadStream(file.file_path),
        createWriteStream(destinationPath)
      );
      return;
    }

    const response = await fetch(`${this.fileBase}/${file.file_path}`);
    if (!response.ok || !response.body) {
      throw new Error(`Telegram file download failed: ${response.status}`);
    }

    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(destinationPath)
    );
  }

  private async request<T>(method: string, body: Record<string, unknown>) {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as TelegramApiResponse<T>;

    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(
        payload.description || `Telegram API failed: ${method}`,
        method
      );
    }

    return payload.result as T;
  }
}
