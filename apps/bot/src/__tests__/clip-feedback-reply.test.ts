import { describe, expect, it, vi, beforeEach } from "vitest";

const clipFindFirst = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());
const recordClipFeedbackMock = vi.hoisted(() => vi.fn());

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prisma: {
      clip: { findFirst: clipFindFirst },
      user: { findUnique: userFindUnique },
    },
    recordClipFeedback: recordClipFeedbackMock,
  };
});

import { handleUpdate, tryRecordClipReply } from "../handlers";
import { t } from "../i18n";

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
    const outcome = await tryRecordClipReply("user-1", 4242, "the face is cut off");
    expect(outcome).toBe("recorded");
    expect(recordClipFeedbackMock).toHaveBeenCalledWith({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      note: "the face is cut off",
    });
  });

  // The anchor can be gone: the project was deleted, the send never returned a
  // message id, or - the common case at launch - the clip predates the anchor
  // column entirely (every clip delivered before this feature shipped has a
  // null telegramMessageId). Falling through to the URL branch would let a
  // reply that happens to contain a link start a job nobody asked for, so the
  // outcome still short-circuits the caller even though nothing was written.
  it("reports no-anchor on a miss, distinct from a successful save", async () => {
    clipFindFirst.mockResolvedValue(null);
    const outcome = await tryRecordClipReply("user-1", 4242, "https://youtu.be/x");
    expect(outcome).toBe("no-anchor");
    expect(recordClipFeedbackMock).not.toHaveBeenCalled();
  });

  // The clip can vanish between the lookup and the write (deleted in the gap,
  // or a race with the retention sweep). recordClipFeedback's own ownership
  // check catches that and refuses - which must read the same as a miss, not
  // as a save.
  it("reports no-anchor when recordClipFeedback refuses the write", async () => {
    clipFindFirst.mockResolvedValue({ id: "clip-1" });
    recordClipFeedbackMock.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    const outcome = await tryRecordClipReply("user-1", 4242, "the face is cut off");
    expect(outcome).toBe("no-anchor");
  });

  it("ignores empty text", async () => {
    clipFindFirst.mockResolvedValue({ id: "clip-1" });
    expect(await tryRecordClipReply("user-1", 4242, "   ")).toBe("empty");
    expect(recordClipFeedbackMock).not.toHaveBeenCalled();
  });

  // A database failure must not cost the user their message: the note is gone
  // either way, but the caller still short-circuits away from URL submission
  // rather than treating the raw text as ordinary handling.
  it("reports failed when the lookup throws", async () => {
    clipFindFirst.mockRejectedValue(new Error("db is down"));
    await expect(tryRecordClipReply("user-1", 4242, "text")).resolves.toBe("failed");
  });
});

describe("reply wiring in handleUpdate", () => {
  const CONFIG = { appUrl: "https://clipclap.io" };
  const CHAT = { id: 777001, type: "private" as const };
  const FROM = { id: 777001, is_bot: false, first_name: "Ann", language_code: "en" };
  const client = { sendMessage: vi.fn() };

  function replyUpdate(text: string) {
    return {
      update_id: 1,
      message: {
        message_id: 500,
        chat: CHAT,
        from: FROM,
        text,
        reply_to_message: {
          message_id: 4242,
          chat: CHAT,
          from: { id: 999999999, is_bot: true, first_name: "ClipClapBot" },
          video: { file_id: "abc", file_unique_id: "abc" },
        },
      },
    };
  }

  beforeEach(() => {
    client.sendMessage.mockReset().mockResolvedValue(undefined);
    userFindUnique.mockResolvedValue({ id: "user-1", telegramLocale: "en", supportOpen: false });
  });

  it("confirms feedbackNoteSaved only when the outcome is recorded", async () => {
    clipFindFirst.mockResolvedValue({ id: "clip-1" });
    await handleUpdate(client as never, replyUpdate("great edit, thanks") as never, CONFIG);
    expect(client.sendMessage).toHaveBeenCalledWith(CHAT.id, t("en").feedbackNoteSaved);
  });

  // This is the defect the review caught: tryRecordClipReply's old boolean
  // return made a miss indistinguishable from a save, and the caller told the
  // user "Got it, saved" when nothing was written. Every clip delivered before
  // this feature shipped has a null telegramMessageId, so this path is not a
  // corner case - it is what every reply to an old clip hits.
  it("sends the unmatched copy, not the saved one, when the anchor misses", async () => {
    clipFindFirst.mockResolvedValue(null);
    await handleUpdate(
      client as never,
      replyUpdate("the face is cut off") as never,
      CONFIG
    );
    expect(client.sendMessage).toHaveBeenCalledWith(CHAT.id, t("en").feedbackNoteUnmatched);
    expect(client.sendMessage).not.toHaveBeenCalledWith(CHAT.id, t("en").feedbackNoteSaved);
  });
});
