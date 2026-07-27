import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clipFindFirstOrThrow: vi.fn(),
  clipFindFirst: vi.fn(),
  clipCreate: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  queueAdd: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    clip: {
      findFirstOrThrow: mocks.clipFindFirstOrThrow,
      findFirst: mocks.clipFindFirst,
      create: mocks.clipCreate,
    },
    user: {
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
    },
  },
}));

vi.mock("../../lib/queues", () => ({
  getStageQueue: () => ({
    add: mocks.queueAdd,
  }),
}));

vi.mock("../../lib/r2", () => ({
  getPresignedDownloadUrl: mocks.getPresignedDownloadUrl,
  deleteFile: mocks.deleteFile,
}));

import { ClipExpiredError, editClip, getDownloadUrl } from "../clip.service";

describe("clip.service - editClip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clipFindFirstOrThrow.mockResolvedValue({
      id: "clip_original",
      jobId: "job1",
      userId: "u1",
      title: "Original clip",
      storageKey: "clips/u1/job1/original.mp4",
      startTime: 40,
      endTime: 60,
      job: { id: "job1", sourceArtifactKey: "artifacts/job1/source.mp4" },
    });
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.clipCreate.mockResolvedValue({ id: "clip_new" });
  });

  it("stores absolute trim times but queues relative times for cutting the source clip file", async () => {
    await editClip({
      clipId: "clip_original",
      userId: "u1",
      start: 42.5,
      end: 55,
      subtitles: true,
    });

    expect(mocks.clipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          startTime: 42.5,
          endTime: 55,
          duration: 13,
          parentClipId: "clip_original",
        }),
      })
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({
        clipId: "clip_new",
        originalClipStorageKey: "clips/u1/job1/original.mp4",
        start: 2.5,
        end: 15,
        mode: "trim",
      })
    );
  });

  it("editClip enqueues a trim render with the edited subtitle track", async () => {
    const track = { cues: [{ id: "c1", start: 1, end: 2, text: "hi" }] };
    await editClip({
      clipId: "clip_original",
      userId: "u1",
      start: 42,
      end: 50,
      subtitles: true,
      subtitleTrack: track,
    });

    expect(mocks.clipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentClipId: "clip_original",
          subtitleTrack: track,
        }),
      })
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({
        mode: "trim",
        subtitles: true,
        subtitleTrack: track,
        start: 2,
        end: 10,
        sourceArtifactKey: "artifacts/job1/source.mp4",
        sourceStart: 42,
        sourceEnd: 50,
      })
    );
  });
});

describe("clip.service - getDownloadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPresignedDownloadUrl.mockResolvedValue("https://r2.example/signed");
  });

  it("signs a URL for a live clip", async () => {
    mocks.clipFindFirst.mockResolvedValue({
      id: "c1",
      storageKey: "clips/u1/job1/a.mp4",
      deletedAt: null,
    });

    await expect(getDownloadUrl("c1", "u1")).resolves.toBe(
      "https://r2.example/signed"
    );
  });

  it("refuses a swept clip instead of signing a URL to a deleted object", async () => {
    mocks.clipFindFirst.mockResolvedValue({
      id: "c2",
      storageKey: "clips/u1/job1/b.mp4",
      deletedAt: new Date("2026-07-20T00:00:00Z"),
    });

    await expect(getDownloadUrl("c2", "u1")).rejects.toBeInstanceOf(
      ClipExpiredError
    );
    expect(mocks.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("still 404s a clip that belongs to somebody else", async () => {
    mocks.clipFindFirst.mockResolvedValue(null);

    await expect(getDownloadUrl("c3", "u1")).rejects.not.toBeInstanceOf(
      ClipExpiredError
    );
  });
});
