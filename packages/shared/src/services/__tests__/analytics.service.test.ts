import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ count: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: { account: { count: mocks.count } },
}));

import { isAdminEmail, isAdminUser } from "../analytics.service";

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

describe("isAdminUser", () => {
  beforeEach(() => {
    mocks.count.mockReset();
  });

  it("passes a listed email that has a federated account", async () => {
    mocks.count.mockResolvedValue(1);
    await expect(isAdminUser("u1", "me@example.com", "me@example.com")).resolves.toBe(true);
    expect(mocks.count).toHaveBeenCalledWith({
      where: { userId: "u1", provider: { in: ["google", "telegram"] } },
    });
  });

  it("rejects a listed email with no federated account (self-registered credentials)", async () => {
    mocks.count.mockResolvedValue(0);
    await expect(isAdminUser("u1", "me@example.com", "me@example.com")).resolves.toBe(false);
  });

  it("rejects an unlisted email without even querying the database", async () => {
    await expect(isAdminUser("u1", "stranger@x.io", "me@example.com")).resolves.toBe(false);
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("rejects a missing userId", async () => {
    await expect(isAdminUser(undefined, "me@example.com", "me@example.com")).resolves.toBe(false);
    expect(mocks.count).not.toHaveBeenCalled();
  });
});
