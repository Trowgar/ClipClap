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

  // A mocked client hands back whatever the mock was told to return, whatever
  // the query asked for, so no behavioural test above can see a field going
  // missing from the `select`. Real Prisma would simply omit the key, making
  // `!user.emailCanonical` true for every account that has an email - which
  // denies the allowance to every email-holding row on the site. This pins the
  // query shape itself, because nothing else can.
  it("selects every column the decision reads", async () => {
    (prisma.user.findUnique as any).mockResolvedValue(null);
    await isTrialAnchored("u1");
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: {
        telegramId: true,
        emailVerified: true,
        email: true,
        emailCanonical: true,
      },
    });
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
  });

  // Telegram outranks the canonical guard, on purpose. This row looks exactly
  // like the alias attack - an email whose mailbox another account already owns
  // - but it also carries a telegramId, and `telegramId` is @unique in the
  // schema, so a second allowance here costs a second phone number. That is the
  // bar the design set, and the ordering of the two branches is what enforces
  // it. Move the telegram check below the canonical guard and this row is
  // refused despite being phone-backed.
  it("lets telegram outrank a mailbox claimed by someone else", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: "1460419963",
      emailVerified: null,
      email: "o.leg+x@gmail.com",
      emailCanonical: null,
    });
    expect(await isTrialAnchored("u1")).toBe(true);
  });

  // Scopes the canonical guard to accounts that actually HAVE an email. A NULL
  // canonical means "another account owns this mailbox", which is a statement
  // about a mailbox: applied to a row with no email it means nothing, and would
  // refuse an account the google branch below was about to anchor.
  //
  // The row is synthetic - nothing today creates an emailless account without a
  // telegramId, and the telegram branch short-circuits those anyway. That is
  // exactly why the guard needs pinning rather than leaving to inspection: the
  // `user.email &&` half currently has no production row to justify it, so a
  // later reader can delete it as dead weight with every other test still green.
  //
  // Note this must assert TRUE with a google row present. The same row with no
  // google row returns false either way and kills nothing.
  it("does not apply the mailbox guard to an account with no email", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      telegramId: null,
      emailVerified: null,
      email: null,
      emailCanonical: null,
    });
    (prisma.account.count as any).mockResolvedValue(1);
    expect(await isTrialAnchored("u1")).toBe(true);
  });

  it("refuses an unknown user", async () => {
    (prisma.user.findUnique as any).mockResolvedValue(null);
    expect(await isTrialAnchored("nope")).toBe(false);
  });
});
