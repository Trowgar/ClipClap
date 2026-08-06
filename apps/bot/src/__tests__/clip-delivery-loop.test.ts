import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getObjectSizeMock = vi.hoisted(() => vi.fn());
const downloadToFileMock = vi.hoisted(() => vi.fn());
const markSentMock = vi.hoisted(() => vi.fn());
const markUnsendableMock = vi.hoisted(() => vi.fn());

vi.mock("@clipclap/shared", () => ({
  getObjectSize: getObjectSizeMock,
  isPermanentTelegramError: (m: string) => m.includes("blocked"),
}));

vi.mock("../clip-file", () => ({ downloadToFile: downloadToFileMock }));

import { TelegramApiError } from "../telegram-client";
import { deliverClips } from "../clip-delivery";

const clip = (id: string, fileId: string | null = null) => ({
  id,
  storageKey: `clips/${id}.mp4`,
  title: `t-${id}`,
  telegramFileId: fileId,
  telegramSendError: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  getObjectSizeMock.mockResolvedValue(1_000_000);
  downloadToFileMock.mockResolvedValue("/tmp/x.mp4");
  process.env.TELEGRAM_UPLOAD_MAX_BYTES = "262144000";
});
afterEach(() => vi.restoreAllMocks());

function harness(sendImpl: (clipId: string) => Promise<string | undefined>) {
  const sent: string[] = [];
  return {
    sent,
    client: {
      // `sent` is the ATTEMPT log, recorded before the send can throw: the
      // assertions below are about which clips the loop still reached after an
      // earlier one failed, which a success-only log cannot show.
      sendVideoUpload: vi.fn(async (_chat: unknown, _path: string, caption?: string) => {
        const id = String(caption).replace("t-", "");
        sent.push(id);
        return await sendImpl(id);
      }),
    },
    deps: { markSent: markSentMock, markUnsendable: markUnsendableMock },
  };
}

describe("deliverClips", () => {
  // THE DEFECT. Clip 2 threw and clips 3-12 were never attempted.
  it("keeps sending after one clip fails", async () => {
    const h = harness(async (id) => {
      if (id === "b") throw new TelegramApiError("Too Many Requests", "sendVideo");
      return `FID-${id}`;
    });

    const result = await deliverClips(
      h.client as never,
      "chat-1",
      [clip("a"), clip("b"), clip("c")],
      (c) => c.title,
      h.deps as never
    );

    expect(h.sent).toEqual(["a", "b", "c"]);
    expect(result.delivered).toBe(2);
    expect(result.pending).toBe(1);
    expect(markSentMock).toHaveBeenCalledWith("a", "FID-a");
    expect(markSentMock).toHaveBeenCalledWith("c", "FID-c");
  });

  it("never re-sends a clip that already has a file id", async () => {
    const h = harness(async (id) => `FID-${id}`);
    await deliverClips(h.client as never, "chat-1", [clip("a", "FID-old"), clip("b")], (c) => c.title, h.deps as never);
    expect(h.sent).toEqual(["b"]);
  });

  it("refuses an oversized clip before reading a byte of it", async () => {
    getObjectSizeMock.mockResolvedValue(300_000_000);
    const h = harness(async () => "unused");

    const result = await deliverClips(h.client as never, "chat-1", [clip("big")], (c) => c.title, h.deps as never);

    expect(downloadToFileMock).not.toHaveBeenCalled();
    expect(h.client.sendVideoUpload).not.toHaveBeenCalled();
    expect(markUnsendableMock).toHaveBeenCalledWith("big", expect.stringContaining("too large"));
    expect(result.unsendable).toBe(1);
  });

  // getObjectSize throws for a swept object. That must cost one clip, not the pass.
  it("treats a clip missing from storage as permanently unsendable", async () => {
    getObjectSizeMock.mockRejectedValueOnce(new Error("NotFound"));
    const h = harness(async (id) => `FID-${id}`);

    const result = await deliverClips(h.client as never, "chat-1", [clip("gone"), clip("ok")], (c) => c.title, h.deps as never);

    expect(h.sent).toEqual(["ok"]);
    expect(markUnsendableMock).toHaveBeenCalledWith("gone", expect.stringContaining("storage"));
    expect(result.unsendable).toBe(1);
    expect(result.delivered).toBe(1);
  });

  it("stops the whole batch when the chat itself is gone", async () => {
    const h = harness(async () => {
      throw new TelegramApiError("Forbidden: bot was blocked by the user", "sendVideo");
    });

    await expect(
      deliverClips(h.client as never, "chat-1", [clip("a"), clip("b")], (c) => c.title, h.deps as never)
    ).rejects.toBeInstanceOf(TelegramApiError);

    expect(h.sent).toEqual(["a"]);
  });

  it("does not retry a clip already marked unsendable", async () => {
    const h = harness(async (id) => `FID-${id}`);
    const dead = { ...clip("dead"), telegramSendError: "too large" };
    await deliverClips(h.client as never, "chat-1", [dead, clip("ok")], (c) => c.title, h.deps as never);
    expect(h.sent).toEqual(["ok"]);
  });

  // A send that landed but returned no file_id is still a delivery. Marking it
  // pending would send the user the same clip again on the next pass.
  it("counts a send with no file_id as delivered", async () => {
    const h = harness(async () => undefined);
    const result = await deliverClips(h.client as never, "chat-1", [clip("a")], (c) => c.title, h.deps as never);
    expect(result.delivered).toBe(1);
    expect(result.pending).toBe(0);
  });
});
