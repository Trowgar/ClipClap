import { describe, expect, it } from "vitest";
import { LOCALES, t } from "../i18n";
import {
  encodeVerdict,
  encodeReason,
  parseFeedbackCallback,
  verdictKeyboard,
  reasonKeyboard,
} from "../clip-feedback-keyboard";

const CUID = "clx9y8v7u6t5s4r3q2p1o0n9m"; // 25 chars, a real cuid length

describe("callback data codec", () => {
  it("round trips every verdict", () => {
    for (const v of ["AS_IS", "EDIT", "NO"] as const) {
      expect(parseFeedbackCallback(encodeVerdict(v, CUID))).toEqual({
        kind: "verdict",
        verdict: v,
        clipId: CUID,
      });
    }
  });

  it("round trips every reason", () => {
    for (const r of ["BORING", "CUTOFF", "FRAMING", "SUBS", "QUALITY"] as const) {
      expect(parseFeedbackCallback(encodeReason(r, CUID))).toEqual({
        kind: "reason",
        reason: r,
        clipId: CUID,
      });
    }
  });

  it("returns null for anything that is not ours", () => {
    expect(parseFeedbackCallback("resend:job-1")).toBeNull();
    expect(parseFeedbackCallback("fb:z:" + CUID)).toBeNull();
    expect(parseFeedbackCallback("fb:a:")).toBeNull();
    expect(parseFeedbackCallback("")).toBeNull();
  });

  // Telegram truncates callback_data over 64 BYTES and the failure is silent.
  // The ceiling is asserted, not the current number, so a longer code fails
  // loudly rather than shipping a dead button.
  it("never exceeds Telegram's 64-byte callback_data ceiling", () => {
    const all = [
      ...(["AS_IS", "EDIT", "NO"] as const).map((v) => encodeVerdict(v, CUID)),
      ...(["BORING", "CUTOFF", "FRAMING", "SUBS", "QUALITY"] as const).map((r) =>
        encodeReason(r, CUID)
      ),
    ];
    for (const data of all) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("keyboards", () => {
  it("puts the three verdicts in one row", () => {
    const kb = verdictKeyboard(CUID, t("en"));
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]).toHaveLength(3);
  });

  // Five buttons in one Telegram row truncate to a few characters on a phone.
  it("lays the five reasons out as 2/2/1", () => {
    const kb = reasonKeyboard(CUID, t("en"));
    expect(kb.inline_keyboard.map((row) => row.length)).toEqual([2, 2, 1]);
  });

  it("has translated, non-empty labels in every locale", () => {
    for (const locale of LOCALES) {
      const dict = t(locale);
      const labels = [
        ...verdictKeyboard(CUID, dict).inline_keyboard.flat(),
        ...reasonKeyboard(CUID, dict).inline_keyboard.flat(),
      ].map((b) => b.text);
      expect(labels).toHaveLength(8);
      for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  // Every button carries the clip it belongs to; a keyboard built for one clip
  // must never be able to record a verdict against another.
  it("stamps every button with the clip id it was built for", () => {
    const buttons = [
      ...verdictKeyboard(CUID, t("en")).inline_keyboard.flat(),
      ...reasonKeyboard(CUID, t("en")).inline_keyboard.flat(),
    ];
    for (const b of buttons) {
      expect(parseFeedbackCallback(b.callback_data)?.clipId).toBe(CUID);
    }
  });
});
