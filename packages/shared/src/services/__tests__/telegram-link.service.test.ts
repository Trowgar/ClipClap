import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenCreate: vi.fn(),
  tokenFindUnique: vi.fn(),
  tokenUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  accountFindUnique: vi.fn(),
  accountCreate: vi.fn(),
  accountUpdate: vi.fn(),
  accountDeleteMany: vi.fn(),
  jobUpdateMany: vi.fn(),
  clipUpdateMany: vi.fn(),
  telegramDeliveryUpdateMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../lib/prisma", () => {
  const txClient = {
    job: { updateMany: mocks.jobUpdateMany },
    clip: { updateMany: mocks.clipUpdateMany },
    telegramDelivery: { updateMany: mocks.telegramDeliveryUpdateMany },
    account: {
      findUnique: mocks.accountFindUnique,
      create: mocks.accountCreate,
      update: mocks.accountUpdate,
      deleteMany: mocks.accountDeleteMany,
    },
    user: {
      update: mocks.userUpdate,
      delete: mocks.userDelete,
    },
    telegramLinkToken: {
      update: mocks.tokenUpdate,
    },
  };
  mocks.transaction.mockImplementation(async (fn: (tx: typeof txClient) => unknown) =>
    fn(txClient)
  );
  return {
    prisma: {
      telegramLinkToken: {
        create: mocks.tokenCreate,
        findUnique: mocks.tokenFindUnique,
        update: mocks.tokenUpdate,
      },
      user: {
        findUnique: mocks.userFindUnique,
        update: mocks.userUpdate,
        delete: mocks.userDelete,
      },
      account: {
        findUnique: mocks.accountFindUnique,
        create: mocks.accountCreate,
        update: mocks.accountUpdate,
        deleteMany: mocks.accountDeleteMany,
      },
      job: { updateMany: mocks.jobUpdateMany },
      clip: { updateMany: mocks.clipUpdateMany },
      telegramDelivery: { updateMany: mocks.telegramDeliveryUpdateMany },
      $transaction: mocks.transaction,
    },
  };
});

import {
  createBotInitiatedLink,
  createBrowserInitiatedLink,
  redeemLinkFromBot,
  redeemLinkFromBrowser,
} from "../telegram-link.service";

describe("telegram-link.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobUpdateMany.mockResolvedValue({ count: 0 });
    mocks.clipUpdateMany.mockResolvedValue({ count: 0 });
    mocks.telegramDeliveryUpdateMany.mockResolvedValue({ count: 0 });
    mocks.accountDeleteMany.mockResolvedValue({ count: 0 });
  });

  it("issues a 6-char bot-initiated token bound to a Telegram id", async () => {
    mocks.tokenCreate.mockResolvedValue({});
    const result = await createBotInitiatedLink({ telegramId: "12345" });
    expect(result.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(mocks.tokenCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ telegramId: "12345", code: result.code }),
    });
  });

  it("issues a browser-initiated token bound to a user id", async () => {
    mocks.tokenCreate.mockResolvedValue({});
    const result = await createBrowserInitiatedLink({ userId: "user1" });
    expect(mocks.tokenCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user1", code: result.code }),
    });
  });

  it("returns invalid_code when token does not exist", async () => {
    mocks.tokenFindUnique.mockResolvedValue(null);
    expect(await redeemLinkFromBot({ code: "ABC123", telegramId: "1" })).toEqual({
      status: "invalid_code",
    });
  });

  it("returns expired for past TTL", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "u1",
      telegramId: null,
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
    });
    expect(await redeemLinkFromBot({ code: "X", telegramId: "tg1" })).toEqual({
      status: "expired",
    });
  });

  it("returns consumed for an already-redeemed token", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "u1",
      telegramId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(),
    });
    expect(await redeemLinkFromBot({ code: "X", telegramId: "tg1" })).toEqual({
      status: "consumed",
    });
  });

  it("rejects bot redemption of a bot-initiated token (wrong direction)", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: null,
      telegramId: "tg1",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    expect(await redeemLinkFromBot({ code: "X", telegramId: "tg1" })).toEqual({
      status: "wrong_direction",
    });
  });

  it("returns already_linked without merging when Telegram id matches target", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "user1",
      telegramId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "user1",
      telegramId: "tg1",
    });
    const result = await redeemLinkFromBot({ code: "X", telegramId: "tg1" });
    expect(result).toEqual({ status: "already_linked", userId: "user1" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.tokenUpdate).toHaveBeenCalledWith({
      where: { code: "X" },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("blocks linking when target already has a different Telegram id", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "user1",
      telegramId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "user1",
      telegramId: "tg-old",
    });
    expect(await redeemLinkFromBot({ code: "X", telegramId: "tg-new" })).toEqual({
      status: "target_already_linked",
    });
  });

  it("merges orphan account, transfers jobs/clips and links Telegram id", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "userMain",
      telegramId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    mocks.userFindUnique
      .mockResolvedValueOnce({ id: "userMain", telegramId: null })
      .mockResolvedValueOnce({ id: "orphan1", telegramId: "tg1" });
    mocks.jobUpdateMany.mockResolvedValue({ count: 3 });
    mocks.clipUpdateMany.mockResolvedValue({ count: 7 });
    mocks.accountFindUnique.mockResolvedValue(null);

    const result = await redeemLinkFromBot({ code: "X", telegramId: "tg1" });
    expect(result).toEqual({
      status: "linked",
      userId: "userMain",
      mergedJobs: 3,
      mergedClips: 7,
    });

    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { userId: "orphan1" },
      data: { userId: "userMain" },
    });
    expect(mocks.clipUpdateMany).toHaveBeenCalledWith({
      where: { userId: "orphan1" },
      data: { userId: "userMain" },
    });
    expect(mocks.telegramDeliveryUpdateMany).toHaveBeenCalledWith({
      where: { userId: "orphan1" },
      data: { userId: "userMain" },
    });
    expect(mocks.accountDeleteMany).toHaveBeenCalledWith({
      where: { userId: "orphan1", provider: "telegram" },
    });
    expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: "orphan1" } });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "userMain" },
      data: { telegramId: "tg1" },
    });
    expect(mocks.accountCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "userMain",
        provider: "telegram",
        providerAccountId: "tg1",
      }),
    });
  });

  // The orphan row is the only place a bot-side language choice lives, and it
  // is deleted by the merge. Without carrying it over, someone who picked a
  // language in the bot on purpose has it reverted to whatever their Telegram
  // client reports the next time they send a message.
  it("carries the orphan's language onto a target that has none", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "userMain",
      telegramId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    mocks.userFindUnique
      .mockResolvedValueOnce({ id: "userMain", telegramId: null, telegramLocale: null })
      .mockResolvedValueOnce({ id: "orphan1", telegramId: "tg1", telegramLocale: "en" });
    mocks.jobUpdateMany.mockResolvedValue({ count: 0 });
    mocks.clipUpdateMany.mockResolvedValue({ count: 0 });
    mocks.accountFindUnique.mockResolvedValue(null);

    await redeemLinkFromBot({ code: "X", telegramId: "tg1" });

    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "userMain" },
      data: { telegramId: "tg1", telegramLocale: "en" },
    });
  });

  it("does not overwrite a language the target already has", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "userMain",
      telegramId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    mocks.userFindUnique
      .mockResolvedValueOnce({ id: "userMain", telegramId: null, telegramLocale: "ru" })
      .mockResolvedValueOnce({ id: "orphan1", telegramId: "tg1", telegramLocale: "en" });
    mocks.jobUpdateMany.mockResolvedValue({ count: 0 });
    mocks.clipUpdateMany.mockResolvedValue({ count: 0 });
    mocks.accountFindUnique.mockResolvedValue(null);

    await redeemLinkFromBot({ code: "X", telegramId: "tg1" });

    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "userMain" },
      data: { telegramId: "tg1" },
    });
  });

  it("links without orphan merge when Telegram id has no existing user", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "userMain",
      telegramId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    mocks.userFindUnique
      .mockResolvedValueOnce({ id: "userMain", telegramId: null })
      .mockResolvedValueOnce(null);
    mocks.accountFindUnique.mockResolvedValue(null);

    const result = await redeemLinkFromBot({ code: "X", telegramId: "tg-new" });
    expect(result).toEqual({
      status: "linked",
      userId: "userMain",
      mergedJobs: 0,
      mergedClips: 0,
    });
    expect(mocks.userDelete).not.toHaveBeenCalled();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });

  it("redeems a bot-initiated token from the browser side", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: null,
      telegramId: "tg1",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    mocks.userFindUnique
      .mockResolvedValueOnce({ id: "userMain", telegramId: null })
      .mockResolvedValueOnce({ id: "orphan1", telegramId: "tg1" });
    mocks.jobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.clipUpdateMany.mockResolvedValue({ count: 0 });
    mocks.accountFindUnique.mockResolvedValue(null);

    const result = await redeemLinkFromBrowser({ code: "X", userId: "userMain" });
    expect(result).toEqual({
      status: "linked",
      userId: "userMain",
      mergedJobs: 1,
      mergedClips: 0,
    });
  });

  it("rejects browser redemption of a browser-initiated token", async () => {
    mocks.tokenFindUnique.mockResolvedValue({
      code: "X",
      userId: "userMain",
      telegramId: null,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    expect(
      await redeemLinkFromBrowser({ code: "X", userId: "userMain" })
    ).toEqual({ status: "wrong_direction" });
  });
});
