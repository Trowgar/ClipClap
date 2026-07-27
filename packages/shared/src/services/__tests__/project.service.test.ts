import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobFindMany: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  jobFindFirst: vi.fn(),
  jobDelete: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    job: {
      findMany: mocks.jobFindMany,
      findFirst: mocks.jobFindFirst,
      delete: mocks.jobDelete,
    },
  },
}));

vi.mock("../../lib/r2", () => ({
  getPresignedDownloadUrl: mocks.getPresignedDownloadUrl,
  deleteFile: mocks.deleteFile,
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
  });

  it("deletes the normalized artifact, which is the largest object in the job", async () => {
    mocks.jobFindFirst.mockResolvedValue({
      id: "job1",
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
