import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clipFindFirstOrThrow: vi.fn(),
  clipCreate: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    clip: {
      findFirstOrThrow: mocks.clipFindFirstOrThrow,
      create: mocks.clipCreate,
    },
    user: {
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
    },
  },
}));

vi.mock("../../lib/queue", () => ({
  getVideoQueue: () => ({
    add: mocks.queueAdd,
  }),
}));

import { trimClip } from "../clip.service";

describe("clip.service — trimClip", () => {
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
      job: { id: "job1" },
    });
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.clipCreate.mockResolvedValue({ id: "clip_new" });
  });

  it("stores absolute trim times but queues relative times for cutting the source clip file", async () => {
    await trimClip({
      clipId: "clip_original",
      userId: "u1",
      start: 42.5,
      end: 55,
      subtitles: true,
      subtitlePreset: "tiktok",
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
      "trim-clip",
      expect.objectContaining({
        clipId: "clip_new",
        originalClipStorageKey: "clips/u1/job1/original.mp4",
        start: 2.5,
        end: 15,
      })
    );
  });
});
