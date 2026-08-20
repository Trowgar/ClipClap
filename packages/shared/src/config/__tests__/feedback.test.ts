import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  FEEDBACK_VERDICTS,
  FEEDBACK_REASONS,
  isFeedbackVerdict,
  isFeedbackReason,
  isClipFeedbackEnabled,
} from "../feedback";

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.CLIP_FEEDBACK_BOT;
  delete process.env.CLIP_FEEDBACK_WEB;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("feedback codes", () => {
  it("exposes exactly three verdicts and five reasons", () => {
    expect(FEEDBACK_VERDICTS).toEqual(["AS_IS", "EDIT", "NO"]);
    expect(FEEDBACK_REASONS).toEqual([
      "BORING",
      "CUTOFF",
      "FRAMING",
      "SUBS",
      "QUALITY",
    ]);
  });

  it("validates codes that arrive from a client", () => {
    expect(isFeedbackVerdict("AS_IS")).toBe(true);
    expect(isFeedbackVerdict("as_is")).toBe(false);
    expect(isFeedbackVerdict("MAYBE")).toBe(false);
    expect(isFeedbackReason("FRAMING")).toBe(true);
    expect(isFeedbackReason("")).toBe(false);
  });
});

// Fail-closed, matching SUBMISSION_QUEUE. An unset or empty variable must read
// as OFF: a copied .env line "CLIP_FEEDBACK_BOT=" has bitten this repo before
// on RETENTION_SWEEP_DRY_RUN, where Boolean("") read the opposite way.
describe("isClipFeedbackEnabled", () => {
  it("is off when unset", () => {
    expect(isClipFeedbackEnabled("bot")).toBe(false);
    expect(isClipFeedbackEnabled("web")).toBe(false);
  });

  it("is off for an empty or arbitrary value", () => {
    process.env.CLIP_FEEDBACK_BOT = "";
    expect(isClipFeedbackEnabled("bot")).toBe(false);
    process.env.CLIP_FEEDBACK_BOT = "true";
    expect(isClipFeedbackEnabled("bot")).toBe(false);
    process.env.CLIP_FEEDBACK_BOT = "1";
    expect(isClipFeedbackEnabled("bot")).toBe(false);
  });

  it("is on only for the literal \"on\", per surface", () => {
    process.env.CLIP_FEEDBACK_BOT = "on";
    expect(isClipFeedbackEnabled("bot")).toBe(true);
    expect(isClipFeedbackEnabled("web")).toBe(false);
    process.env.CLIP_FEEDBACK_WEB = "on";
    expect(isClipFeedbackEnabled("web")).toBe(true);
  });
});
