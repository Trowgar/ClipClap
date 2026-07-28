import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    account: { count: vi.fn() },
  },
}));

import { prisma } from "../../lib/prisma";
import { isTrialAnchored } from "../free-tier.service";

describe("isTrialAnchored", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a linked telegram account", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: "1460419963",
      emailVerified: null,
      email: null,
      emailCanonical: null,
    });
    expect(await isTrialAnchored("u1")).toBe(true);
    expect(prisma.account.count).not.toHaveBeenCalled();
  });

  it("accepts a verified email", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: null,
      emailVerified: new Date(),
      email: "oleg@example.com",
      emailCanonical: "oleg@example.com",
    });
    expect(await isTrialAnchored("u1")).toBe(true);
  });

  it("accepts a google account even when emailVerified is null", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: null,
      emailVerified: null,
      email: "oleg@gmail.com",
      emailCanonical: "oleg@gmail.com",
    });
    (prisma.account.count as any).mockResolvedValue(1);
    expect(await isTrialAnchored("u1")).toBe(true);
  });

  it("refuses a bare unverified password account", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: null,
      emailVerified: null,
      email: "oleg@example.com",
      emailCanonical: "oleg@example.com",
    });
    (prisma.account.count as any).mockResolvedValue(0);
    expect(await isTrialAnchored("u1")).toBe(false);
  });

  // The OAuth hook could not claim the canonical, so another account already
  // owns this mailbox. Verified by Google or not, this one gets no allowance.
  it("refuses an account whose mailbox is already claimed", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: null,
      emailVerified: new Date(),
      email: "o.leg+x@gmail.com",
      emailCanonical: null,
    });
    expect(await isTrialAnchored("u1")).toBe(false);
    expect(prisma.account.count).not.toHaveBeenCalled();
  });

  it("refuses an unknown user", async () => {
    (prisma.user.findUnique as any).mockResolvedValue(null);
    expect(await isTrialAnchored("nope")).toBe(false);
  });
});
