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
  entryCreate: vi.fn(),
  entryFindUnique: vi.fn(),
  entryAggregate: vi.fn(),
  entryGroupBy: vi.fn(),
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
    walletEntry: {
      create: mocks.entryCreate,
      findUnique: mocks.entryFindUnique,
      aggregate: mocks.entryAggregate,
      groupBy: mocks.entryGroupBy,
    },
    $transaction: mocks.txFn,
  },
}));

// wallet.service is imported by referral.service - mock it so wallet calls are captured
vi.mock("../wallet.service", () => ({
  postWalletEntry: vi.fn(async (_tx: unknown, _input: unknown) => {}),
  getWalletBalance: vi.fn(async () => ({ ledgerBalanceUsd: 0, lockedUsd: 0, availableUsd: 0, paidOutUsd: 0 })),
  getEarningsBySource: vi.fn(async () => ({})),
}));

import {
  attachReferral,
  recordCommission,
  voidCommission,
  voidReferrerCommissions,
  releaseMaturedCommissions,
  getReferralStats,
} from "../referral.service";

import { postWalletEntry } from "../wallet.service";

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
// releaseMaturedCommissions (wallet)
// ---------------------------------------------------------------------------

describe("releaseMaturedCommissions (wallet)", () => {
  it("flips matured PENDING commissions to AVAILABLE and posts a wallet CREDIT each", async () => {
    mocks.commissionFindMany.mockResolvedValue([
      { id: "c1", referrerId: "r1", commissionUsd: 5 },
      { id: "c2", referrerId: "r1", commissionUsd: 3 },
    ]);
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => Promise<void>) =>
      cb({ referralCommission: { updateMany: mocks.commissionUpdateMany }, walletEntry: { create: mocks.entryCreate, findUnique: mocks.entryFindUnique } })
    );
    mocks.commissionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.entryCreate.mockResolvedValue({ id: "w" });

    const r = await releaseMaturedCommissions(new Date("2026-06-01T00:00:00Z"));
    expect(r.released).toBe(2);
    expect(postWalletEntry).toHaveBeenCalledTimes(2);
    const firstCall = (postWalletEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[1]).toMatchObject({
      userId: "r1", kind: "CREDIT", source: "REFERRAL",
      refType: "referral_commission", refId: "c1", amountUsd: 5,
    });
  });

  it("skips already-released commissions (idempotent: updateMany count=0)", async () => {
    mocks.commissionFindMany.mockResolvedValue([
      { id: "c1", referrerId: "r1", commissionUsd: 5 },
    ]);
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => Promise<void>) =>
      cb({ referralCommission: { updateMany: mocks.commissionUpdateMany }, walletEntry: { create: mocks.entryCreate, findUnique: mocks.entryFindUnique } })
    );
    mocks.commissionUpdateMany.mockResolvedValue({ count: 0 }); // already done

    const r = await releaseMaturedCommissions(new Date("2026-06-01T00:00:00Z"));
    expect(r.released).toBe(0);
    expect(postWalletEntry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// voidCommission (wallet clawback)
// ---------------------------------------------------------------------------

describe("voidCommission (wallet clawback)", () => {
  it("credited commission -> clawback DEBIT posted (ledger-driven)", async () => {
    mocks.commissionFindMany.mockResolvedValue([
      { id: "c1", referrerId: "r1" },
    ]);
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => Promise<void>) =>
      cb({ referralCommission: { updateMany: mocks.commissionUpdateMany }, walletEntry: { create: mocks.entryCreate, findUnique: mocks.entryFindUnique } })
    );
    mocks.commissionUpdateMany.mockResolvedValue({ count: 1 });
    // walletEntry.findUnique returns a CREDIT row -> clawback should fire
    mocks.entryFindUnique.mockResolvedValue({ amountUsd: 5 });
    mocks.entryCreate.mockResolvedValue({ id: "w" });

    const r = await voidCommission("STRIPE", "in_1", "refund");
    expect(r.voided).toBe(1);
    const call = (postWalletEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toMatchObject({
      kind: "DEBIT", source: "REFERRAL", refType: "referral_clawback", refId: "c1", amountUsd: 5,
    });
  });

  it("not-credited commission -> no DEBIT (no wallet entry found)", async () => {
    mocks.commissionFindMany.mockResolvedValue([{ id: "c1", referrerId: "r1" }]);
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => Promise<void>) =>
      cb({ referralCommission: { updateMany: mocks.commissionUpdateMany }, walletEntry: { create: mocks.entryCreate, findUnique: mocks.entryFindUnique } })
    );
    mocks.commissionUpdateMany.mockResolvedValue({ count: 1 });
    // walletEntry.findUnique returns null -> no CREDIT was ever posted
    mocks.entryFindUnique.mockResolvedValue(null);

    const r = await voidCommission("STRIPE", "in_2", "refund");
    expect(r.voided).toBe(1);
    expect(postWalletEntry).not.toHaveBeenCalled();
  });

  it("returns voided:0 when no matching commissions", async () => {
    mocks.commissionFindMany.mockResolvedValue([]);
    const r = await voidCommission("STRIPE", "in_none", "refund");
    expect(r.voided).toBe(0);
    expect(mocks.txFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// voidReferrerCommissions (wallet clawback)
// ---------------------------------------------------------------------------

describe("voidReferrerCommissions", () => {
  it("credited commission -> clawback DEBIT; non-credited -> no DEBIT (ledger-driven)", async () => {
    mocks.commissionFindMany.mockResolvedValue([
      { id: "c1", referrerId: "ref-1" },
      { id: "c2", referrerId: "ref-1" },
    ]);
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => Promise<void>) =>
      cb({ referralCommission: { updateMany: mocks.commissionUpdateMany }, walletEntry: { create: mocks.entryCreate, findUnique: mocks.entryFindUnique } })
    );
    mocks.commissionUpdateMany.mockResolvedValue({ count: 2 });
    // c1 has a CREDIT entry (amountUsd 10); c2 does not
    mocks.entryFindUnique
      .mockResolvedValueOnce({ amountUsd: 10 })
      .mockResolvedValueOnce(null);

    const result = await voidReferrerCommissions("ref-1", "ban");
    expect(result.voided).toBe(2);
    // Only c1 gets a clawback DEBIT
    expect(postWalletEntry).toHaveBeenCalledTimes(1);
    const call = (postWalletEntry as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toMatchObject({
      kind: "DEBIT", source: "REFERRAL", refType: "referral_clawback", refId: "c1", amountUsd: 10,
    });
  });

  it("returns voided:0 when nothing to void", async () => {
    mocks.commissionFindMany.mockResolvedValue([]);
    const result = await voidReferrerCommissions("ref-1", "ban");
    expect(result.voided).toBe(0);
    expect(mocks.txFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getReferralStats
// ---------------------------------------------------------------------------

describe("getReferralStats", () => {
  it("returns pending commissions and wallet referral credits", async () => {
    mocks.commissionAggregate.mockResolvedValue({ _sum: { commissionUsd: 12 } });
    mocks.entryAggregate.mockResolvedValue({ _sum: { amountUsd: 40 } });
    const s = await getReferralStats("r1");
    expect(s.pendingUsd).toBe(12);
    expect(s.earnedUsd).toBe(40);
  });

  it("defaults nulls to 0", async () => {
    mocks.commissionAggregate.mockResolvedValue({ _sum: { commissionUsd: null } });
    mocks.entryAggregate.mockResolvedValue({ _sum: { amountUsd: null } });
    const s = await getReferralStats("r1");
    expect(s.pendingUsd).toBe(0);
    expect(s.earnedUsd).toBe(0);
  });
});
