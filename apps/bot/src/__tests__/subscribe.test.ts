import { describe, expect, it } from "vitest";
import { parseSubCallback } from "../handlers";

describe("parseSubCallback", () => {
  it("parses supported plan/cycle pairs", () => {
    expect(parseSubCallback("sub:STARTER:WEEKLY")).toEqual({ plan: "STARTER", cycle: "WEEKLY" });
    expect(parseSubCallback("sub:MAX:MONTHLY")).toEqual({ plan: "MAX", cycle: "MONTHLY" });
    expect(parseSubCallback("sub:STARTER:MONTHLY")).toEqual({ plan: "STARTER", cycle: "MONTHLY" });
    expect(parseSubCallback("sub:PLUS:MONTHLY")).toEqual({ plan: "PLUS", cycle: "MONTHLY" });
  });
  it("rejects unsupported combos and junk", () => {
    expect(parseSubCallback("sub:PLUS:WEEKLY")).toBeNull();
    expect(parseSubCallback("sub:MAX:WEEKLY")).toBeNull();
    expect(parseSubCallback("sub:BOGUS:MONTHLY")).toBeNull();
    expect(parseSubCallback("lang_en")).toBeNull();
    expect(parseSubCallback(undefined)).toBeNull();
    expect(parseSubCallback("sub:STARTER:WEEKLY:extra")).toBeNull();
  });
});

import { beforeEach, vi } from "vitest";

const flowMocks = vi.hoisted(() => ({
  createShopOrder: vi.fn(),
  cancelShopOrder: vi.fn(),
  getTributeCatalogEntry: vi.fn(),
  orderFindFirst: vi.fn(),
  orderCreate: vi.fn(),
  recordConversionEvent: vi.fn(),
  recordFunnelEvent: vi.fn(),
}));

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    recordConversionEvent: flowMocks.recordConversionEvent,
    recordFunnelEvent: flowMocks.recordFunnelEvent,
    createShopOrder: flowMocks.createShopOrder,
    cancelShopOrder: flowMocks.cancelShopOrder,
    getTributeCatalogEntry: flowMocks.getTributeCatalogEntry,
    prisma: { tributeOrder: { findFirst: flowMocks.orderFindFirst, create: flowMocks.orderCreate } },
  };
});

import { handleSubscribeCallback } from "../handlers";
import { t } from "../i18n";

function fakeClient() {
  return {
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe("handleSubscribeCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flowMocks.getTributeCatalogEntry.mockReturnValue({ amount: 8900, currency: "eur", period: "monthly", title: "t", description: "d" });
    flowMocks.orderFindFirst.mockResolvedValue(null);
    flowMocks.cancelShopOrder.mockResolvedValue(undefined);
  });

  it("creates an order, persists it, and shows the Pay button", async () => {
    flowMocks.createShopOrder.mockResolvedValue({ uuid: "ord-1", webappPaymentUrl: "https://pay" });
    flowMocks.orderCreate.mockResolvedValue({});
    const client = fakeClient();
    const query = { id: "q", from: { id: 42 }, message: { chat: { id: 7 }, message_id: 3 }, data: "sub:MAX:MONTHLY" };

    await handleSubscribeCallback(client, query as never, t("en"), { id: "user-1" } as never);

    expect(flowMocks.createShopOrder).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "MAX", billingCycle: "MONTHLY", telegramId: "42" })
    );
    expect(flowMocks.orderCreate).toHaveBeenCalled();
    const editArgs = (client as unknown as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText.mock.calls[0];
    expect(JSON.stringify(editArgs)).toContain("https://pay");
    // The checkout message names the plan the user is subscribing to.
    expect(JSON.stringify(editArgs)).toContain("Max");
    expect(flowMocks.recordConversionEvent).toHaveBeenCalledWith("bot", "42", "offer_clicked", expect.objectContaining({ plan: "MAX", cycle: "MONTHLY" }), "bot:buy:q");
    expect(flowMocks.recordConversionEvent).toHaveBeenCalledWith("bot", "42", "checkout_started", expect.objectContaining({ orderUuid: "ord-1", sessionId: "ord-1", provider: "tribute" }), "bot:checkout:ord-1");
  });

  it("reuses a fresh PENDING order instead of creating a new one", async () => {
    flowMocks.orderFindFirst.mockResolvedValue({ payUrl: "https://reused-pay", orderUuid: "ord-reused" });
    const client = fakeClient();
    const query = { id: "q", from: { id: 42 }, message: { chat: { id: 7 }, message_id: 3 }, data: "sub:MAX:MONTHLY" };
    await handleSubscribeCallback(client, query as never, t("en"), { id: "user-1" } as never);
    expect(flowMocks.createShopOrder).not.toHaveBeenCalled();
    expect(flowMocks.orderCreate).not.toHaveBeenCalled();
    const editArgs = (client as unknown as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText.mock.calls[0];
    expect(JSON.stringify(editArgs)).toContain("https://reused-pay");
    await handleSubscribeCallback(client, { ...query, id: "q2" } as never, t("en"), { id: "user-1" });
    const sessions = flowMocks.recordConversionEvent.mock.calls.filter(call => call[2] === "checkout_started");
    expect(sessions).toHaveLength(2);
    expect(sessions.map(call => call[4])).toEqual(["bot:checkout:ord-reused", "bot:checkout:ord-reused"]);
  });

  it("does not count a checkout whose message could not be delivered", async () => {
    flowMocks.orderFindFirst.mockResolvedValue({ payUrl: "https://pay", orderUuid: "ord-hidden" });
    const client = { editMessageText: vi.fn().mockRejectedValue(new Error("send failed")) };
    await handleSubscribeCallback(client as never, { id: "q", from: { id: 42 }, message: { chat: { id: 7 }, message_id: 3 }, data: "sub:MAX:MONTHLY" } as never, t("en"), { id: "user-1" });
    expect(flowMocks.recordConversionEvent.mock.calls.filter(call => call[2] === "checkout_started")).toHaveLength(0);
    expect(flowMocks.recordFunnelEvent).not.toHaveBeenCalled();
  });

  it("best-effort cancels the remote order when the local insert fails", async () => {
    flowMocks.createShopOrder.mockResolvedValue({ uuid: "ord-2", webappPaymentUrl: "https://pay" });
    flowMocks.orderCreate.mockRejectedValue(new Error("db down"));
    const client = fakeClient();
    const query = { id: "q", from: { id: 42 }, message: { chat: { id: 7 }, message_id: 3 }, data: "sub:MAX:MONTHLY" };

    await handleSubscribeCallback(client, query as never, t("en"), { id: "user-1" } as never);

    expect(flowMocks.cancelShopOrder).toHaveBeenCalledWith("ord-2");
    expect((client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).toHaveBeenCalled();
  });
});
