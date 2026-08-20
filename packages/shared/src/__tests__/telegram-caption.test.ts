import { describe, expect, it } from "vitest";
import { buildClipCaption } from "../services/telegram-caption";

describe("buildClipCaption", () => {
  it("joins title and description with a blank line", () => {
    expect(
      buildClipCaption({ title: "Заголовок", description: "Описание момента." })
    ).toBe("Заголовок\n\nОписание момента.");
  });

  it("prepends the low-quality note when flagged", () => {
    const caption = buildClipCaption({
      title: "T",
      description: "D",
      lowQuality: true,
      lowQualityNote: "Внимание: лучшее из доступного.",
    });
    expect(caption.startsWith("Внимание: лучшее из доступного.\n\n")).toBe(true);
  });

  it("clamps to Telegram's 1024-char caption limit", () => {
    const caption = buildClipCaption({
      title: "t".repeat(200),
      description: "d".repeat(2000),
    });
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption.endsWith("…")).toBe(true);
  });

  it("works with title only (legacy clips without description)", () => {
    expect(buildClipCaption({ title: "Only title" })).toBe("Only title");
  });

  it("appends the feedback prompt after the description when given", () => {
    expect(
      buildClipCaption({ title: "T", description: "D", feedbackPrompt: "Would you post this?" })
    ).toBe("T\n\nD\n\nWould you post this?");
  });

  it("omits the feedback prompt entirely when not given (flag-off shape)", () => {
    expect(buildClipCaption({ title: "T", description: "D" })).toBe("T\n\nD");
  });
});
