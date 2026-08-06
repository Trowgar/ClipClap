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

  it("returns the file_id Telegram assigned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { video: { file_id: "FID-123" } } }), { status: 200 })
    );
    const path = tempVideo();
    const client = new TelegramClient("token", "http://local");
    await expect(client.sendVideoUpload(42, path, "c")).resolves.toBe("FID-123");
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
