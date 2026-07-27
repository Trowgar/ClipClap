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
  burnSubtitles: vi.fn(),
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

vi.mock("../processors/subtitles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../processors/subtitles")>();
  return {
    ...actual,
    burnSubtitles: mocks.burnSubtitles,
  };
});

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
  originalHasBurnedSubtitles: false,
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

describe("renderTrim fallback avoids double-burning subtitles", () => {
  const fallbackPayload = {
    mode: "trim" as const,
    jobId: "job1",
    userId: "u1",
    clipId: "clip1",
    originalClipStorageKey: "clips/u1/job1/original.mp4",
    start: 0,
    end: 5,
    subtitles: true,
    subtitleTrack: {
      cues: [{ id: "c1", start: 0, end: 4, text: "hello" }],
    },
    // No sourceArtifactKey: this job has no clean-source route, so the
    // fallback branch runs directly - same effect as the sweep/expiry cases.
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.clipUpdate.mockResolvedValue(undefined);
    mocks.downloadVideo.mockResolvedValue("/tmp/original-clip.mp4");
    mocks.trimClipFile.mockResolvedValue("/tmp/trimmed-clip.mp4");
    mocks.burnSubtitles.mockResolvedValue("/tmp/subbed-clip.mp4");
  });

  it("does not burn subtitles again when the original clip is already subtitled", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runRenderStage({
      ...fallbackPayload,
      originalHasBurnedSubtitles: true,
    });

    expect(mocks.burnSubtitles).not.toHaveBeenCalled();
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringContaining("clips/u1/job1/"),
      "/tmp/trimmed-clip.mp4",
      "video/mp4"
    );
    expect(
      warnSpy.mock.calls.some(
        ([msg]) => typeof msg === "string" && msg.includes("clip1")
      )
    ).toBe(true);

    warnSpy.mockRestore();
  });

  it("still burns subtitles when the original clip has none baked in", async () => {
    await runRenderStage({
      ...fallbackPayload,
      originalHasBurnedSubtitles: false,
    });

    expect(mocks.burnSubtitles).toHaveBeenCalledWith(
      "/tmp/trimmed-clip.mp4",
      fallbackPayload.subtitleTrack.cues
    );
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringContaining("clips/u1/job1/"),
      "/tmp/subbed-clip.mp4",
      "video/mp4"
    );
  });
});

describe("renderTrim clean-source branch still burns subtitles as before", () => {
  const cleanPayload = {
    mode: "trim" as const,
    jobId: "job1",
    userId: "u1",
    clipId: "clip1",
    originalClipStorageKey: "clips/u1/job1/original.mp4",
    start: 0,
    end: 5,
    subtitles: true,
    subtitleTrack: {
      cues: [{ id: "c1", start: 0, end: 4, text: "hello" }],
    },
    sourceArtifactKey: "work/u1/job1/source.mp4",
    sourceStart: 10,
    sourceEnd: 15,
    // Irrelevant on this branch: the clean source is untouched raw footage,
    // never subtitled, and the guard added for the fallback must not apply
    // here regardless of what this says.
    originalHasBurnedSubtitles: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.clipUpdate.mockResolvedValue(undefined);
    mocks.downloadVideo.mockResolvedValue("/tmp/source.mp4");
    mocks.cutClips.mockResolvedValue([{ clipPath: "/tmp/cut-clip.mp4" }]);
  });

  it("burns the edited cues via the single-pass filter, not via burnSubtitles", async () => {
    await runRenderStage(cleanPayload);

    expect(mocks.cutClips).toHaveBeenCalledWith(
      "/tmp/source.mp4",
      [expect.objectContaining({ start: 10, end: 15 })],
      expect.stringContaining("ass=filename="),
      null
    );
    expect(mocks.burnSubtitles).not.toHaveBeenCalled();
    expect(mocks.trimClipFile).not.toHaveBeenCalled();
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringContaining("clips/u1/job1/"),
      "/tmp/cut-clip.mp4",
      "video/mp4"
    );
  });
});
