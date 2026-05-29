import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
      updateMany: mocks.userUpdateMany,
    },
  },
}));

import { attachReferral } from "../referral.service";

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
