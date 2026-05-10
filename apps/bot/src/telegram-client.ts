import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type {
  TelegramApiResponse,
  TelegramFile,
  TelegramUpdate,
} from "./types";

export class TelegramClient {
  private readonly apiBase: string;

  constructor(private readonly token: string) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset: number | undefined, timeout = 25) {
    return this.request<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"],
    });
  }

  async sendMessage(chatId: string | number, text: string) {
    return this.request("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  async sendVideo(chatId: string | number, video: string, caption?: string) {
    return this.request("sendVideo", {
      chat_id: chatId,
      video,
      caption,
      supports_streaming: true,
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

    const response = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${file.file_path}`
    );
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
