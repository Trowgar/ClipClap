import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  accountCreate: vi.fn(),
  userCreate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    account: {
      findUnique: mocks.accountFindUnique,
      create: mocks.accountCreate,
    },
    user: {
      create: mocks.userCreate,
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
    },
  },
}));

import {
  TELEGRAM_AUTH_PROVIDER,
  ensureTelegramAuthAccount,
  findOrCreateTelegramUser,
  syncUserTelegramId,
} from "../telegram-auth.service";

describe("telegram-auth.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses an existing Telegram auth account", async () => {
    mocks.accountFindUnique.mockResolvedValue({ userId: "user1" });

    const result = await ensureTelegramAuthAccount("12345");

    expect(result).toEqual({ userId: "user1", linked: false });
    expect(mocks.accountCreate).not.toHaveBeenCalled();
  });

  it("links Auth.js Telegram account to an existing Telegram-only user", async () => {
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.userFindUnique.mockResolvedValue({ id: "user1" });

    const result = await ensureTelegramAuthAccount("12345");

    expect(result).toEqual({ userId: "user1", linked: true });
    expect(mocks.accountCreate).toHaveBeenCalledWith({
      data: {
        userId: "user1",
        type: "oidc",
        provider: TELEGRAM_AUTH_PROVIDER,
        providerAccountId: "12345",
      },
    });
  });

  it("returns null when no Telegram-only user exists yet", async () => {
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.userFindUnique.mockResolvedValue(null);

    await expect(ensureTelegramAuthAccount("12345")).resolves.toBeNull();
    expect(mocks.accountCreate).not.toHaveBeenCalled();
  });

  it("stores Telegram id on the signed-in user", async () => {
    await syncUserTelegramId("user1", "12345");

    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user1" },
      data: { telegramId: "12345" },
    });
  });

  it("finds an existing Telegram user and ensures its Auth.js account", async () => {
    const user = { id: "user1", telegramId: "12345" };
    mocks.userFindUnique.mockResolvedValue(user);
    mocks.accountFindUnique.mockResolvedValue(null);

    const result = await findOrCreateTelegramUser({
      id: 12345,
      firstName: "Ada",
      lastName: "Lovelace",
      username: "ada",
    });

    expect(result).toBe(user);
    expect(mocks.accountCreate).toHaveBeenCalledWith({
      data: {
        userId: "user1",
        type: "oidc",
        provider: TELEGRAM_AUTH_PROVIDER,
        providerAccountId: "12345",
      },
    });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("creates a Telegram-only user with an Auth.js account", async () => {
    const user = { id: "user1", telegramId: "12345" };
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue(user);
    mocks.accountFindUnique.mockResolvedValue({ userId: "user1" });

    const result = await findOrCreateTelegramUser({
      id: 12345,
      firstName: "Ada",
      lastName: "Lovelace",
      username: "ada",
      photoUrl: "https://cdn.example/avatar.jpg",
    });

    expect(result).toBe(user);
    expect(mocks.userCreate).toHaveBeenCalledWith({
      data: {
        telegramId: "12345",
        name: "Ada Lovelace",
        image: "https://cdn.example/avatar.jpg",
      },
    });
    expect(mocks.accountCreate).toHaveBeenCalledWith({
      data: {
        userId: "user1",
        type: "oidc",
        provider: TELEGRAM_AUTH_PROVIDER,
        providerAccountId: "12345",
      },
    });
  });
});
