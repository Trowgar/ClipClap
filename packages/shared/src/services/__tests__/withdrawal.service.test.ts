import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  txFn: vi.fn(),
  wrFindFirst: vi.fn(),
  wrCreate: vi.fn(),
  wrFindUnique: vi.fn(),
  wrUpdateMany: vi.fn(),
  wrUpdate: vi.fn(),
  entryCreate: vi.fn(),
  entryAggregate: vi.fn(),
  withdrawalAggregate: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $transaction: mocks.txFn,
    withdrawalRequest: {
      findFirst: mocks.wrFindFirst,
      create: mocks.wrCreate,
      findUnique: mocks.wrFindUnique,
      updateMany: mocks.wrUpdateMany,
      update: mocks.wrUpdate,
      aggregate: mocks.withdrawalAggregate,
    },
    walletEntry: { create: mocks.entryCreate, aggregate: mocks.entryAggregate },
  },
}));

import {
  validateWithdrawalDestination,
  createWithdrawal,
  approveWithdrawal,
  markWithdrawalPaid,
  rejectWithdrawal,
} from "../withdrawal.service";

beforeEach(() => vi.clearAllMocks());

describe("validateWithdrawalDestination", () => {
  it("accepts a TRON address for USDT_TRC20", () => {
    expect(validateWithdrawalDestination("USDT_TRC20", "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X").ok).toBe(true);
  });
  it("rejects an EVM address for USDT_TRC20", () => {
    expect(validateWithdrawalDestination("USDT_TRC20", "0xabc").ok).toBe(false);
  });
  it("rejects an unknown method", () => {
    expect(validateWithdrawalDestination("DOGE", "x").ok).toBe(false);
  });
});

describe("createWithdrawal", () => {
  function wireTx() {
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        walletEntry: { aggregate: mocks.entryAggregate },
        withdrawalRequest: {
          aggregate: mocks.withdrawalAggregate,
          findFirst: mocks.wrFindFirst,
          create: mocks.wrCreate,
        },
      })
    );
  }

  it("creates a PENDING request when available covers the amount", async () => {
    wireTx();
    mocks.entryAggregate
      .mockResolvedValueOnce({ _sum: { amountUsd: 100 } }) // credit
      .mockResolvedValueOnce({ _sum: { amountUsd: 0 } });  // debit
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 0 } }); // locked
    mocks.wrFindFirst.mockResolvedValue(null);
    mocks.wrCreate.mockResolvedValue({ id: "wr1" });

    const r = await createWithdrawal("u1", {
      method: "USDT_TRC20", destination: "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X", amountUsd: 60,
    });
    expect(r.status).toBe("created");
    const data = mocks.wrCreate.mock.calls[0][0].data;
    expect(data.status).toBe("PENDING");
    expect(data.requestedAvailableUsd).toBe(100);
    expect(data.netAmountUsd).toBe(60);
  });

  it("rejects below minimum", async () => {
    wireTx();
    mocks.entryAggregate
      .mockResolvedValueOnce({ _sum: { amountUsd: 100 } }) // credit
      .mockResolvedValueOnce({ _sum: { amountUsd: 0 } });  // debit
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 0 } });
    mocks.wrFindFirst.mockResolvedValue(null);
    const r = await createWithdrawal("u1", {
      method: "USDT_TRC20", destination: "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X", amountUsd: 10,
    });
    expect(r.status).toBe("error");
    expect(mocks.wrCreate).not.toHaveBeenCalled();
  });

  it("rejects when an active request exists", async () => {
    wireTx();
    mocks.entryAggregate
      .mockResolvedValueOnce({ _sum: { amountUsd: 100 } }) // credit
      .mockResolvedValueOnce({ _sum: { amountUsd: 0 } });  // debit
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 0 } });
    mocks.wrFindFirst.mockResolvedValue({ id: "existing" });
    const r = await createWithdrawal("u1", {
      method: "USDT_TRC20", destination: "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X", amountUsd: 60,
    });
    expect(r.status).toBe("error");
    expect(mocks.wrCreate).not.toHaveBeenCalled();
  });

  it("rejects amount above available", async () => {
    wireTx();
    mocks.entryAggregate
      .mockResolvedValueOnce({ _sum: { amountUsd: 100 } })
      .mockResolvedValueOnce({ _sum: { amountUsd: 0 } });
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 80 } }); // available 20
    mocks.wrFindFirst.mockResolvedValue(null);
    const r = await createWithdrawal("u1", {
      method: "USDT_TRC20", destination: "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X", amountUsd: 60,
    });
    expect(r.status).toBe("error");
  });
});

describe("approveWithdrawal", () => {
  it("rejects a fee >= amount", async () => {
    mocks.wrFindUnique.mockResolvedValue({ id: "wr1", userId: "u1", amountUsd: 50, status: "PENDING" });
    const r = await approveWithdrawal("wr1", "admin1", 60);
    expect(r.ok).toBe(false);
  });
});

describe("markWithdrawalPaid", () => {
  function wireTx() {
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        withdrawalRequest: { findUnique: mocks.wrFindUnique, update: mocks.wrUpdate },
        walletEntry: { create: mocks.entryCreate },
      })
    );
  }

  it("pays an APPROVED request and writes a DEBIT for the gross amount", async () => {
    wireTx();
    mocks.wrFindUnique.mockResolvedValue({ id: "wr1", userId: "u1", amountUsd: 60, status: "APPROVED" });
    mocks.wrUpdate.mockResolvedValue({});
    mocks.entryCreate.mockResolvedValue({ id: "e1" });

    const r = await markWithdrawalPaid("wr1", "admin1", "0xtx");
    expect(r.ok).toBe(true);
    const debit = mocks.entryCreate.mock.calls[0][0].data;
    expect(debit).toMatchObject({
      userId: "u1", kind: "DEBIT", source: "WITHDRAWAL",
      refType: "withdrawal", refId: "wr1", amountUsd: 60,
    });
  });

  it("refuses to pay a non-APPROVED request and writes no DEBIT", async () => {
    wireTx();
    mocks.wrFindUnique.mockResolvedValue({ id: "wr1", userId: "u1", amountUsd: 60, status: "PENDING" });
    const r = await markWithdrawalPaid("wr1", "admin1", "0xtx");
    expect(r.ok).toBe(false);
    expect(mocks.entryCreate).not.toHaveBeenCalled();
  });
});

describe("rejectWithdrawal", () => {
  it("requires a non-empty reason", async () => {
    const r = await rejectWithdrawal("wr1", "admin1", "   ");
    expect(r.ok).toBe(false);
    expect(mocks.wrUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects an active request", async () => {
    mocks.wrUpdateMany.mockResolvedValue({ count: 1 });
    const r = await rejectWithdrawal("wr1", "admin1", "fraud");
    expect(r.ok).toBe(true);
    const arg = mocks.wrUpdateMany.mock.calls[0][0];
    expect(arg.where.status.in).toEqual(["PENDING", "APPROVED"]);
    expect(arg.data.status).toBe("REJECTED");
  });

  it("fails on a terminal request (count 0)", async () => {
    mocks.wrUpdateMany.mockResolvedValue({ count: 0 });
    const r = await rejectWithdrawal("wr1", "admin1", "fraud");
    expect(r.ok).toBe(false);
  });
});
