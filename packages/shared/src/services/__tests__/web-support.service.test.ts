import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  queryRaw: vi.fn(),
  sendTelegram: vi.fn(),
  supportChatId: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: (() => {
    const tx = {
    user: { findUnique: mocks.findUnique },
    supportMessage: {
      findUnique: mocks.findFirst,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      count: mocks.count,
      create: mocks.create,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
      $queryRaw: mocks.queryRaw,
    };
    return { ...tx, $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  })(),
}));
vi.mock("../telegram-notification.service", () => ({
  sendTelegramMessage: mocks.sendTelegram,
  getSupportChatId: mocks.supportChatId,
}));

import {
  SupportRateLimitError,
  countUnreadWebSupport,
  listWebSupportMessages,
  markWebSupportRead,
  storeWebSupportReply,
  submitWebSupportMessage,
} from "../support-log.service";

const id = "12345678-1234-1234-1234-123456789abc";
const pending = {
  id: "m1", userId: "u1", telegramId: null, surface: "web", direction: "in",
  text: "The upload stops", kind: "text", deliveryStatus: "pending",
  dedupeKey: `web:u1:${id}`, contextPath: "/dashboard/projects/p1",
  readAt: null, emailNotifiedAt: null, createdAt: new Date(),
  updatedAt: new Date(),
  deliveryClaim: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supportChatId.mockReturnValue("777");
  mocks.findUnique.mockResolvedValue({ id: "u1", email: "a@example.test", name: "Ann" });
  mocks.findFirst.mockResolvedValue(null);
  mocks.count.mockResolvedValue(0);
  mocks.create.mockImplementation(async ({ data }: { data: object }) => ({ ...pending, ...data }));
  mocks.findUniqueOrThrow.mockResolvedValue(pending);
  mocks.update.mockImplementation(async ({ data }: { data: object }) => ({ ...pending, ...data }));
  mocks.updateMany.mockResolvedValue({ count: 2 });
  mocks.findMany.mockResolvedValue([pending]);
  mocks.sendTelegram.mockResolvedValue(true);
});

describe("submitWebSupportMessage", () => {
  it("stores the authenticated user's message and relays server-owned context", async () => {
    const result = await submitWebSupportMessage({
      userId: "u1", clientMessageId: id, text: "The upload stops",
      contextPath: "/dashboard/projects/p1",
    });

    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      surface: "web", userId: "u1", direction: "in", text: "The upload stops",
      deliveryStatus: "pending", dedupeKey: `web:u1:${id}`,
      contextPath: "/dashboard/projects/p1",
    }) });
    expect(mocks.sendTelegram).toHaveBeenCalledWith("777", expect.stringMatching(
      /^🆕 #webu1 Ann \(a@example\.test\)\nContext: \/dashboard\/projects\/p1\n\nThe upload stops$/
    ));
    expect(result.deliveryStatus).toBe("sent");
  });

  it("returns a sent duplicate without notifying Telegram twice", async () => {
    mocks.findFirst.mockResolvedValue({ ...pending, deliveryStatus: "sent" });
    const result = await submitWebSupportMessage({ userId: "u1", clientMessageId: id, text: "ignored" });
    expect(result.deliveryStatus).toBe("sent");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("reclaims a stale pending relay but leaves a fresh claim alone", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      ...pending, updatedAt: new Date(Date.now() - 121_000),
    });
    await submitWebSupportMessage({ userId: "u1", clientMessageId: id, text: pending.text });
    expect(mocks.sendTelegram).toHaveBeenCalledOnce();

    mocks.sendTelegram.mockClear();
    mocks.findFirst.mockResolvedValue({ ...pending, updatedAt: new Date() });
    await submitWebSupportMessage({ userId: "u1", clientMessageId: id, text: pending.text });
    expect(mocks.sendTelegram).not.toHaveBeenCalled();
  });

  it("retries the same failed row rather than creating a duplicate", async () => {
    mocks.findFirst.mockResolvedValue({ ...pending, deliveryStatus: "failed" });
    await submitWebSupportMessage({ userId: "u1", clientMessageId: id, text: pending.text });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sendTelegram).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { deliveryStatus: "pending", deliveryClaim: expect.any(String) },
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", deliveryClaim: expect.any(String) },
      data: { deliveryStatus: "sent", deliveryClaim: null },
    });
  });

  it("marks a relay failure honestly", async () => {
    mocks.sendTelegram.mockResolvedValue(false);
    const result = await submitWebSupportMessage({ userId: "u1", clientMessageId: id, text: pending.text });
    expect(result.deliveryStatus).toBe("failed");
  });

  it("does not let an expired relay claim overwrite its replacement", async () => {
    const replacement = { ...pending, deliveryClaim: "new-claim", updatedAt: new Date() };
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    mocks.findUniqueOrThrow.mockResolvedValueOnce(replacement);
    const result = await submitWebSupportMessage({
      userId: "u1", clientMessageId: id, text: pending.text,
    });
    expect(result).toEqual(replacement);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", deliveryClaim: expect.any(String) },
      data: { deliveryStatus: "sent", deliveryClaim: null },
    });
  });

  it("keeps a maximum-length message inside Telegram's 4096 character limit", async () => {
    const text = "x".repeat(4000);
    mocks.create.mockResolvedValue({ ...pending, text });
    mocks.findUnique.mockResolvedValue({
      id: "u1", name: "A".repeat(120), email: `${"b".repeat(120)}@example.test`,
    });
    await submitWebSupportMessage({
      userId: "u1", clientMessageId: id, text,
      contextPath: `/dashboard/projects/${"p".repeat(300)}`,
    });
    const relayed = mocks.sendTelegram.mock.calls[0][1] as string;
    expect(relayed.length).toBeLessThanOrEqual(4096);
    expect(relayed.endsWith(text)).toBe(true);
  });

  it("limits new messages but still permits retries", async () => {
    mocks.count.mockResolvedValue(10);
    await expect(submitWebSupportMessage({ userId: "u1", clientMessageId: id, text: "new" }))
      .rejects.toBeInstanceOf(SupportRateLimitError);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("web support replies and reads", () => {
  it("stores one operator reply and identifies the first unread reply", async () => {
    const reply = { ...pending, id: "r1", direction: "out", text: "Try again", deliveryStatus: "sent" };
    mocks.create.mockResolvedValue(reply);
    const result = await storeWebSupportReply({
      userId: "u1", text: "Try again", supportChatId: "777", telegramMessageId: 42,
    });
    expect(result).toMatchObject({ message: reply, created: true, shouldNotify: true });
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      surface: "web", userId: "u1", direction: "out", deliveryStatus: "sent",
      dedupeKey: "web-reply:777:42",
    }) });
  });

  it("does not notify for a duplicate or when an older reply is unread", async () => {
    const reply = { ...pending, id: "r1", direction: "out" };
    mocks.findFirst.mockResolvedValueOnce(reply);
    await expect(storeWebSupportReply({ userId: "u1", text: "x", supportChatId: "777", telegramMessageId: 42 }))
      .resolves.toMatchObject({ created: false, shouldNotify: false });
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "older" });
    mocks.create.mockResolvedValue(reply);
    await expect(storeWebSupportReply({ userId: "u1", text: "x", supportChatId: "777", telegramMessageId: 43 }))
      .resolves.toMatchObject({ created: true, shouldNotify: false });
  });

  it("lists, counts and marks only this user's web replies", async () => {
    await expect(listWebSupportMessages("u1")).resolves.toEqual([pending]);
    await expect(countUnreadWebSupport("u1")).resolves.toBe(0);
    await expect(markWebSupportRead("u1", ["r1", "r2"])).resolves.toBe(2);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1", surface: "web" } }));
    expect(mocks.count).toHaveBeenCalledWith({ where: {
      userId: "u1", surface: "web", direction: "out", readAt: null,
    } });
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: {
      id: { in: ["r1", "r2"] }, userId: "u1", surface: "web", direction: "out", readAt: null,
    }, data: { readAt: expect.any(Date) } });
    expect(mocks.queryRaw).toHaveBeenCalled();
  });
});
