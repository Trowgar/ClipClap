import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobFindMany: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  jobFindFirst: vi.fn(),
  jobDelete: vi.fn(),
  deleteFile: vi.fn(),
  settleFreeLedgerOnDelete: vi.fn(),
  deleteForfeitsFreeSeconds: vi.fn(),
  freeUsageFindMany: vi.fn(),
  /** What ran, in order. The settlement has to be before the delete: after it,
   *  the job row that says whether the run failed no longer exists. */
  order: [] as string[],
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    job: {
      findMany: mocks.jobFindMany,
      findFirst: mocks.jobFindFirst,
      delete: mocks.jobDelete,
    },
    freeUsage: { findMany: mocks.freeUsageFindMany },
  },
}));

vi.mock("../../lib/r2", () => ({
  getPresignedDownloadUrl: mocks.getPresignedDownloadUrl,
  deleteFile: mocks.deleteFile,
}));

vi.mock("../free-tier.service", () => ({
  settleFreeLedgerOnDelete: mocks.settleFreeLedgerOnDelete,
  deleteForfeitsFreeSeconds: mocks.deleteForfeitsFreeSeconds,
}));

import {
  deleteProject,
  getProjectDetail,
  getRecentProjects,
  getUserProjects,
} from "../project.service";

describe("project.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPresignedDownloadUrl.mockImplementation(
      async (key: string) => `signed:${key}`
    );
    // Default: nothing is exposed, so the ledger is never asked. Tests that care
    // about the delete warning override both.
    mocks.deleteForfeitsFreeSeconds.mockReturnValue(false);
    mocks.freeUsageFindMany.mockResolvedValue([]);
  });

  it("returns three recent projects and reports when more exist", async () => {
    mocks.jobFindMany.mockResolvedValue([
      project("job1", "clips/u1/job1/clip.mp4", "work/u1/job1/thumb.jpg"),
      project("job2"),
      project("job3"),
      project("job4"),
    ]);

    const result = await getRecentProjects("u1");

    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        orderBy: { createdAt: "desc" },
        take: 4,
      })
    );
    expect(result.hasMore).toBe(true);
    expect(result.projects).toHaveLength(3);
    // Thumbnail is served from the 16:9 source still; the 9:16 clip preview is
    // kept too as a fallback for older projects that predate thumbnails.
    expect(result.projects[0].thumbnailUrl).toBe("signed:work/u1/job1/thumb.jpg");
    expect(result.projects[0].previewUrl).toBe("signed:clips/u1/job1/clip.mp4");
    expect(result.projects[1].thumbnailUrl).toBeNull();
  });

  it("returns all project summaries for the projects page", async () => {
    mocks.jobFindMany.mockResolvedValue([project("job1"), project("job2")]);

    const projects = await getUserProjects("u1");

    expect(projects).toHaveLength(2);
    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 })
    );
  });

  it("returns project detail with signed clip preview urls", async () => {
    const detail = project("job1", "clips/u1/job1/clip.mp4");
    mocks.jobFindMany.mockResolvedValue([detail]);

    const result = await getProjectDetail("job1", "u1");

    expect(result?.clips[0]).toEqual(
      expect.objectContaining({
        id: "clip-job1",
        previewUrl: "signed:clips/u1/job1/clip.mp4",
      })
    );
    expect(result?.clips[0]).not.toHaveProperty("storageKey");
  });

  it("marks a swept clip expired instead of signing a URL to a deleted object", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job1",
        userId: "u1",
        originalFilename: "job1.mp4",
        sourceUrl: null,
        sourceKey: "uploads/u1/job1.mp4",
        status: "DONE",
        error: null,
        sourceDurationSec: 60,
        createdAt: new Date("2026-05-10T00:00:00.000Z"),
        clipsGenerated: 2,
        noClipsReason: null,
        transcriptPartial: false,
        clips: [
          {
            id: "clip-live",
            title: "Live clip",
            storageKey: "clips/u1/job1/live.mp4",
            duration: 12,
            startTime: 4,
            endTime: 16,
            subtitles: true,
            parentClipId: null,
            createdAt: new Date("2026-05-10T00:01:00.000Z"),
            description: null,
            lowQuality: false,
            deletedAt: null,
          },
          {
            id: "clip-swept",
            title: "Swept clip",
            storageKey: "clips/u1/job1/swept.mp4",
            duration: 12,
            startTime: 20,
            endTime: 32,
            subtitles: true,
            parentClipId: null,
            createdAt: new Date("2026-05-10T00:02:00.000Z"),
            description: null,
            lowQuality: false,
            deletedAt: new Date("2026-07-20T00:00:00.000Z"),
          },
        ],
      },
    ]);

    const result = await getProjectDetail("job1", "u1");

    expect(result?.clips[0]).toEqual(
      expect.objectContaining({
        id: "clip-live",
        expired: false,
        previewUrl: "signed:clips/u1/job1/live.mp4",
      })
    );
    expect(result?.clips[1]).toEqual(
      expect.objectContaining({
        id: "clip-swept",
        expired: true,
        previewUrl: null,
      })
    );
    expect(mocks.getPresignedDownloadUrl).not.toHaveBeenCalledWith(
      "clips/u1/job1/swept.mp4"
    );
  });

  it("never picks a swept clip as the project card's poster frame", async () => {
    mocks.jobFindMany.mockResolvedValue([
      {
        id: "job1",
        userId: "u1",
        sourceUrl: null,
        sourceKey: "uploads/u1/job1.mp4",
        thumbnailKey: null,
        originalFilename: "job1.mp4",
        status: "DONE",
        error: null,
        sourceDurationSec: 60,
        createdAt: new Date("2026-05-10T00:00:00.000Z"),
        clips: [
          {
            id: "clip-swept",
            title: "Swept clip",
            storageKey: "clips/u1/job1/swept.mp4",
            duration: 12,
            createdAt: new Date("2026-05-10T00:01:00.000Z"),
            deletedAt: new Date("2026-07-20T00:00:00.000Z"),
          },
          {
            id: "clip-live",
            title: "Live clip",
            storageKey: "clips/u1/job1/live.mp4",
            duration: 12,
            createdAt: new Date("2026-05-10T00:02:00.000Z"),
            deletedAt: null,
          },
        ],
      },
    ]);

    const projects = await getUserProjects("u1");

    expect(projects[0].previewUrl).toBe("signed:clips/u1/job1/live.mp4");
  });
});

describe("deleteProject - R2 keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.jobDelete.mockResolvedValue({});
    mocks.settleFreeLedgerOnDelete.mockResolvedValue(undefined);
  });

  it("deletes the normalized artifact, which is the largest object in the job", async () => {
    mocks.jobFindFirst.mockResolvedValue({
      id: "job1",
      status: "DONE",
      clipsGenerated: 1,
      sourceKey: "uploads/u1/original.mp4",
      sourceArtifactKey: "work/u1/job1/source.mp4",
      normalizedArtifactKey: "work/u1/job1/normalized.mp4",
      thumbnailKey: "thumbs/job1.jpg",
      clips: [{ storageKey: "clips/u1/job1/a.mp4" }],
    });

    await deleteProject("job1", "u1");

    const deleted = mocks.deleteFile.mock.calls.map((c: any[]) => c[0]);
    expect(deleted).toContain("work/u1/job1/normalized.mp4");
    expect(deleted).toHaveLength(5);
  });

  it("does not delete the same key twice when normalization was a no-op", async () => {
    // normalizeSource returning action "none" stores the SAME key in both
    // columns. Deleting it twice logs a spurious failure for a key that is
    // already gone.
    mocks.jobFindFirst.mockResolvedValue({
      id: "job2",
      status: "DONE",
      clipsGenerated: 0,
      sourceKey: null,
      sourceArtifactKey: "work/u1/job2/source.mp4",
      normalizedArtifactKey: "work/u1/job2/source.mp4",
      thumbnailKey: null,
      clips: [],
    });

    await deleteProject("job2", "u1");

    const deleted = mocks.deleteFile.mock.calls.map((c: any[]) => c[0]);
    expect(deleted).toEqual(["work/u1/job2/source.mp4"]);
  });
});

/**
 * The ledger settlement deleteProject owes before it destroys the job row.
 *
 * The rules themselves are pinned in free-tier.service.test. What matters here
 * is that the settlement happens AT ALL, that it is handed the outcome, and
 * that it happens while the outcome is still knowable.
 */
describe("deleteProject - free ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.settleFreeLedgerOnDelete.mockImplementation(async () => {
      mocks.order.push("settle");
    });
    mocks.jobDelete.mockImplementation(async () => {
      mocks.order.push("delete");
      return {};
    });
  });

  function failedJob() {
    mocks.jobFindFirst.mockResolvedValue({
      id: "job1",
      status: "FAILED",
      clipsGenerated: 0,
      sourceKey: null,
      sourceArtifactKey: null,
      normalizedArtifactKey: null,
      thumbnailKey: null,
      clips: [],
    });
  }

  it("settles the ledger BEFORE the job row is deleted", async () => {
    failedJob();

    await deleteProject("job1", "u1");

    // Not a stylistic ordering. The refund sweep answers "does this charge
    // deserve its allowance back?" by joining free_usage to jobs, so once the
    // delete lands the question has no answer for ever - the charge is
    // stranded and the user's trial is gone over a run we broke.
    expect(mocks.order).toEqual(["settle", "delete"]);
  });

  it("hands the settlement the outcome, not just the id", async () => {
    failedJob();

    await deleteProject("job1", "u1");

    expect(mocks.settleFreeLedgerOnDelete).toHaveBeenCalledWith("u1", "job1", {
      status: "FAILED",
      clipsGenerated: 0,
    });
  });

  it("does not delete the job when the settlement fails", async () => {
    failedJob();
    mocks.settleFreeLedgerOnDelete.mockRejectedValue(new Error("db down"));

    await expect(deleteProject("job1", "u1")).rejects.toThrow("db down");

    // Failing the delete is the recoverable error: the row survives, the sweep
    // can still reach it, and the user can press Delete again. Deleting anyway
    // would strand exactly the charge this call exists to release.
    expect(mocks.jobDelete).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("settles nothing for a project that is not this user's", async () => {
    mocks.jobFindFirst.mockResolvedValue(null);

    expect(await deleteProject("job1", "u1")).toEqual({ status: "not_found" });
    expect(mocks.settleFreeLedgerOnDelete).not.toHaveBeenCalled();
  });
});

/**
 * What the confirm dialog reads. The number has to come from the ledger rather
 * than from the plan, because settleFreeLedgerOnDelete keys on the ledger too -
 * a dialog that warned on a plan check would warn a paying account, and would
 * miss an account that changed plan while a job was in flight.
 */
describe("project.service - minutes a delete would forfeit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPresignedDownloadUrl.mockImplementation(
      async (key: string) => `signed:${key}`
    );
  });

  it("reports the reserved seconds for a project whose delete would cost them", async () => {
    mocks.deleteForfeitsFreeSeconds.mockReturnValue(true);
    mocks.freeUsageFindMany.mockResolvedValue([{ jobId: "job1", seconds: 1800 }]);
    mocks.jobFindMany.mockResolvedValue([project("job1")]);

    const projects = await getUserProjects("u1");

    expect(projects[0].freeSecondsAtRisk).toBe(1800);
    expect(mocks.freeUsageFindMany).toHaveBeenCalledWith({
      // CHARGE only and scoped to the user: a REFUND row would be counted as
      // something still at stake, and jobId carries no foreign key.
      where: { userId: "u1", kind: "CHARGE", jobId: { in: ["job1"] } },
      select: { jobId: true, seconds: true },
    });
  });

  it("reports null for a paying account, which has no ledger row", async () => {
    mocks.deleteForfeitsFreeSeconds.mockReturnValue(true);
    mocks.freeUsageFindMany.mockResolvedValue([]);
    mocks.jobFindMany.mockResolvedValue([project("job1")]);

    const projects = await getUserProjects("u1");

    expect(projects[0].freeSecondsAtRisk).toBeNull();
  });

  it("does not ask the ledger at all when no project could lose anything", async () => {
    // A page of fifty finished projects is the common case; it must not cost a
    // query per row, or a query at all.
    mocks.deleteForfeitsFreeSeconds.mockReturnValue(false);
    mocks.jobFindMany.mockResolvedValue([project("job1"), project("job2")]);

    const projects = await getUserProjects("u1");

    expect(mocks.freeUsageFindMany).not.toHaveBeenCalled();
    expect(projects.every((p) => p.freeSecondsAtRisk === null)).toBe(true);
  });

  it("carries the same number on the detail page as on the list", async () => {
    mocks.deleteForfeitsFreeSeconds.mockReturnValue(true);
    mocks.freeUsageFindMany.mockResolvedValue([{ jobId: "job1", seconds: 900 }]);
    mocks.jobFindMany.mockResolvedValue([
      { ...project("job1"), noClipsReason: null, transcriptPartial: false },
    ]);

    const detail = await getProjectDetail("job1", "u1");

    expect(detail?.freeSecondsAtRisk).toBe(900);
  });
});

function project(
  id: string,
  storageKey?: string,
  thumbnailKey: string | null = null
) {
  return {
    id,
    userId: "u1",
    sourceUrl: null,
    sourceKey: `uploads/u1/${id}.mp4`,
    thumbnailKey,
    originalFilename: `${id}.mp4`,
    status: "DONE",
    error: null,
    sourceDurationSec: 60,
    clipsGenerated: storageKey ? 1 : 0,
    createdAt: new Date("2026-05-10T00:00:00.000Z"),
    clips: storageKey
      ? [
          {
            id: `clip-${id}`,
            title: "Clip",
            storageKey,
            duration: 12,
            startTime: 4,
            endTime: 16,
            subtitles: true,
            parentClipId: null,
            createdAt: new Date("2026-05-10T00:01:00.000Z"),
          },
        ]
      : [],
  };
}
