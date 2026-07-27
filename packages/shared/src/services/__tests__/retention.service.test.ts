import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clipFindMany: vi.fn(),
  clipUpdate: vi.fn(),
  jobFindMany: vi.fn(),
  jobUpdate: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    clip: { findMany: mocks.clipFindMany, update: mocks.clipUpdate },
    job: { findMany: mocks.jobFindMany, update: mocks.jobUpdate },
  },
}));

vi.mock("../../lib/r2", () => ({ deleteFile: mocks.deleteFile }));

import { sweepExpiredClips } from "../retention.service";

const NOW = new Date("2026-07-27T12:00:00Z");

describe("sweepExpiredClips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.jobFindMany.mockResolvedValue([]);
  });

  it("selects only clips that are past expiry and not already swept", async () => {
    mocks.clipFindMany.mockResolvedValue([]);

    await sweepExpiredClips(NOW);

    expect(mocks.clipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { expiresAt: { lte: NOW }, deletedAt: null },
      })
    );
  });

  it("drops the object and soft-deletes the row, keeping storageKey", async () => {
    mocks.clipFindMany.mockResolvedValue([
      { id: "c1", storageKey: "clips/u1/job1/a.mp4" },
    ]);

    const result = await sweepExpiredClips(NOW);

    expect(mocks.deleteFile).toHaveBeenCalledWith("clips/u1/job1/a.mp4");
    expect(mocks.clipUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { deletedAt: NOW },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("marks a clip with an empty storageKey without calling R2", async () => {
    // editClip inserts the row with storageKey "" and an expiresAt before the
    // render that fills it in. A render that never completed leaves a row that
    // expires with no object behind it.
    mocks.clipFindMany.mockResolvedValue([{ id: "c2", storageKey: "" }]);

    const result = await sweepExpiredClips(NOW);

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.clipUpdate).toHaveBeenCalledWith({
      where: { id: "c2" },
      data: { deletedAt: NOW },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("leaves deletedAt null when R2 refuses, so the next run retries", async () => {
    mocks.clipFindMany.mockResolvedValue([
      { id: "c3", storageKey: "clips/u1/job1/b.mp4" },
      { id: "c4", storageKey: "clips/u1/job1/c.mp4" },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepExpiredClips(NOW);

    expect(mocks.clipUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c3" } })
    );
    // One bad key must not abandon the rest of the page.
    expect(mocks.clipUpdate).toHaveBeenCalledWith({
      where: { id: "c4" },
      data: { deletedAt: NOW },
    });
    expect(result).toEqual({ swept: 1, failed: 1 });
  });

  it("writes nothing in dry-run mode", async () => {
    mocks.clipFindMany.mockResolvedValue([
      { id: "c5", storageKey: "clips/u1/job1/d.mp4" },
    ]);

    const result = await sweepExpiredClips(NOW, { dryRun: true });

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.clipUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 1, failed: 0 });
  });
});
