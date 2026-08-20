import { describe, expect, it, vi, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TelegramClient } from "../telegram-client";

afterEach(() => vi.restoreAllMocks());

function tempVideo(bytes = "video-bytes"): string {
  const path = join(tmpdir(), `clipclap-test-${Date.now()}-${Math.random()}.mp4`);
  writeFileSync(path, bytes);
  return path;
}

describe("sendVideoUpload", () => {
  // The whole point of the change: the body is the FILE, not a link to it.
  // Telegram caps a URL fetch at 20,000,000 bytes and a 20,557,490-byte clip
  // is what broke delivery.
  it("posts multipart with the file in the body, not a JSON url", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { video: { file_id: "FID" } } }), { status: 200 })
    );
    const path = tempVideo();
    const client = new TelegramClient("token", "http://local");

    await client.sendVideoUpload(42, path, "a caption");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("42");
    expect(form.get("caption")).toBe("a caption");
    expect(form.get("video")).toBeInstanceOf(Blob);
    // A JSON content-type here would mean the old path is still in use.
    expect((init.headers as Record<string, string> | undefined)?.["Content-Type"]).toBeUndefined();
    unlinkSync(path);
  });

  it("returns the ids Telegram assigned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 4242, video: { file_id: "FID-123" } } }),
        { status: 200 }
      )
    );
    const path = tempVideo();
    const client = new TelegramClient("token", "http://local");
    await expect(client.sendVideoUpload(42, path, "c")).resolves.toEqual({
      fileId: "FID-123",
      messageId: 4242,
    });
    unlinkSync(path);
  });

  // reply_markup is not a plain form field: Telegram reads it as a JSON string
  // inside multipart. Passing the object raw stringifies to "[object Object]"
  // and the keyboard silently never appears.
  it("serialises reply_markup as JSON into the form", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1, video: { file_id: "F" } } }), { status: 200 })
    );
    const path = tempVideo();
    const client = new TelegramClient("token", "http://local");
    const markup = { inline_keyboard: [[{ text: "As is", callback_data: "fb:a:c1" }]] };

    await client.sendVideoUpload(42, path, "c", markup);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get("reply_markup")).toBe(JSON.stringify(markup));
    unlinkSync(path);
  });

  // An empty keyboard is not the same as no keyboard: Telegram renders an
  // empty inline_keyboard as a stray blank row under the video.
  it("sends no reply_markup field at all when there is no keyboard", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1, video: { file_id: "F" } } }), { status: 200 })
    );
    const path = tempVideo();
    const client = new TelegramClient("token", "http://local");

    await client.sendVideoUpload(42, path, "c");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get("reply_markup")).toBeNull();
    unlinkSync(path);
  });

  // A refusal must stay distinguishable from never hearing back - the delivery
  // loop decides whether a retry can duplicate based on exactly that.
  it("throws TelegramApiError when Telegram refuses the upload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: file is too big" }), { status: 400 })
    );
    const path = tempVideo();
    const client = new TelegramClient("token", "http://local");
    const { TelegramApiError } = await import("../telegram-client");
    await expect(client.sendVideoUpload(42, path, "c")).rejects.toBeInstanceOf(TelegramApiError);
    unlinkSync(path);
  });
});
