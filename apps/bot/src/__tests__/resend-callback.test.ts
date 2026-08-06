import { describe, expect, it, vi, beforeEach } from "vitest";

const findFirstMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());

vi.mock("@clipclap/shared", () => ({
  prisma: { telegramDelivery: { findFirst: findFirstMock, update: updateMock } },
  getObjectSize: vi.fn(),
  isPermanentTelegramError: (m: string) => m.includes("blocked"),
}));

vi.mock("../clip-file", () => ({ downloadToFile: vi.fn() }));

import { rearmDeliveryForResend } from "../clip-delivery";

beforeEach(() => vi.clearAllMocks());

describe("rearmDeliveryForResend", () => {
  it("re-arms a delivery that belongs to this user", async () => {
    findFirstMock.mockResolvedValue({ id: "d1" });
    await expect(rearmDeliveryForResend("job-1", "user-1")).resolves.toBe(true);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { status: "PENDING", attempts: 0, error: null },
    });
  });

  // Callback data is attacker-controlled: another user's job id must not
  // re-arm a delivery into someone else's chat.
  //
  // The query shape is asserted, not just the null answer. Under a mocked
  // prisma the mock returns null whatever it is asked, so dropping `userId`
  // from the where-clause - the whole guard - is invisible to a test that only
  // checks the return value. Mutation-checked: with `where: { jobId }` this
  // assertion is the one that fails.
  it("refuses a job that belongs to someone else", async () => {
    findFirstMock.mockResolvedValue(null);
    await expect(rearmDeliveryForResend("job-1", "intruder")).resolves.toBe(false);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { jobId: "job-1", userId: "intruder" },
      select: { id: true },
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
