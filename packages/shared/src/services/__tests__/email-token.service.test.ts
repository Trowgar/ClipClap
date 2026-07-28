import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";

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

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Computed here, independently of the service, so the assertions below pin
 *  the actual hashing rather than whatever the implementation happens to do. */
const HASH_OF_RAW = sha256("raw-token");

const create = prisma.verificationToken.create as any;
const findUnique = prisma.verificationToken.findUnique as any;
const deleteMany = prisma.verificationToken.deleteMany as any;
const deleteOne = prisma.verificationToken.delete as any;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A row as the database would hand it back for HASH_OF_RAW. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    identifier: "verify:oleg@example.com",
    token: HASH_OF_RAW,
    expires: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("issueToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores a hash, never the token it hands out", async () => {
    create.mockResolvedValue({});
    const token = await issueToken("verify", "oleg@example.com");

    const stored = create.mock.calls[0][0].data.token;
    expect(token).toHaveLength(64);
    expect(stored).not.toBe(token);
    // The exact hash, not merely something hash-shaped: this is the half of
    // the round-trip that redeemToken has to be able to find again.
    expect(stored).toBe(sha256(token));
  });

  it("namespaces the identifier by purpose", async () => {
    create.mockResolvedValue({});
    await issueToken("reset", "oleg@example.com");

    expect(create.mock.calls[0][0].data.identifier).toBe(
      "reset:oleg@example.com"
    );
  });

  it("gives a verify link a day", async () => {
    create.mockResolvedValue({});
    const before = Date.now();
    await issueToken("verify", "oleg@example.com");

    const expires = create.mock.calls[0][0].data.expires.getTime();
    expect(expires).toBeGreaterThanOrEqual(before + DAY - 5_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + DAY);
  });

  it("gives a reset link one hour, not a day", async () => {
    create.mockResolvedValue({});
    const before = Date.now();
    await issueToken("reset", "oleg@example.com");

    const expires = create.mock.calls[0][0].data.expires.getTime();
    expect(expires).toBeGreaterThanOrEqual(before + HOUR - 5_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + HOUR);
    // Guards against the two TTLs being swapped, which would otherwise ship
    // day-long password reset links with every test still green.
    expect(expires).toBeLessThan(before + DAY);
  });

  it("invalidates any earlier link for the same identifier before issuing", async () => {
    create.mockResolvedValue({});
    deleteMany.mockResolvedValue({ count: 1 });

    await issueToken("reset", "oleg@example.com");

    expect(deleteMany).toHaveBeenCalledWith({
      where: { identifier: "reset:oleg@example.com" },
    });
    // Order matters: clearing after the insert would delete the new token too.
    expect(deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0]
    );
  });

  it("leaves other purposes for the same address alone", async () => {
    create.mockResolvedValue({});
    deleteMany.mockResolvedValue({ count: 0 });

    await issueToken("verify", "oleg@example.com");

    // Scoped to "verify:...", so asking for a new confirmation mail does not
    // silently cancel a password reset the user has in flight.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { identifier: "verify:oleg@example.com" },
    });
  });
});

describe("redeemToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("looks the row up by the hash of the token it was given", async () => {
    findUnique.mockResolvedValue(null);

    await redeemToken("verify", "raw-token");

    // Without this the service could look up the raw token, pass every other
    // test in this file, and fail on every real link in production.
    expect(findUnique).toHaveBeenCalledWith({
      where: { token: HASH_OF_RAW },
    });
  });

  it("redeems a valid token once and burns exactly that row", async () => {
    findUnique.mockResolvedValue(storedRow());
    deleteMany.mockResolvedValue({ count: 1 });

    const result = await redeemToken("verify", "raw-token");

    expect(result).toEqual({ ok: true, email: "oleg@example.com" });
    // By token, not by identifier: deleting by identifier would wipe every
    // link that address currently holds.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { token: HASH_OF_RAW },
    });
    expect(deleteMany).toHaveBeenCalledOnce();
  });

  it("refuses an expired token and burns it", async () => {
    findUnique.mockResolvedValue(
      storedRow({ expires: new Date(Date.now() - 60_000) })
    );
    deleteMany.mockResolvedValue({ count: 1 });

    const result = await redeemToken("verify", "raw-token");

    expect(result).toEqual({ ok: false, reason: "expired" });
    // Burned even though it was refused: an expired link must not linger to be
    // retried.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { token: HASH_OF_RAW },
    });
  });

  it("refuses the loser of two concurrent redemptions instead of throwing", async () => {
    findUnique.mockResolvedValue(storedRow());
    // The other request got there first and already removed the row.
    deleteMany.mockResolvedValue({ count: 0 });

    const result = await redeemToken("verify", "raw-token");

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses a token issued for another purpose, and leaves it alive", async () => {
    findUnique.mockResolvedValue(
      storedRow({ identifier: "reset:oleg@example.com" })
    );

    const result = await redeemToken("verify", "raw-token");

    expect(result).toEqual({ ok: false, reason: "not-found" });
    // A crafted verify URL must not be able to destroy a pending reset link.
    expect(deleteMany).not.toHaveBeenCalled();
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("refuses an unknown token", async () => {
    findUnique.mockResolvedValue(null);

    const result = await redeemToken("verify", "raw-token");

    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
