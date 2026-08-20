import { describe, expect, it, vi, beforeEach } from "vitest";

const clipFindFirst = vi.hoisted(() => vi.fn());
const recordClipFeedbackMock = vi.hoisted(() => vi.fn());

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prisma: { clip: { findFirst: clipFindFirst } },
    recordClipFeedback: recordClipFeedbackMock,
  };
});

import { tryRecordClipReply } from "../handlers";

beforeEach(() => {
  vi.clearAllMocks();
  recordClipFeedbackMock.mockResolvedValue({ ok: true, verdict: null, reason: null });
});

describe("tryRecordClipReply", () => {
  // message_id is unique per CHAT and is a small integer, so ids collide freely
  // across chats. Looking one up without the owner would attach a stranger's
  // text to someone else's clip.
  // Mutation check: drop userId from the where and this assertion fails.
  it("looks the anchor up by owner AND message id", async () => {
    clipFindFirst.mockResolvedValue({ id: "clip-1" });
    await tryRecordClipReply("user-1", 4242, "the face is cut off");
    expect(clipFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", telegramMessageId: 4242 },
      select: { id: true },
    });
  });

  it("records the text as a note on the matched clip", async () => {
    clipFindFirst.mockResolvedValue({ id: "clip-1" });
    const handled = await tryRecordClipReply("user-1", 4242, "the face is cut off");
    expect(handled).toBe(true);
    expect(recordClipFeedbackMock).toHaveBeenCalledWith({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      note: "the face is cut off",
    });
  });

  // The anchor can be gone: the project was deleted, or the send never returned
  // a message id. Falling through would hand the text to the URL branch, and a
  // reply that happens to contain a link would start a job nobody asked for.
  it("reports handled on a miss so the text never reaches URL submission", async () => {
    clipFindFirst.mockResolvedValue(null);
    const handled = await tryRecordClipReply("user-1", 4242, "https://youtu.be/x");
    expect(handled).toBe(true);
    expect(recordClipFeedbackMock).not.toHaveBeenCalled();
  });

  it("ignores empty text", async () => {
    clipFindFirst.mockResolvedValue({ id: "clip-1" });
    expect(await tryRecordClipReply("user-1", 4242, "   ")).toBe(false);
    expect(recordClipFeedbackMock).not.toHaveBeenCalled();
  });

  // A database failure must not cost the user their message: it falls through
  // to the ordinary handling rather than being silently eaten.
  it("does not throw when the lookup fails", async () => {
    clipFindFirst.mockRejectedValue(new Error("db is down"));
    await expect(tryRecordClipReply("user-1", 4242, "text")).resolves.toBe(false);
  });
});
