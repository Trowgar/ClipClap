import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entryAggregate: vi.fn(),
  entryGroupBy: vi.fn(),
  entryCreate: vi.fn(),
  withdrawalAggregate: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    walletEntry: {
      aggregate: mocks.entryAggregate,
      groupBy: mocks.entryGroupBy,
      create: mocks.entryCreate,
    },
    withdrawalRequest: { aggregate: mocks.withdrawalAggregate },
  },
}));

import { getWalletBalance, postWalletEntry } from "../wallet.service";

beforeEach(() => vi.clearAllMocks());

describe("getWalletBalance", () => {
  it("computes ledger, locked, available, paidOut", async () => {
    mocks.entryAggregate
      .mockResolvedValueOnce({ _sum: { amountUsd: 120 } }) // CREDIT
      .mockResolvedValueOnce({ _sum: { amountUsd: 20 } })  // DEBIT
      .mockResolvedValueOnce({ _sum: { amountUsd: 20 } }); // WITHDRAWAL paidOut
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 30 } }); // locked

    const b = await getWalletBalance("u1");
    expect(b.ledgerBalanceUsd).toBe(100);
    expect(b.lockedUsd).toBe(30);
    expect(b.availableUsd).toBe(70);
    expect(b.paidOutUsd).toBe(20);
  });

  it("defaults missing sums to 0", async () => {
    mocks.entryAggregate.mockResolvedValue({ _sum: { amountUsd: null } });
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: null } });
    const b = await getWalletBalance("u1");
    expect(b).toEqual({ ledgerBalanceUsd: 0, lockedUsd: 0, availableUsd: 0, paidOutUsd: 0 });
  });
});

describe("postWalletEntry", () => {
  it("creates an entry via the given client", async () => {
    mocks.entryCreate.mockResolvedValue({ id: "w1" });
    await postWalletEntry(undefined, {
      userId: "u1", kind: "CREDIT", source: "REFERRAL",
      refType: "referral_commission", refId: "c1", amountUsd: 5,
    });
    expect(mocks.entryCreate).toHaveBeenCalledWith({
      data: {
        userId: "u1", kind: "CREDIT", source: "REFERRAL",
        refType: "referral_commission", refId: "c1", amountUsd: 5, memo: undefined,
      },
    });
  });

  it("is idempotent on P2002 (duplicate)", async () => {
    mocks.entryCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(
      postWalletEntry(undefined, {
        userId: "u1", kind: "CREDIT", source: "REFERRAL",
        refType: "referral_commission", refId: "c1", amountUsd: 5,
      })
    ).resolves.toBeUndefined();
  });
});
