import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  getShopOrder: vi.fn(),
  applyPaidOrder: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tributeOrder: { findMany: mocks.findMany, update: mocks.update },
  },
}));

vi.mock("../tribute-shop.service", () => ({
  getShopOrder: mocks.getShopOrder,
}));

vi.mock("../tribute.service", () => ({
  applyPaidOrder: mocks.applyPaidOrder,
}));

import { reconcilePendingTributeOrders } from "../tribute-reconcile.service";

const NOW = new Date("2026-07-24T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orderUuid: "order-1",
    userId: "user-1",
    plan: "PRO",
    billingCycle: "MONTHLY",
    status: "PENDING",
    createdAt: new Date(NOW.getTime() - 2 * HOUR),
    ...overrides,
  };
}

describe("reconcilePendingTributeOrders", () => {
  const ORIGINAL_ENV = process.env.TRIBUTE_RECONCILE_LIVE;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyPaidOrder.mockResolvedValue({ status: "activated", userId: "user-1", plan: "PRO" });
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TRIBUTE_RECONCILE_LIVE;
    else process.env.TRIBUTE_RECONCILE_LIVE = ORIGINAL_ENV;
  });

  it("activates a paid order when live", async () => {
    process.env.TRIBUTE_RECONCILE_LIVE = "true";
    const order = makeOrder();
    mocks.findMany.mockResolvedValue([order]);
    mocks.getShopOrder.mockResolvedValue({ status: "paid", memberExpiresAt: "2026-08-01T00:00:00Z" });

    const result = await reconcilePendingTributeOrders(NOW);

    expect(mocks.applyPaidOrder).toHaveBeenCalledTimes(1);
    expect(mocks.applyPaidOrder).toHaveBeenCalledWith(
      order,
      new Date("2026-08-01T00:00:00Z"),
      false
    );
    expect(result).toMatchObject({ activated: 1 });
  });

  it("marks a failed remote order as FAILED when live", async () => {
    process.env.TRIBUTE_RECONCILE_LIVE = "true";
    const order = makeOrder({ orderUuid: "order-2" });
    mocks.findMany.mockResolvedValue([order]);
    mocks.getShopOrder.mockResolvedValue({ status: "failed" });

    const result = await reconcilePendingTributeOrders(NOW);

    expect(mocks.update).toHaveBeenCalledWith({
      where: { orderUuid: "order-2" },
      data: { status: "FAILED" },
    });
    expect(result).toMatchObject({ failed: 1 });
  });

  it("expires a still-pending order older than 24h when live", async () => {
    process.env.TRIBUTE_RECONCILE_LIVE = "true";
    const order = makeOrder({
      orderUuid: "order-3",
      createdAt: new Date(NOW.getTime() - DAY - HOUR),
    });
    mocks.findMany.mockResolvedValue([order]);
    mocks.getShopOrder.mockResolvedValue({ status: "pending" });

    const result = await reconcilePendingTributeOrders(NOW);

    expect(mocks.update).toHaveBeenCalledWith({
      where: { orderUuid: "order-3" },
      data: { status: "FAILED" },
    });
    expect(result).toMatchObject({ expired: 1 });
  });

  it("leaves a recent still-pending order untouched", async () => {
    process.env.TRIBUTE_RECONCILE_LIVE = "true";
    const order = makeOrder({
      orderUuid: "order-4",
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    mocks.findMany.mockResolvedValue([order]);
    mocks.getShopOrder.mockResolvedValue({ status: "pending" });

    const result = await reconcilePendingTributeOrders(NOW);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.applyPaidOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ activated: 0, failed: 0, expired: 0 });
  });

  it("skips an order whose status fetch throws and continues to the next", async () => {
    process.env.TRIBUTE_RECONCILE_LIVE = "true";
    const badOrder = makeOrder({ orderUuid: "order-bad" });
    const goodOrder = makeOrder({ orderUuid: "order-good", userId: "user-2" });
    mocks.findMany.mockResolvedValue([badOrder, goodOrder]);
    mocks.getShopOrder.mockImplementation(async (uuid: string) => {
      if (uuid === "order-bad") throw new Error("tribute API down");
      return { status: "paid", memberExpiresAt: "2026-08-01T00:00:00Z" };
    });

    const result = await reconcilePendingTributeOrders(NOW);

    expect(mocks.applyPaidOrder).toHaveBeenCalledTimes(1);
    expect(mocks.applyPaidOrder).toHaveBeenCalledWith(
      goodOrder,
      new Date("2026-08-01T00:00:00Z"),
      false
    );
    expect(result).toMatchObject({ activated: 1 });
  });

  it("dry-runs when the killswitch is off: no writes, but counts what would happen", async () => {
    delete process.env.TRIBUTE_RECONCILE_LIVE;
    const order = makeOrder({ orderUuid: "order-5" });
    mocks.findMany.mockResolvedValue([order]);
    mocks.getShopOrder.mockResolvedValue({ status: "paid", memberExpiresAt: "2026-08-01T00:00:00Z" });

    const result = await reconcilePendingTributeOrders(NOW);

    expect(mocks.applyPaidOrder).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ activated: 1 });
  });
});
