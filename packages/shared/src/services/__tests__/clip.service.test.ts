import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clipFindFirstOrThrow: vi.fn(),
  clipFindFirst: vi.fn(),
  clipFindMany: vi.fn(),
  clipCreate: vi.fn(),
  clipDelete: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  queueAdd: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  deleteFile: vi.fn(),
  getObjectSize: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    clip: {
      findFirstOrThrow: mocks.clipFindFirstOrThrow,
      findFirst: mocks.clipFindFirst,
      findMany: mocks.clipFindMany,
      create: mocks.clipCreate,
      delete: mocks.clipDelete,
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
  getObjectSize: mocks.getObjectSize,
}));

import {
  ClipExpiredError,
  editClip,
  getClip,
  getDownloadUrl,
  getUserClips,
} from "../clip.service";

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
      subtitleTrack: { cues: [{ id: "old", start: 1, end: 2, text: "kept" }] },
      job: { id: "job1", sourceDurationSec: 200, sourceArtifactKey: "artifacts/job1/source.mp4" },
    });
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.clipCreate.mockResolvedValue({ id: "clip_new" });
    mocks.getObjectSize.mockResolvedValue(1000);
    mocks.queueAdd.mockResolvedValue(undefined);
    mocks.clipDelete.mockResolvedValue(undefined);
  });

  it("removes only the new placeholder when enqueueing fails", async () => {
    mocks.queueAdd.mockRejectedValue(new Error("queue unavailable"));
    await expect(editClip({ clipId: "clip_original", userId: "u1", start: 40, end: 60, subtitles: true, extendEndSeconds: 2 })).rejects.toThrow("queue");
    expect(mocks.clipDelete).toHaveBeenCalledWith({ where: { id: "clip_new" } });
  });

  it("creates a separate +5s source repair, preserving stored captions when omitted", async () => {
    await editClip({ clipId: "clip_original", userId: "u1", start: 40, end: 60, subtitles: true, extendEndSeconds: 5 });
    expect(mocks.clipFindFirstOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "clip_original", userId: "u1" } }));
    expect(mocks.getObjectSize).toHaveBeenCalledWith("artifacts/job1/source.mp4");
    expect(mocks.clipCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentClipId: "clip_original", startTime: 40, endTime: 65, duration: 25 }) }));
    expect(mocks.queueAdd).toHaveBeenCalledWith("render", expect.objectContaining({ sourceStart: 40, sourceEnd: 65, end: 25, extendEndSeconds: 5, subtitleTrack: { cues: [{ id: "old", start: 1, end: 2, text: "kept" }] } }));
  });

  it.each([
    { start: NaN }, { end: Infinity }, { start: -1 }, { start: 39 },
    { end: 61 }, { end: 39 }, { extendEndSeconds: 3 }, { framing: "crop" },
    { extendEndSeconds: 5, end: 59 },
  ])("rejects invalid edits before creating output: %j", async change => {
    await expect(editClip({ clipId: "clip_original", userId: "u1", start: 40, end: 60, subtitles: true, ...change } as never)).rejects.toThrow();
    expect(mocks.clipCreate).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it.each(["missing", "past-source", "too-long", "expired"])("refuses %s source repair without a placeholder", async kind => {
    if (kind === "missing") mocks.getObjectSize.mockRejectedValue(new Error("NoSuchKey"));
    const original = await mocks.clipFindFirstOrThrow();
    if (kind === "past-source") original.job.sourceDurationSec = 63;
    if (kind === "too-long") { original.startTime = 0; original.endTime = 149; }
    if (kind === "expired") original.deletedAt = new Date();
    await expect(editClip({ clipId: original.id, userId: "u1", start: original.startTime, end: original.endTime, subtitles: true, extendEndSeconds: 5 })).rejects.toThrow();
    expect(mocks.clipCreate).not.toHaveBeenCalled();
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

  it("carries the original clip's burned-subtitle state into the render payload, whatever this edit requests", async () => {
    mocks.clipFindFirstOrThrow.mockResolvedValue({
      id: "clip_original",
      jobId: "job1",
      userId: "u1",
      title: "Original clip",
      storageKey: "clips/u1/job1/original.mp4",
      startTime: 40,
      endTime: 60,
      subtitles: true,
      job: { id: "job1", sourceArtifactKey: "artifacts/job1/source.mp4" },
    });

    await editClip({
      clipId: "clip_original",
      userId: "u1",
      start: 42,
      end: 50,
      subtitles: false,
    });

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({
        originalHasBurnedSubtitles: true,
      })
    );
  });

  it("carries false when the original clip was never subtitled", async () => {
    mocks.clipFindFirstOrThrow.mockResolvedValue({
      id: "clip_original",
      jobId: "job1",
      userId: "u1",
      title: "Original clip",
      storageKey: "clips/u1/job1/original.mp4",
      startTime: 40,
      endTime: 60,
      subtitles: false,
      job: { id: "job1", sourceArtifactKey: "artifacts/job1/source.mp4" },
    });

    await editClip({
      clipId: "clip_original",
      userId: "u1",
      start: 42,
      end: 50,
      subtitles: true,
    });

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({
        originalHasBurnedSubtitles: false,
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

describe("clip.service - getClip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a live clip expired: false without dropping any row field", async () => {
    mocks.clipFindFirst.mockResolvedValue({
      id: "c1",
      storageKey: "clips/u1/job1/a.mp4",
      deletedAt: null,
    });

    const clip = await getClip("c1", "u1");

    expect(clip).toEqual(
      expect.objectContaining({
        id: "c1",
        storageKey: "clips/u1/job1/a.mp4",
        expired: false,
      })
    );
  });

  it("marks a swept clip expired: true - the row stays, it is only labeled", async () => {
    mocks.clipFindFirst.mockResolvedValue({
      id: "c2",
      storageKey: "clips/u1/job1/b.mp4",
      deletedAt: new Date("2026-07-20T00:00:00Z"),
    });

    const clip = await getClip("c2", "u1");

    expect(clip).toEqual(
      expect.objectContaining({
        id: "c2",
        storageKey: "clips/u1/job1/b.mp4",
        expired: true,
      })
    );
  });

  it("returns null, not an expired stand-in, for a clip that isn't the caller's", async () => {
    mocks.clipFindFirst.mockResolvedValue(null);

    await expect(getClip("c3", "u1")).resolves.toBeNull();
  });
});

describe("clip.service - getUserClips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives expired per clip from its own deletedAt", async () => {
    mocks.clipFindMany.mockResolvedValue([
      { id: "c1", storageKey: "clips/u1/job1/a.mp4", deletedAt: null },
      {
        id: "c2",
        storageKey: "clips/u1/job1/b.mp4",
        deletedAt: new Date("2026-07-20T00:00:00Z"),
      },
    ]);

    const clips = await getUserClips("u1");

    expect(clips[0]).toEqual(expect.objectContaining({ id: "c1", expired: false }));
    expect(clips[1]).toEqual(expect.objectContaining({ id: "c2", expired: true }));
  });
});
