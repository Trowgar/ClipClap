import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  commissionFindUnique: vi.fn(),
  commissionFindMany: vi.fn(),
  commissionCreate: vi.fn(),
  commissionUpdateMany: vi.fn(),
  commissionGroupBy: vi.fn(),
  commissionAggregate: vi.fn(),
  commissionCount: vi.fn(),
  payoutCreate: vi.fn(),
  payoutFindMany: vi.fn(),
  payoutFindUniqueOrThrow: vi.fn(),
  payoutUpdate: vi.fn(),
  payoutUpdateMany: vi.fn(),
  txFn: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      findFirst: mocks.userFindFirst,
      update: mocks.userUpdate,
      updateMany: mocks.userUpdateMany,
    },
    referralCommission: {
      findUnique: mocks.commissionFindUnique,
      findMany: mocks.commissionFindMany,
      create: mocks.commissionCreate,
      updateMany: mocks.commissionUpdateMany,
      groupBy: mocks.commissionGroupBy,
      aggregate: mocks.commissionAggregate,
      count: mocks.commissionCount,
    },
    referralPayout: {
      create: mocks.payoutCreate,
      findMany: mocks.payoutFindMany,
      findUniqueOrThrow: mocks.payoutFindUniqueOrThrow,
      update: mocks.payoutUpdate,
      updateMany: mocks.payoutUpdateMany,
    },
    $transaction: mocks.txFn,
  },
}));

import {
  attachReferral,
  recordCommission,
  voidCommission,
  voidReferrerCommissions,
  releaseMaturedCommissions,
  runPayoutBatch,
  getReferralBalance,
  validatePayoutDestination,
  setPayoutDestination,
  approvePayout,
  markPayoutPaid,
  rejectPayout,
} from "../referral.service";

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

// ---------------------------------------------------------------------------
// voidCommission
// ---------------------------------------------------------------------------

describe("voidCommission", () => {
  it("voids non-paid commissions, sets payoutId null, detaches from open payout, wraps in transaction", async () => {
    // Simulate one PAYOUT_PENDING commission linked to payout "pay-1"
    const txCommissionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txPayoutFindMany = vi.fn().mockResolvedValue([
      { id: "pay-1", status: "PENDING", networkFeeUsd: 0 },
    ]);
    const txCommissionAggregate = vi.fn().mockResolvedValue({
      _sum: { commissionUsd: 0 },
    });
    const txPayoutUpdate = vi.fn().mockResolvedValue({});

    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralCommission: {
          updateMany: txCommissionUpdateMany,
          aggregate: txCommissionAggregate,
        },
        referralPayout: {
          findMany: txPayoutFindMany,
          update: txPayoutUpdate,
        },
      })
    );

    const result = await voidCommission("STRIPE", "in_123", "refund");

    expect(result.voided).toBe(1);

    // Commission update must set status VOIDED + payoutId null + reason
    expect(txCommissionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: "STRIPE",
          externalPaymentId: "in_123",
          status: { in: ["PENDING", "AVAILABLE", "PAYOUT_PENDING"] },
        }),
        data: expect.objectContaining({
          status: "VOIDED",
          adminNote: "refund",
          payoutId: null,
        }),
      })
    );

    // Remaining sum is 0 => payout should be auto-rejected
    expect(txPayoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pay-1" },
        data: expect.objectContaining({
          status: "REJECTED",
          adminNote: "auto-voided: all linked commissions reversed",
        }),
      })
    );
  });

  it("recomputes payout amountUsd when some commissions remain", async () => {
    const txCommissionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txPayoutFindMany = vi.fn().mockResolvedValue([
      { id: "pay-2", status: "PENDING", networkFeeUsd: 0 },
    ]);
    const txCommissionAggregate = vi.fn().mockResolvedValue({
      _sum: { commissionUsd: 40 },
    });
    const txPayoutUpdate = vi.fn().mockResolvedValue({});

    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralCommission: {
          updateMany: txCommissionUpdateMany,
          aggregate: txCommissionAggregate,
        },
        referralPayout: {
          findMany: txPayoutFindMany,
          update: txPayoutUpdate,
        },
      })
    );

    const result = await voidCommission("STRIPE", "in_456", "partial-refund");

    expect(result.voided).toBe(1);

    // Remaining sum > 0 => payout should be updated with new amounts
    expect(txPayoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pay-2" },
        data: expect.objectContaining({
          amountUsd: 40,
          netPayoutUsd: 40, // 40 - 0 networkFee
        }),
      })
    );
    // Should NOT set status REJECTED
    const callData = txPayoutUpdate.mock.calls[0][0].data;
    expect(callData.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// voidReferrerCommissions
// ---------------------------------------------------------------------------

describe("voidReferrerCommissions", () => {
  it("voids all non-paid commissions for a referrer, detaches from open payout, wraps in transaction", async () => {
    const txCommissionUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    // Two commissions, one PAYOUT_PENDING linked to "pay-3"
    const txPayoutFindMany = vi.fn().mockResolvedValue([
      { id: "pay-3", status: "PENDING", networkFeeUsd: 0 },
    ]);
    const txCommissionAggregate = vi.fn().mockResolvedValue({
      _sum: { commissionUsd: 0 },
    });
    const txPayoutUpdate = vi.fn().mockResolvedValue({});

    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralCommission: {
          updateMany: txCommissionUpdateMany,
          aggregate: txCommissionAggregate,
        },
        referralPayout: {
          findMany: txPayoutFindMany,
          update: txPayoutUpdate,
        },
      })
    );

    const result = await voidReferrerCommissions("ref-1", "ban");

    expect(result.voided).toBe(2);

    // Commission update must set status VOIDED + payoutId null + reason
    expect(txCommissionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          referrerId: "ref-1",
          status: { in: ["PENDING", "AVAILABLE", "PAYOUT_PENDING"] },
        }),
        data: expect.objectContaining({
          status: "VOIDED",
          adminNote: "ban",
          payoutId: null,
        }),
      })
    );

    // All commissions removed => payout auto-rejected
    expect(txPayoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pay-3" },
        data: expect.objectContaining({
          status: "REJECTED",
          adminNote: "auto-voided: all linked commissions reversed",
        }),
      })
    );
  });

  it("recomputes payout when partial void - remaining $40", async () => {
    const txCommissionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txPayoutFindMany = vi.fn().mockResolvedValue([
      { id: "pay-4", status: "PENDING", networkFeeUsd: 0 },
    ]);
    const txCommissionAggregate = vi.fn().mockResolvedValue({
      _sum: { commissionUsd: 40 },
    });
    const txPayoutUpdate = vi.fn().mockResolvedValue({});

    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralCommission: {
          updateMany: txCommissionUpdateMany,
          aggregate: txCommissionAggregate,
        },
        referralPayout: {
          findMany: txPayoutFindMany,
          update: txPayoutUpdate,
        },
      })
    );

    const result = await voidReferrerCommissions("ref-1", "partial-ban");

    expect(result.voided).toBe(1);

    expect(txPayoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pay-4" },
        data: expect.objectContaining({
          amountUsd: 40,
          netPayoutUsd: 40,
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// markPayoutPaid
// ---------------------------------------------------------------------------

describe("markPayoutPaid", () => {
  it("does not resurrect voided commissions: updateMany uses status PAYOUT_PENDING filter", async () => {
    const txPayoutUpdate = vi.fn().mockResolvedValue({});
    const txCommissionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralPayout: { update: txPayoutUpdate },
        referralCommission: { updateMany: txCommissionUpdateMany },
      })
    );

    await markPayoutPaid("pay-1", "tx-abc");

    // Payout update must guard status
    expect(txPayoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "pay-1",
          status: { in: ["PENDING", "APPROVED"] },
        }),
      })
    );

    // Commission flip must include status: "PAYOUT_PENDING" in where
    expect(txCommissionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payoutId: "pay-1",
          status: "PAYOUT_PENDING",
        }),
        data: expect.objectContaining({ status: "PAID" }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// approvePayout
// ---------------------------------------------------------------------------

describe("approvePayout", () => {
  it("only approves a PENDING payout via updateMany status guard", async () => {
    mocks.payoutFindUniqueOrThrow.mockResolvedValue({
      id: "pay-1",
      amountUsd: 100,
      networkFeeUsd: 2,
    });
    mocks.payoutUpdateMany.mockResolvedValue({ count: 1 });

    await approvePayout("pay-1", "admin-tg", 2);

    expect(mocks.payoutUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "pay-1",
          status: "PENDING",
        }),
        data: expect.objectContaining({
          status: "APPROVED",
          networkFeeUsd: 2,
          netPayoutUsd: 98,
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// rejectPayout
// ---------------------------------------------------------------------------

describe("rejectPayout", () => {
  it("guards payout update with status PENDING or APPROVED", async () => {
    const txPayoutUpdate = vi.fn().mockResolvedValue({});
    const txCommissionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralPayout: { update: txPayoutUpdate },
        referralCommission: { updateMany: txCommissionUpdateMany },
      })
    );

    await rejectPayout("pay-1", "fraud");

    expect(txPayoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "pay-1",
          status: { in: ["PENDING", "APPROVED"] },
        }),
        data: expect.objectContaining({ status: "REJECTED" }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// releaseMaturedCommissions (unchanged)
// ---------------------------------------------------------------------------

describe("releaseMaturedCommissions", () => {
  it("flips matured PENDING commissions to AVAILABLE", async () => {
    mocks.commissionUpdateMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-05-20T00:00:00Z");
    const result = await releaseMaturedCommissions(now);
    expect(result.released).toBe(3);
    expect(mocks.commissionUpdateMany).toHaveBeenCalledWith({
      where: { status: "PENDING", availableAt: { lte: now } },
      data: { status: "AVAILABLE" },
    });
  });
});

// ---------------------------------------------------------------------------
// runPayoutBatch (unchanged)
// ---------------------------------------------------------------------------

describe("runPayoutBatch", () => {
  it("creates a payout and locks commissions for referrers above the minimum", async () => {
    mocks.commissionGroupBy.mockResolvedValue([
      { referrerId: "ref-1", _sum: { commissionUsd: 60 } },
      { referrerId: "ref-2", _sum: { commissionUsd: 10 } }, // below $50, skipped
    ]);
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-1",
      payoutDestination: "Tabc...",
      payoutMethod: "USDT_TRC20",
    });
    // $transaction runs the callback with a tx client; reuse the same mocks.
    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralPayout: { create: mocks.payoutCreate },
        referralCommission: { updateMany: mocks.commissionUpdateMany },
      })
    );
    mocks.payoutCreate.mockResolvedValue({ id: "pay-1" });
    mocks.commissionUpdateMany.mockResolvedValue({ count: 2 });

    const now = new Date("2026-06-01T00:00:00Z");
    const result = await runPayoutBatch(now);

    expect(result.created).toBe(1);
    expect(mocks.payoutCreate).toHaveBeenCalledTimes(1);
    const created = mocks.payoutCreate.mock.calls[0][0].data;
    expect(created.referrerId).toBe("ref-1");
    expect(created.amountUsd).toBe(60);
    expect(created.destination).toBe("Tabc...");
  });

  it("skips referrers without a payout destination", async () => {
    mocks.commissionGroupBy.mockResolvedValue([
      { referrerId: "ref-3", _sum: { commissionUsd: 80 } },
    ]);
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-3",
      payoutDestination: null,
      payoutMethod: null,
    });
    const result = await runPayoutBatch(new Date("2026-06-01T00:00:00Z"));
    expect(result.created).toBe(0);
    expect(mocks.payoutCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validatePayoutDestination (unchanged)
// ---------------------------------------------------------------------------

describe("validatePayoutDestination", () => {
  it("accepts a valid PayPal email", () => {
    expect(validatePayoutDestination("PAYPAL", "a@b.com").ok).toBe(true);
  });
  it("rejects a bad PayPal email", () => {
    expect(validatePayoutDestination("PAYPAL", "nope").ok).toBe(false);
  });
  it("accepts a TRON address", () => {
    expect(
      validatePayoutDestination("USDT_TRC20", "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X").ok
    ).toBe(true);
  });
  it("rejects a non-TRON address", () => {
    expect(validatePayoutDestination("USDT_TRC20", "0xabc").ok).toBe(false);
  });
  it("accepts non-empty bank text", () => {
    expect(validatePayoutDestination("BANK", "DE89 3704 0044 0532 0130 00").ok).toBe(true);
  });
  it("rejects an unknown method", () => {
    expect(validatePayoutDestination("CASH", "x").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getReferralBalance (unchanged)
// ---------------------------------------------------------------------------

describe("getReferralBalance", () => {
  it("aggregates pending, available, and paid", async () => {
    mocks.commissionGroupBy.mockResolvedValue([
      { status: "PENDING", _sum: { commissionUsd: 5 } },
      { status: "AVAILABLE", _sum: { commissionUsd: 60 } },
      { status: "PAYOUT_PENDING", _sum: { commissionUsd: 12 } },
      { status: "PAID", _sum: { commissionUsd: 100 } },
    ]);
    const balance = await getReferralBalance("ref-1");
    expect(balance.pendingUsd).toBe(5);
    expect(balance.availableUsd).toBe(60);
    expect(balance.payoutPendingUsd).toBe(12);
    expect(balance.paidUsd).toBe(100);
  });
});
