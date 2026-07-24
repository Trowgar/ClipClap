import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type {
  InlineKeyboardMarkup,
  ReplyMarkup,
  TelegramApiResponse,
  TelegramFile,
  TelegramUpdate,
} from "./types";

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

  async sendMessage(
    chatId: string | number,
    text: string,
    options?: { replyMarkup?: ReplyMarkup; parseMode?: "HTML" | "MarkdownV2" }
  ) {
    return this.request("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: options?.replyMarkup,
      parse_mode: options?.parseMode,
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

  async sendVideo(
    chatId: string | number,
    video: string,
    caption?: string,
    replyMarkup?: unknown
  ) {
    return this.request("sendVideo", {
      chat_id: chatId,
      video,
      caption,
      supports_streaming: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
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
      throw new Error(payload.description || `Telegram API failed: ${method}`);
    }

    return payload.result as T;
  }
}
