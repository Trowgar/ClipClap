import { describe, expect, it } from "vitest";
import { isReferralAdmin } from "../handlers";

describe("isReferralAdmin", () => {
  it("matches an id in the allowlist", () => {
    expect(isReferralAdmin("111", "111,222")).toBe(true);
  });
  it("rejects an id not in the allowlist", () => {
    expect(isReferralAdmin("333", "111,222")).toBe(false);
  });
  it("rejects when allowlist is empty", () => {
    expect(isReferralAdmin("111", undefined)).toBe(false);
  });
});
