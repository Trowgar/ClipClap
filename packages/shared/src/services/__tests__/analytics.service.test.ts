import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ count: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: { account: { count: mocks.count } },
}));

import { excludeOwnAccountsWhere, isAdminEmail, isAdminUser, parseOwnAccounts } from "../analytics.service";

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

describe("parseOwnAccounts", () => {
  it("splits emails from telegram ids, trimming and lowercasing emails", () => {
    expect(parseOwnAccounts(" Me@Example.com , 12345 , other@X.io ,67890")).toEqual({
      emails: ["me@example.com", "other@x.io"],
      telegramIds: ["12345", "67890"],
    });
  });

  it("tolerates an empty or undefined value", () => {
    expect(parseOwnAccounts("")).toEqual({ emails: [], telegramIds: [] });
    expect(parseOwnAccounts(undefined)).toEqual({ emails: [], telegramIds: [] });
  });

  it("drops blank entries from stray commas", () => {
    expect(parseOwnAccounts("me@example.com,,  ,12345")).toEqual({
      emails: ["me@example.com"],
      telegramIds: ["12345"],
    });
  });
});

describe("excludeOwnAccountsWhere", () => {
  it("tolerates NULL columns instead of using NOT-OR", () => {
    // Both columns are nullable. `NOT { OR: [{email in}, {telegramId in}] }`
    // looks right but SQL three-valued logic drops every row whose email is
    // NULL: measured on the real table it returned 2 of 101 users instead of
    // 98. The clause must therefore never be a bare NOT.
    const where = excludeOwnAccountsWhere({
      emails: ["me@example.com"],
      telegramIds: ["42"],
    });
    expect(JSON.stringify(where)).not.toContain("NOT");
    expect(where).toEqual({
      AND: [
        { OR: [{ email: null }, { email: { notIn: ["me@example.com"] } }] },
        { OR: [{ telegramId: null }, { telegramId: { notIn: ["42"] } }] },
      ],
    });
  });

  it("only constrains the sides that are configured", () => {
    expect(excludeOwnAccountsWhere({ emails: ["a@b.c"], telegramIds: [] })).toEqual({
      AND: [{ OR: [{ email: null }, { email: { notIn: ["a@b.c"] } }] }],
    });
  });

  it("is empty when nothing is configured, so nobody is excluded", () => {
    expect(excludeOwnAccountsWhere({ emails: [], telegramIds: [] })).toEqual({});
  });
});
