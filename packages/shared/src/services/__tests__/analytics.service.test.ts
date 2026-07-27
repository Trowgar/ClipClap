import { describe, expect, it } from "vitest";
import { isAdminEmail } from "../analytics.service";

describe("isAdminEmail", () => {
  it("accepts an email on the list, case- and space-insensitively", () => {
    expect(isAdminEmail("me@example.com", " Me@Example.com , other@x.io")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isAdminEmail("stranger@x.io", "me@example.com")).toBe(false);
  });
  it("rejects everyone when the list is empty or missing", () => {
    // A misconfigured deploy must close the page, not open it to all.
    expect(isAdminEmail("me@example.com", "")).toBe(false);
    expect(isAdminEmail("me@example.com", undefined)).toBe(false);
  });
  it("rejects a missing email", () => {
    expect(isAdminEmail(undefined, "me@example.com")).toBe(false);
  });
});
