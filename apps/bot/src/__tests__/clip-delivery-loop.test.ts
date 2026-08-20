import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getObjectSizeMock = vi.hoisted(() => vi.fn());
const downloadToFileMock = vi.hoisted(() => vi.fn());
const markSentMock = vi.hoisted(() => vi.fn());
const markUnsendableMock = vi.hoisted(() => vi.fn());

// prisma is listed even though this file never touches it: a factory mock must
// name every export the module under test imports, and clip-delivery.ts now
// imports prisma for the resend re-arm. Omitting it fails the whole module with
// `No "prisma" export is defined on the mock`.
vi.mock("@clipclap/shared", () => ({
  getObjectSize: getObjectSizeMock,
  isPermanentTelegramError: (m: string) => m.includes("blocked"),
  prisma: { telegramDelivery: { findFirst: vi.fn(), update: vi.fn() } },
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
        const fileId = await sendImpl(id);
        return { fileId, messageId: 1 };
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
    expect(markSentMock).toHaveBeenCalledWith("a", "FID-a", 1);
    expect(markSentMock).toHaveBeenCalledWith("c", "FID-c", 1);
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
    const gone = Object.assign(new Error("NotFound"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    getObjectSizeMock.mockRejectedValueOnce(gone);
    const h = harness(async (id) => `FID-${id}`);

    const result = await deliverClips(h.client as never, "chat-1", [clip("gone"), clip("ok")], (c) => c.title, h.deps as never);

    expect(h.sent).toEqual(["ok"]);
    expect(markUnsendableMock).toHaveBeenCalledWith("gone", expect.stringContaining("storage"));
    expect(result.unsendable).toBe(1);
    expect(result.delivered).toBe(1);
  });

  // A storage probe that fails for a reason OTHER than "not there" must not
  // bury the clip. markUnsendable is permanent - one R2 5xx would cost the user
  // a clip they paid minutes for, with no retry and no way back.
  it("retries a clip when the storage probe fails transiently", async () => {
    const transient = Object.assign(new Error("InternalError"), {
      name: "InternalError",
      $metadata: { httpStatusCode: 500 },
    });
    getObjectSizeMock.mockRejectedValueOnce(transient);
    const h = harness(async (id) => `FID-${id}`);

    const result = await deliverClips(
      h.client as never,
      "chat-1",
      [clip("wobble"), clip("ok")],
      (c) => c.title,
      h.deps as never
    );

    expect(markUnsendableMock).not.toHaveBeenCalled();
    expect(result.unsendable).toBe(0);
    expect(result.pending).toBe(1);
    expect(result.delivered).toBe(1);
    expect(h.sent).toEqual(["ok"]);
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

describe("deliverClips feedback keyboard", () => {
  it("passes the keyboard for each clip to the send call", async () => {
    const sends: unknown[] = [];
    const client = {
      sendVideoUpload: async (
        _chat: string | number,
        _path: string,
        _caption?: string,
        markup?: unknown
      ) => {
        sends.push(markup);
        return { fileId: "F1", messageId: 7 };
      },
    };
    const markSent = vi.fn();
    await deliverClips(
      client,
      "chat-1",
      [{ id: "c1", storageKey: "k1", telegramFileId: null, telegramSendError: null }],
      () => "caption",
      { markSent, markUnsendable: vi.fn() },
      (clip) => ({ inline_keyboard: [[{ text: "As is", callback_data: `fb:a:${clip.id}` }]] })
    );
    expect(sends[0]).toEqual({
      inline_keyboard: [[{ text: "As is", callback_data: "fb:a:c1" }]],
    });
  });

  // The message id is the only anchor a later reply can be matched against.
  it("hands the message id to markSent", async () => {
    const markSent = vi.fn();
    const client = {
      sendVideoUpload: async () => ({ fileId: "F1", messageId: 4242 }),
    };
    await deliverClips(
      client,
      "chat-1",
      [{ id: "c1", storageKey: "k1", telegramFileId: null, telegramSendError: null }],
      () => "caption",
      { markSent, markUnsendable: vi.fn() }
    );
    expect(markSent).toHaveBeenCalledWith("c1", "F1", 4242);
  });

  // Flag-off must send no keyboard at all. An empty inline_keyboard is not the
  // same thing: Telegram renders it as a stray blank row under the video.
  it("passes undefined when no keyboard builder is given", async () => {
    const sends: unknown[] = [];
    const client = {
      sendVideoUpload: async (
        _chat: string | number,
        _path: string,
        _caption?: string,
        markup?: unknown
      ) => {
        sends.push(markup);
        return { fileId: "F1", messageId: 7 };
      },
    };
    await deliverClips(
      client,
      "chat-1",
      [{ id: "c1", storageKey: "k1", telegramFileId: null, telegramSendError: null }],
      () => "caption",
      { markSent: vi.fn(), markUnsendable: vi.fn() }
    );
    expect(sends[0]).toBeUndefined();
  });
});
