import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    verificationToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
import { issueToken, redeemToken } from "../email-token.service";

describe("email-token.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores a hash, never the token it hands out", async () => {
    (prisma.verificationToken.create as any).mockResolvedValue({});
    const token = await issueToken("verify", "oleg@example.com");

    const stored = (prisma.verificationToken.create as any).mock.calls[0][0]
      .data.token;
    expect(token).toHaveLength(64);
    expect(stored).not.toBe(token);
    expect(stored).toHaveLength(64);
  });

  it("namespaces the identifier by purpose", async () => {
    (prisma.verificationToken.create as any).mockResolvedValue({});
    await issueToken("reset", "oleg@example.com");

    const identifier = (prisma.verificationToken.create as any).mock.calls[0][0]
      .data.identifier;
    expect(identifier).toBe("reset:oleg@example.com");
  });

  it("redeems a valid token once and deletes it", async () => {
    (prisma.verificationToken.findUnique as any).mockResolvedValue({
      identifier: "verify:oleg@example.com",
      token: "hashed",
      expires: new Date(Date.now() + 60_000),
    });
    (prisma.verificationToken.delete as any).mockResolvedValue({});

    const result = await redeemToken("verify", "raw-token");

    expect(result).toEqual({ ok: true, email: "oleg@example.com" });
    expect(prisma.verificationToken.delete).toHaveBeenCalledOnce();
  });

  it("refuses an expired token and deletes it", async () => {
    (prisma.verificationToken.findUnique as any).mockResolvedValue({
      identifier: "verify:oleg@example.com",
      token: "hashed",
      expires: new Date(Date.now() - 60_000),
    });
    (prisma.verificationToken.delete as any).mockResolvedValue({});

    const result = await redeemToken("verify", "raw-token");

    expect(result).toEqual({ ok: false, reason: "expired" });
    // Burned even though it was refused: an expired link must not linger to be
    // retried.
    expect(prisma.verificationToken.delete).toHaveBeenCalledOnce();
  });

  it("refuses a token issued for another purpose", async () => {
    (prisma.verificationToken.findUnique as any).mockResolvedValue({
      identifier: "reset:oleg@example.com",
      token: "hashed",
      expires: new Date(Date.now() + 60_000),
    });

    const result = await redeemToken("verify", "raw-token");

    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(prisma.verificationToken.delete).not.toHaveBeenCalled();
  });

  it("refuses an unknown token", async () => {
    (prisma.verificationToken.findUnique as any).mockResolvedValue(null);
    const result = await redeemToken("verify", "raw-token");
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });
});
