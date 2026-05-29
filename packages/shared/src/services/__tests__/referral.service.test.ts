import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  commissionFindUnique: vi.fn(),
  commissionCreate: vi.fn(),
  commissionUpdateMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
      updateMany: mocks.userUpdateMany,
    },
    referralCommission: {
      findUnique: mocks.commissionFindUnique,
      create: mocks.commissionCreate,
      updateMany: mocks.commissionUpdateMany,
    },
  },
}));

import { attachReferral, recordCommission, voidCommission } from "../referral.service";

const REFERRER = {
  id: "ref-1",
  telegramId: "111",
  email: "ref@example.com",
  referralBannedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("attachReferral", () => {
  it("attaches a fresh user to the referrer", async () => {
    mocks.userFindUnique
      .mockResolvedValueOnce({ ...REFERRER }) // resolve referrer by code
      .mockResolvedValueOnce({
        id: "new-1",
        telegramId: "222",
        email: "new@example.com",
        referredById: null,
      }); // load new user
    mocks.userUpdateMany.mockResolvedValue({ count: 1 });

    const result = await attachReferral("new-1", "ABCD1234");

    expect(result.status).toBe("attached");
    expect(mocks.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "new-1", referredById: null },
      data: { referredById: "ref-1" },
    });
  });

  it("rejects an unknown code", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    const result = await attachReferral("new-1", "NOPE");
    expect(result.status).toBe("unknown_code");
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks self-referral by id", async () => {
    mocks.userFindUnique
      .mockResolvedValueOnce({ ...REFERRER })
      .mockResolvedValueOnce({
        id: "ref-1",
        telegramId: "111",
        email: "ref@example.com",
        referredById: null,
      });
    const result = await attachReferral("ref-1", "ABCD1234");
    expect(result.status).toBe("self_referral");
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing binding", async () => {
    mocks.userFindUnique
      .mockResolvedValueOnce({ ...REFERRER })
      .mockResolvedValueOnce({
        id: "new-1",
        telegramId: "222",
        email: "new@example.com",
        referredById: "someone-else",
      });
    const result = await attachReferral("new-1", "ABCD1234");
    expect(result.status).toBe("already_attached");
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });
});

describe("recordCommission", () => {
  const base = {
    payerUserId: "new-1",
    source: "STRIPE" as const,
    externalPaymentId: "in_123",
    originalCurrency: "usd",
    originalAmount: 9,
    grossAmountUsd: 9,
    processorFeeUsd: 0.56,
    paidAt: new Date("2026-05-01T00:00:00Z"),
  };

  it("creates a PENDING commission for an attached payer", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "new-1",
      referredById: "ref-1",
      telegramId: "222",
      email: "new@example.com",
    });
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-1",
      telegramId: "111",
      email: "ref@example.com",
      referralBannedAt: null,
    });
    mocks.commissionCreate.mockResolvedValue({ id: "com-1" });

    const result = await recordCommission(base);

    expect(result.status).toBe("recorded");
    const arg = mocks.commissionCreate.mock.calls[0][0].data;
    expect(arg.netAmountUsd).toBeCloseTo(8.44, 2);
    expect(arg.commissionUsd).toBeCloseTo(2.53, 2); // 8.44 * 0.30 = 2.532 -> 2.53
    expect(arg.status).toBe("PENDING");
    expect(arg.availableAt.toISOString()).toBe("2026-05-15T00:00:00.000Z"); // +14d
  });

  it("skips an unattached payer", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "new-1",
      referredById: null,
    });
    const result = await recordCommission(base);
    expect(result.status).toBe("no_referrer");
    expect(mocks.commissionCreate).not.toHaveBeenCalled();
  });

  it("skips a banned referrer", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "new-1",
      referredById: "ref-1",
      telegramId: "222",
      email: "new@example.com",
    });
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-1",
      telegramId: "111",
      email: "ref@example.com",
      referralBannedAt: new Date(),
    });
    const result = await recordCommission(base);
    expect(result.status).toBe("referrer_banned");
    expect(mocks.commissionCreate).not.toHaveBeenCalled();
  });

  it("is idempotent on duplicate external payment id", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "new-1",
      referredById: "ref-1",
      telegramId: "222",
      email: "new@example.com",
    });
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-1",
      telegramId: "111",
      email: "ref@example.com",
      referralBannedAt: null,
    });
    mocks.commissionCreate.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" })
    );
    const result = await recordCommission(base);
    expect(result.status).toBe("duplicate");
  });
});

describe("voidCommission", () => {
  it("voids non-paid commissions for a payment and records the reason", async () => {
    mocks.commissionUpdateMany.mockResolvedValue({ count: 1 });
    const result = await voidCommission("STRIPE", "in_123", "refund");
    expect(result.voided).toBe(1);
    expect(mocks.commissionUpdateMany).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        externalPaymentId: "in_123",
        status: { in: ["PENDING", "AVAILABLE", "PAYOUT_PENDING"] },
      },
      data: { status: "VOIDED", adminNote: "refund" },
    });
  });
});
