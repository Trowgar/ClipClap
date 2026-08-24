import { beforeEach, describe, expect, it, vi } from "vitest";

// Render-retry idempotency (spec 2026-08-24-render-retry-and-stream-gate §1,
// incident job cmt6ag9q8): RENDER attempt 1 died silently mid-loop after
// creating 4 of 7 clip rows. BullMQ stall recovery redelivered the job and
// attempt 2 re-ran the FULL-JOB render path from scratch, re-creating ALL 7
// highlights on top of the 4 orphaned rows from attempt 1 - delivery (which
// only filters `deletedAt: null`, never dedups by highlight identity)
// shipped all 11 rows, 4 highlights twice. The fix soft-deletes any live
// leftovers of a prior attempt before the per-highlight loop creates a
// single new row per highlight.
//
// Mocked-prisma trap (MEMORY: mocked prisma hides query bugs): these tests
// assert the EXACT where/data shape of the updateMany call, not merely that
// it was called - a wrong where (e.g. missing `deletedAt: null`) would
// re-touch already-deleted rows and pass a looser assertion while being the
// wrong query.

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  jobFindUniqueOrThrow: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  jobUpdate: vi.fn(),
  clipCreate: vi.fn(),
  clipUpdateMany: vi.fn(),
  uploadFile: vi.fn(),
  downloadVideo: vi.fn(),
  cutClips: vi.fn(),
  probeTimeline: vi.fn(),
  generateThumbnail: vi.fn(),
  queueAdd: vi.fn(),
  computeClipExpiresAt: vi.fn(),
  createAssFilter: vi.fn(),
  jobStepFindUnique: vi.fn(),
}));

vi.mock("@clipclap/shared", () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFindUniqueOrThrow,
      update: mocks.jobUpdate,
    },
    user: {
      findUniqueOrThrow: mocks.userFindUniqueOrThrow,
    },
    clip: {
      create: mocks.clipCreate,
      updateMany: mocks.clipUpdateMany,
    },
    // renderClips reads the ANALYZE step's telemetry for the music-shorts
    // stream override (stages/render.ts's loadReframeConfigForJob) -
    // unmocked resolves undefined, same as a job with no ANALYZE row.
    jobStep: { findUnique: mocks.jobStepFindUnique },
  },
  uploadFile: mocks.uploadFile,
  getStageQueue: vi.fn(() => ({ add: mocks.queueAdd })),
  computeClipExpiresAt: mocks.computeClipExpiresAt,
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/cut", () => ({
  cutClips: mocks.cutClips,
}));

vi.mock("../processors/normalize", () => ({
  probeTimeline: mocks.probeTimeline,
}));

vi.mock("../processors/thumbnail", () => ({
  generateThumbnail: mocks.generateThumbnail,
}));

vi.mock("../processors/subtitles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../processors/subtitles")>();
  return { ...actual, createAssFilter: mocks.createAssFilter };
});

import { runRenderStage } from "../stages/render";

const highlights = [
  { start: 0, end: 10, title: "clip1", reason: "test" },
  { start: 20, end: 30, title: "clip2", reason: "test" },
];

function baseJobRow() {
  return {
    id: "job1",
    normalizedArtifactKey: null,
    sourceArtifactKey: "work/u1/job1/source.mp4",
    transcriptJson: { text: "hello", segments: [] },
    highlights,
    subtitles: false,
  };
}

describe("renderClips soft-deletes leftovers of a prior attempt before creating new rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.jobFindUniqueOrThrow.mockResolvedValue(baseJobRow());
    mocks.downloadVideo.mockResolvedValue("/tmp/fake-source.mp4");
    mocks.cutClips.mockResolvedValue([{ clipPath: "/tmp/fake-clip.mp4" }]);
    mocks.probeTimeline.mockResolvedValue({
      formatStart: 0,
      videoStart: null,
      audioStart: null,
      hasAudio: true,
      hasVideo: true,
    });
    mocks.generateThumbnail.mockResolvedValue("/tmp/fake-thumb.jpg");
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.clipCreate.mockResolvedValue({ id: "clipX" });
    mocks.clipUpdateMany.mockResolvedValue({ count: 0 });
    mocks.jobUpdate.mockResolvedValue(undefined);
    mocks.computeClipExpiresAt.mockReturnValue(undefined);
  });

  it("calls clip.updateMany exactly once, with the exact where/data shape, before any clip.create", async () => {
    const callOrder: string[] = [];
    mocks.clipUpdateMany.mockImplementation(async () => {
      callOrder.push("updateMany");
      return { count: 0 };
    });
    mocks.clipCreate.mockImplementation(async () => {
      callOrder.push("create");
      return { id: "clipX" };
    });

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });

    expect(mocks.clipUpdateMany).toHaveBeenCalledTimes(1);
    // Exact shape, not "was called with jobId somewhere in it" - the
    // deletedAt: null scope is what keeps a second retry from re-touching
    // rows a PRIOR cleanup already soft-deleted (harmless but wrong query),
    // and telegramFileId: null is what keeps this cleanup from soft-deleting
    // a row that finished and got delivered before this retry's cleanup ran
    // (the narrow stall-reclaim race) - deliverClips already skips any row
    // that carries a telegramFileId, so excluding those rows here can never
    // let a duplicate through either way.
    expect(mocks.clipUpdateMany).toHaveBeenCalledWith({
      where: { jobId: "job1", deletedAt: null, telegramFileId: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(mocks.clipCreate).toHaveBeenCalledTimes(2); // one per highlight
    // Order, not just presence: the cleanup must land BEFORE the loop, not
    // interleaved inside it.
    expect(callOrder).toEqual(["updateMany", "create", "create"]);
  });

  it("scopes the where-clause to exactly {jobId, deletedAt, telegramFileId} - no extra/missing keys", async () => {
    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" });
    const call = mocks.clipUpdateMany.mock.calls[0][0];
    expect(Object.keys(call.where).sort()).toEqual([
      "deletedAt",
      "jobId",
      "telegramFileId",
    ]);
    expect(Object.keys(call.data)).toEqual(["deletedAt"]);
  });
});

describe("renderClips retry: running the render path twice leaves exactly N live rows, not 2N", () => {
  // In-memory fake clip table so the test can express the incident's actual
  // shape - a prior attempt's rows becoming invisible, not just "a mock fn
  // got called" - matching spec acceptance criterion (c).
  let store: Array<{ id: string; jobId: string; deletedAt: Date | null }>;
  let nextId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    store = [];
    nextId = 1;

    mocks.userFindUniqueOrThrow.mockResolvedValue({
      plan: "STARTER",
      billingCycle: "MONTHLY",
    });
    mocks.jobFindUniqueOrThrow.mockResolvedValue(baseJobRow());
    mocks.downloadVideo.mockResolvedValue("/tmp/fake-source.mp4");
    mocks.cutClips.mockResolvedValue([{ clipPath: "/tmp/fake-clip.mp4" }]);
    mocks.probeTimeline.mockResolvedValue({
      formatStart: 0,
      videoStart: null,
      audioStart: null,
      hasAudio: true,
      hasVideo: true,
    });
    mocks.generateThumbnail.mockResolvedValue("/tmp/fake-thumb.jpg");
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.jobUpdate.mockResolvedValue(undefined);
    mocks.computeClipExpiresAt.mockReturnValue(undefined);

    mocks.clipUpdateMany.mockImplementation(
      async ({ where, data }: { where: { jobId: string; deletedAt: null }; data: { deletedAt: Date } }) => {
        let count = 0;
        for (const row of store) {
          if (row.jobId === where.jobId && row.deletedAt === where.deletedAt) {
            row.deletedAt = data.deletedAt;
            count++;
          }
        }
        return { count };
      }
    );
    mocks.clipCreate.mockImplementation(async ({ data }: { data: { jobId: string } }) => {
      const row = { id: `clip${nextId++}`, jobId: data.jobId, deletedAt: null };
      store.push(row);
      return row;
    });
  });

  it("attempt 1 creates N rows; attempt 2 (a retry) soft-deletes attempt 1's rows and creates exactly N new ones", async () => {
    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" }); // attempt 1

    const afterAttempt1 = store.filter((r) => r.deletedAt === null);
    expect(afterAttempt1).toHaveLength(highlights.length);
    const attempt1Ids = afterAttempt1.map((r) => r.id);

    await runRenderStage({ mode: "clips", jobId: "job1", userId: "u1" }); // attempt 2, the retry

    const live = store.filter((r) => r.deletedAt === null);
    // Exactly N live rows after the retry - not 2N (the incident's bug) and
    // not 0 (an over-eager cleanup that ran after the loop too).
    expect(live).toHaveLength(highlights.length);
    expect(store).toHaveLength(highlights.length * 2); // total rows across both attempts
    for (const id of attempt1Ids) {
      const row = store.find((r) => r.id === id)!;
      expect(row.deletedAt).not.toBeNull(); // attempt 1's leftovers got soft-deleted
    }
  });
});
