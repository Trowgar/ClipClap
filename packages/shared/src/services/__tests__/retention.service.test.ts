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

import {
  sweepExpiredClips,
  sweepRedundantSourceCopies,
  sweepExpiredArtifacts,
  runRetentionSweep,
  SWEEP_PAGE_SIZE,
} from "../retention.service";

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
        orderBy: { expiresAt: "asc" },
        take: SWEEP_PAGE_SIZE,
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

  it("only looks at terminal jobs past the grace that were never swept, excluding jobs touched recently", async () => {
    mocks.jobFindMany.mockResolvedValue([]);

    await sweepRedundantSourceCopies(NOW);

    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["DONE", "FAILED"] },
          createdAt: { lt: new Date("2026-07-26T12:00:00Z") },
          sourceSweptAt: null,
          // FAILED is written on EVERY BullMQ attempt, not just the last, so a
          // job mid-retry can look terminal. processingStartedAt is refreshed
          // at the start of every attempt, so "not touched since the cutoff"
          // is the reliable signal that a retry is not still in flight.
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lt: new Date("2026-07-26T12:00:00Z") } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: SWEEP_PAGE_SIZE,
      })
    );
  });

  it("excludes a job that's old enough by createdAt but was touched recently", async () => {
    // The where-clause shape above is what Postgres actually filters on -
    // this test exists to spell out, in plain terms, the case that shape is
    // for: createdAt is old, but a worker is mid-retry.
    mocks.jobFindMany.mockResolvedValue([]);

    await sweepRedundantSourceCopies(NOW);

    const cutoff = new Date("2026-07-26T12:00:00Z");
    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lt: cutoff } },
          ],
        }),
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

  it("NEVER deletes the source artifact when normalizedArtifactKey is null", async () => {
    // normalizedArtifactKey null means there is no normalized copy at all -
    // sourceArtifactKey is the ONLY source, because every consumer falls back
    // to it via `normalizedArtifactKey ?? sourceArtifactKey`. The naive
    // `sourceArtifactKey !== normalizedArtifactKey` guard is true here (X !==
    // null), which would wrongly delete a job's only remaining source.
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job6",
        sourceKey: null,
        sourceArtifactKey: "work/u1/job6/source.mp4",
        normalizedArtifactKey: null,
      },
    ]);

    const result = await sweepRedundantSourceCopies(NOW);

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    // Still stamped: nothing failed, there was just nothing to do for that
    // column.
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job6" },
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

  it("nulls the confirmed-deleted column but withholds the stamp when the other key fails", async () => {
    // sourceKey's delete fails, sourceArtifactKey's delete succeeds. The row
    // must still be retried next hour (no sourceSweptAt), but the column whose
    // object is confirmed gone must not be left pointing at nothing.
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job5",
        sourceKey: "uploads/u1/orig2.mp4",
        sourceArtifactKey: "work/u1/job5/source.mp4",
        normalizedArtifactKey: "work/u1/job5/normalized.mp4",
      },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepRedundantSourceCopies(NOW);

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job5" },
      data: { sourceArtifactKey: null },
    });
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

describe("sweepExpiredArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.clipFindMany.mockResolvedValue([]);
  });

  it("selects terminal jobs past the 7-day window that still hold a key, excluding jobs touched recently", async () => {
    mocks.jobFindMany.mockResolvedValue([]);

    await sweepExpiredArtifacts(NOW);

    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["DONE", "FAILED"] },
          createdAt: { lt: new Date("2026-07-20T12:00:00Z") },
          // Two OR conditions can't share one object literal, so both are
          // nested under AND: "still holds a key" and "not touched recently".
          AND: [
            {
              OR: [
                { sourceKey: { not: null } },
                { sourceArtifactKey: { not: null } },
                { normalizedArtifactKey: { not: null } },
              ],
            },
            {
              OR: [
                { processingStartedAt: null },
                { processingStartedAt: { lt: new Date("2026-07-20T12:00:00Z") } },
              ],
            },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: SWEEP_PAGE_SIZE,
      })
    );
  });

  it("excludes a job that's old enough by createdAt but was touched recently", async () => {
    mocks.jobFindMany.mockResolvedValue([]);

    await sweepExpiredArtifacts(NOW);

    const cutoff = new Date("2026-07-20T12:00:00Z");
    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: [
                { processingStartedAt: null },
                { processingStartedAt: { lt: cutoff } },
              ],
            },
          ]),
        }),
      })
    );
  });

  it("deletes every remaining key once and nulls all three columns", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job1",
        sourceKey: null,
        sourceArtifactKey: "work/u1/job1/source.mp4",
        normalizedArtifactKey: "work/u1/job1/source.mp4",
      },
    ]);

    const result = await sweepExpiredArtifacts(NOW);

    // Same string in both columns - one object, one delete call.
    expect(mocks.deleteFile.mock.calls.map((c: any[]) => c[0])).toEqual([
      "work/u1/job1/source.mp4",
    ]);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: {
        sourceArtifactKey: null,
        normalizedArtifactKey: null,
      },
    });
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it("leaves every column set when a delete fails, so the next run retries", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job2",
        sourceKey: null,
        sourceArtifactKey: null,
        normalizedArtifactKey: "work/u1/job2/normalized.mp4",
      },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepExpiredArtifacts(NOW);

    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, failed: 1 });
  });

  it("nulls only the column of the key that was confirmed deleted, leaving the failed one set", async () => {
    // sourceKey's delete fails, sourceArtifactKey's delete succeeds. A partial
    // failure must still null the column whose object is confirmed gone -
    // otherwise that column outlives its object, which is exactly the state
    // the invariant forbids.
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job4",
        sourceKey: "uploads/u1/orig.mp4",
        sourceArtifactKey: "work/u1/job4/source.mp4",
        normalizedArtifactKey: null,
      },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepExpiredArtifacts(NOW);

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job4" },
      data: { sourceArtifactKey: null },
    });
    expect(result).toEqual({ swept: 0, failed: 1 });
  });

  it("nulls both columns sharing a confirmed-deleted key, even when a different key fails", async () => {
    // sourceArtifactKey and normalizedArtifactKey hold the SAME string (the
    // "none" normalization case). sourceKey is a distinct key whose delete
    // fails. The shared key's single delete succeeds, so BOTH columns that
    // hold it must be nulled in the same patch - nulling only one would leave
    // a live-looking column pointing at a deleted object.
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job5",
        sourceKey: "uploads/u1/orig2.mp4",
        sourceArtifactKey: "work/u1/job5/source.mp4",
        normalizedArtifactKey: "work/u1/job5/source.mp4",
      },
    ]);
    mocks.deleteFile.mockRejectedValueOnce(new Error("R2 503"));

    const result = await sweepExpiredArtifacts(NOW);

    expect(mocks.deleteFile.mock.calls.map((c: any[]) => c[0])).toEqual([
      "uploads/u1/orig2.mp4",
      "work/u1/job5/source.mp4",
    ]);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job5" },
      data: { sourceArtifactKey: null, normalizedArtifactKey: null },
    });
    expect(result).toEqual({ swept: 0, failed: 1 });
  });

  it("writes nothing in dry-run mode", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job3",
        sourceKey: null,
        sourceArtifactKey: null,
        normalizedArtifactKey: "work/u1/job3/normalized.mp4",
      },
    ]);

    const result = await sweepExpiredArtifacts(NOW, { dryRun: true });

    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 1, failed: 0 });
  });
});

describe("non-terminal jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clipFindMany.mockResolvedValue([]);
    mocks.jobFindMany.mockResolvedValue([]);
  });

  it("are excluded by both artifact rules, however old they are", async () => {
    await sweepRedundantSourceCopies(NOW);
    await sweepExpiredArtifacts(NOW);

    for (const call of mocks.jobFindMany.mock.calls) {
      expect(call[0].where.status).toEqual({ in: ["DONE", "FAILED"] });
    }
  });
});

describe("runRetentionSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RETENTION_SWEEP_DRY_RUN;
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.clipFindMany.mockResolvedValue([{ id: "c1", storageKey: "clips/a.mp4" }]);
    mocks.jobFindMany.mockResolvedValue([]);
  });

  it("runs all three rules and reports them separately", async () => {
    const result = await runRetentionSweep(NOW);

    expect(result).toEqual({
      clips: { swept: 1, failed: 0 },
      redundantSources: { swept: 0, failed: 0 },
      expiredArtifacts: { swept: 0, failed: 0 },
      dryRun: false,
    });
    expect(mocks.clipUpdate).toHaveBeenCalled();
  });

  it("touches nothing when RETENTION_SWEEP_DRY_RUN is set", async () => {
    process.env.RETENTION_SWEEP_DRY_RUN = "1";

    const result = await runRetentionSweep(NOW);

    expect(result.dryRun).toBe(true);
    expect(result.clips).toEqual({ swept: 1, failed: 0 });
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.clipUpdate).not.toHaveBeenCalled();
    expect(mocks.jobUpdate).not.toHaveBeenCalled();
  });

  it("treats an empty or absent flag as a live run", async () => {
    process.env.RETENTION_SWEEP_DRY_RUN = "";

    const result = await runRetentionSweep(NOW);

    expect(result.dryRun).toBe(false);
  });

  it("logs the summary via console.error when any rule reports a failure", async () => {
    // A revoked R2 credential makes every delete fail forever - console.log
    // buries that behind routine noise, so an all-failing run must be loud.
    mocks.deleteFile.mockRejectedValue(new Error("R2 503"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runRetentionSweep(NOW);

    // Distinct from dropObject's per-key "[retention] failed to delete ..."
    // error, which also starts with "[retention]" - "expired artifacts" only
    // ever appears in the run summary line.
    const summaryLine = (call: any[]) =>
      typeof call[0] === "string" && call[0].includes("expired artifacts");
    expect(errorSpy.mock.calls.some(summaryLine)).toBe(true);
    expect(logSpy.mock.calls.some(summaryLine)).toBe(false);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("keeps logging the summary via console.log when nothing fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runRetentionSweep(NOW);

    // Distinct from dropObject's per-key "[retention] failed to delete ..."
    // error, which also starts with "[retention]" - "expired artifacts" only
    // ever appears in the run summary line.
    const summaryLine = (call: any[]) =>
      typeof call[0] === "string" && call[0].includes("expired artifacts");
    expect(logSpy.mock.calls.some(summaryLine)).toBe(true);
    expect(errorSpy.mock.calls.some(summaryLine)).toBe(false);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
