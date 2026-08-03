import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userCreate: vi.fn(),
  userUpdateMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { create: mocks.userCreate, updateMany: mocks.userUpdateMany },
  },
}));

import {
  createSyntheticUser,
  isSyntheticEmail,
  markSyntheticByEmail,
  syntheticEmail,
  SYNTHETIC_EMAIL_DOMAIN,
} from "../synthetic.service";

describe("isSyntheticEmail", () => {
  it("recognises the reserved domain and the historical one", () => {
    expect(isSyntheticEmail("proof@test.local")).toBe(true);
    expect(isSyntheticEmail("old-run@test.com")).toBe(true);
    expect(isSyntheticEmail("PROOF@TEST.LOCAL")).toBe(true);
  });

  it("does not match a domain that merely contains one", () => {
    // A substring match would call this a fixture and make a real person
    // invisible - the mirror image of the bug the flag exists to fix.
    expect(isSyntheticEmail("evil@notreally-test.local.com")).toBe(false);
    expect(isSyntheticEmail("someone@gmail.com")).toBe(false);
  });

  it("survives junk instead of throwing on it", () => {
    expect(isSyntheticEmail(null)).toBe(false);
    expect(isSyntheticEmail(undefined)).toBe(false);
    expect(isSyntheticEmail("not-an-address")).toBe(false);
  });
});

describe("syntheticEmail", () => {
  it("mints a unique address in the reserved domain", () => {
    const a = syntheticEmail("usage-proof");
    const b = syntheticEmail("usage-proof");

    expect(a).toContain(`@${SYNTHETIC_EMAIL_DOMAIN}`);
    expect(a.startsWith("usage-proof-")).toBe(true);
    // Unique per call, so a re-run does not collide with the row the previous
    // one left behind and fail on the unique index instead of doing its job.
    expect(a).not.toBe(b);
    expect(isSyntheticEmail(a)).toBe(true);
  });
});

describe("createSyntheticUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forces the flag on, whatever the caller passed", async () => {
    mocks.userCreate.mockResolvedValue({ id: "u1" });

    await createSyntheticUser({ email: "proof@test.local", name: "Proof" });

    expect(mocks.userCreate).toHaveBeenCalledWith({
      data: { email: "proof@test.local", name: "Proof", isSynthetic: true },
    });
  });
});

describe("markSyntheticByEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("matches the address as given AND lowercased", async () => {
    // /api/register stores email.trim().toLowerCase(), so a suite that
    // registered `Case-1@Test.COM` and asked to mark that exact string would
    // match nothing and leave a row that looks real to every figure.
    await markSyntheticByEmail([" Case-1@Test.COM "]);

    expect(mocks.userUpdateMany).toHaveBeenCalledWith({
      where: { email: { in: ["Case-1@Test.COM", "case-1@test.com"] } },
      data: { isSynthetic: true },
    });
  });

  it("does nothing at all when given nothing", async () => {
    // An empty `in` list is the difference between a no-op and marking the
    // entire user table as synthetic, which would erase the product from its
    // own analytics.
    await expect(markSyntheticByEmail([])).resolves.toBe(0);
    await expect(markSyntheticByEmail(["", "   "])).resolves.toBe(0);
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });
});
