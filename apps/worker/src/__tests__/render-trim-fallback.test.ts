import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  clipUpdate: vi.fn(),
  clipFindUnique: vi.fn(),
  uploadFile: vi.fn(),
  downloadVideo: vi.fn(),
  cutClips: vi.fn(),
  trimClipFile: vi.fn(),
}));

vi.mock("@clipclap/shared", () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  prisma: {
    clip: {
      update: mocks.clipUpdate,
      findUnique: mocks.clipFindUnique,
    },
  },
  uploadFile: mocks.uploadFile,
  getStageQueue: vi.fn(() => ({ add: vi.fn() })),
  computeClipExpiresAt: vi.fn(),
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/cut", () => ({
  cutClips: mocks.cutClips,
  trimClipFile: mocks.trimClipFile,
}));

import { runRenderStage } from "../stages/render";

const trimPayload = {
  mode: "trim" as const,
  jobId: "job1",
  userId: "u1",
  clipId: "clip1",
  originalClipStorageKey: "clips/u1/job1/original.mp4",
  start: 0,
  end: 5,
  subtitles: false,
  sourceArtifactKey: "work/u1/job1/source.mp4",
  sourceStart: 10,
  sourceEnd: 15,
};

describe("renderTrim degrades when the clean source artifact is gone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.clipUpdate.mockResolvedValue(undefined);
  });

  it("falls back to re-trimming the clip file when the source download rejects, and does not throw", async () => {
    mocks.downloadVideo.mockImplementation(async (_url: unknown, key: string) => {
      if (key === trimPayload.sourceArtifactKey) {
        throw new Error("NoSuchKey: the specified key does not exist");
      }
      expect(key).toBe(trimPayload.originalClipStorageKey);
      return "/tmp/original-clip.mp4";
    });
    mocks.trimClipFile.mockResolvedValue("/tmp/trimmed-clip.mp4");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runRenderStage(trimPayload)).resolves.toBeUndefined();

    // Never reached the clean-source cut path.
    expect(mocks.cutClips).not.toHaveBeenCalled();
    // Reached the clip-file fallback with the right (relative) time range.
    expect(mocks.trimClipFile).toHaveBeenCalledWith(
      "/tmp/original-clip.mp4",
      trimPayload.start,
      trimPayload.end
    );
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringContaining("clips/u1/job1/"),
      "/tmp/trimmed-clip.mp4",
      "video/mp4"
    );
    expect(mocks.clipUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "clip1" } })
    );
    // The stage must not be reported as failed - a degraded trim still succeeds.
    expect(mocks.failJobStep).not.toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some(
        ([msg]) =>
          typeof msg === "string" &&
          msg.includes("job1") &&
          msg.includes(trimPayload.sourceArtifactKey)
      )
    ).toBe(true);

    warnSpy.mockRestore();
  });

  it("still throws when the clean source downloads fine but the encode fails", async () => {
    mocks.downloadVideo.mockImplementation(async (_url: unknown, key: string) => {
      if (key === trimPayload.sourceArtifactKey) return "/tmp/source.mp4";
      return "/tmp/original-clip.mp4";
    });
    mocks.cutClips.mockRejectedValue(new Error("ffmpeg exited with code 1"));

    await expect(runRenderStage(trimPayload)).rejects.toThrow(
      "ffmpeg exited with code 1"
    );

    expect(mocks.trimClipFile).not.toHaveBeenCalled();
  });
});
