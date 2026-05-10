import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobFindMany: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    job: {
      findMany: mocks.jobFindMany,
    },
  },
}));

vi.mock("../../lib/r2", () => ({
  getPresignedDownloadUrl: mocks.getPresignedDownloadUrl,
}));

import { getRecentProjects, getUserProjects } from "../project.service";

describe("project.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPresignedDownloadUrl.mockImplementation(
      async (key: string) => `signed:${key}`
    );
  });

  it("returns three recent projects and reports when more exist", async () => {
    mocks.jobFindMany.mockResolvedValue([
      project("job1", "clips/u1/job1/clip.mp4"),
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
    expect(result.projects[0].previewUrl).toBe("signed:clips/u1/job1/clip.mp4");
  });

  it("returns all project summaries for the projects page", async () => {
    mocks.jobFindMany.mockResolvedValue([project("job1"), project("job2")]);

    const projects = await getUserProjects("u1");

    expect(projects).toHaveLength(2);
    expect(mocks.jobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 })
    );
  });
});

function project(id: string, storageKey?: string) {
  return {
    id,
    userId: "u1",
    sourceUrl: null,
    sourceKey: `uploads/u1/${id}.mp4`,
    originalFilename: `${id}.mp4`,
    status: "DONE",
    error: null,
    sourceDurationSec: 60,
    createdAt: new Date("2026-05-10T00:00:00.000Z"),
    clips: storageKey
      ? [
          {
            id: `clip-${id}`,
            title: "Clip",
            storageKey,
            duration: 12,
            createdAt: new Date("2026-05-10T00:01:00.000Z"),
          },
        ]
      : [],
  };
}
