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

import { sweepExpiredClips, sweepRedundantSourceCopies } from "../retention.service";

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

describe("sweepRedundantSourceCopies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.clipFindMany.mockResolvedValue([]);
  });

  it("only looks at terminal jobs past the grace that were never swept", async () => {
    mocks.jobFindMany.mockResolvedValue([]);

    await sweepRedundantSourceCopies(NOW);

    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["DONE", "FAILED"] },
          createdAt: { lt: new Date("2026-07-26T12:00:00Z") },
          sourceSweptAt: null,
        },
      })
    );
  });

  it("drops the upload and the raw artifact, keeps the normalized one", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job1",
        sourceKey: "uploads/u1/original.mp4",
        sourceArtifactKey: "work/u1/job1/source.mp4",
        normalizedArtifactKey: "work/u1/job1/normalized.mp4",
      },
    ]);

    const result = await sweepRedundantSourceCopies(NOW);

    const deleted = mocks.deleteFile.mock.calls.map((c: any[]) => c[0]);
    expect(deleted).toEqual([
      "uploads/u1/original.mp4",
      "work/u1/job1/source.mp4",
    ]);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: {
        sourceKey: null,
        sourceArtifactKey: null,
        sourceSweptAt: NOW,
      },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("NEVER deletes the source artifact when it IS the normalized one", async () => {
    // normalizeSource returning "none" stores the same key in both columns.
    // Deleting it here would destroy the only source a live job has, and null
    // a column renderTrim reads.
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job2",
        sourceKey: null,
        sourceArtifactKey: "work/u1/job2/source.mp4",
        normalizedArtifactKey: "work/u1/job2/source.mp4",
      },
    ]);

    const result = await sweepRedundantSourceCopies(NOW);

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    // Still stamped: there was nothing to do, and without the stamp this row
    // re-enters the page on every run for ever.
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job2" },
      data: { sourceSweptAt: NOW },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("does not stamp or null anything when a delete fails", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job3",
        sourceKey: "uploads/u1/original.mp4",
        sourceArtifactKey: null,
        normalizedArtifactKey: "work/u1/job3/normalized.mp4",
      },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepRedundantSourceCopies(NOW);

    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, failed: 1 });
  });

  it("writes nothing in dry-run mode", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job4",
        sourceKey: "uploads/u1/original.mp4",
        sourceArtifactKey: "work/u1/job4/source.mp4",
        normalizedArtifactKey: "work/u1/job4/normalized.mp4",
      },
    ]);

    const result = await sweepRedundantSourceCopies(NOW, { dryRun: true });

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 1, failed: 0 });
  });
});
