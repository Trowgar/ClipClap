import { describe, expect, it } from "vitest";
import { supportMediaKind } from "../handlers";
import type { TelegramMessage } from "../types";

const base: TelegramMessage = { message_id: 1, chat: { id: 1, type: "private" } };

describe("supportMediaKind", () => {
  it("names a screenshot a photo", () => {
    // The common case: somebody sends a screenshot of what went wrong. Before
    // 2026-08-21 nothing about the message was stored at all.
    expect(
      supportMediaKind({
        ...base,
        photo: [{ file_id: "a", file_unique_id: "b" }],
      })
    ).toBe("photo");
  });

  it("names a video a video", () => {
    expect(
      supportMediaKind({ ...base, video: { file_id: "a", file_unique_id: "b" } })
    ).toBe("video");
  });

  it("names a voice message a voice", () => {
    expect(
      supportMediaKind({ ...base, voice: { file_id: "a", file_unique_id: "b" } })
    ).toBe("voice");
  });

  it("names a file a document", () => {
    expect(
      supportMediaKind({
        ...base,
        document: { file_id: "a", file_unique_id: "b" },
      })
    ).toBe("document");
  });

  it("falls back to other when nothing recognisable arrived", () => {
    expect(supportMediaKind(base)).toBe("other");
  });

  it("prefers photo over document when both are present", () => {
    // Telegram can send an image as both, and a screenshot sent as a file is
    // still a screenshot.
    expect(
      supportMediaKind({
        ...base,
        photo: [{ file_id: "a", file_unique_id: "b" }],
        document: { file_id: "c", file_unique_id: "d" },
      })
    ).toBe("photo");
  });
});
