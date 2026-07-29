import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShopOrder, cancelShopOrder, getShopOrder } from "../tribute-shop.service";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.TRIBUTE_API_KEY = "test-key";
  process.env.TRIBUTE_API_BASE = "https://tribute.tg/api/v1";
  process.env.TELEGRAM_BOT_USERNAME = "clipclapio_bot";
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("createShopOrder", () => {
  it("posts a card recurring order and returns uuid + webappPaymentUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ uuid: "ord-1", webappPaymentUrl: "https://t.me/tribute/app?startapp=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createShopOrder({
      plan: "MAX",
      billingCycle: "MONTHLY",
      telegramId: "42",
      checkoutIntentId: "ci-1",
    });

    expect(result).toEqual({ uuid: "ord-1", webappPaymentUrl: "https://t.me/tribute/app?startapp=x" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tribute.tg/api/v1/shop/orders");
    expect(init.headers["Api-Key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      currency: "eur",
      amount: 8900,
      period: "monthly",
      customerId: "42",
      comment: "clipclap-checkout:ci-1",
    });
    expect(body.successUrl).toBe("https://t.me/clipclapio_bot");
    expect(body.failUrl).toBe("https://t.me/clipclapio_bot");
    // Never sets starsAmount (guarantees a card order).
    expect("starsAmount" in body).toBe(false);
  });

  it("throws when the API returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad" }));
    await expect(
      createShopOrder({ plan: "STARTER", billingCycle: "WEEKLY", telegramId: "1", checkoutIntentId: "c" })
    ).rejects.toThrow(/400/);
  });
});

describe("cancelShopOrder", () => {
  it("posts to the cancel endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await cancelShopOrder("ord-9");
    expect(fetchMock.mock.calls[0][0]).toBe("https://tribute.tg/api/v1/shop/orders/ord-9/cancel");
  });
});

describe("getShopOrder", () => {
  it("GETs /shop/orders/{uuid} with the Api-Key header and returns the parsed order", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "paid", memberExpiresAt: "2026-08-01T00:00:00Z" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const order = await getShopOrder("uuid-1");

    expect(order.status).toBe("paid");
    expect(order.memberExpiresAt).toBe("2026-08-01T00:00:00Z");
    expect(fetchMock.mock.calls[0][0]).toBe("https://tribute.tg/api/v1/shop/orders/uuid-1");
    expect(fetchMock.mock.calls[0][1].headers["Api-Key"]).toBe("test-key");
  });

  it("throws when the API returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "nope" }));
    await expect(getShopOrder("x")).rejects.toThrow(/404/);
  });
});
