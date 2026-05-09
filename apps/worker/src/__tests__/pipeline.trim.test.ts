import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  clipUpdate: vi.fn(),
  downloadVideo: vi.fn(),
  trimClipFile: vi.fn(),
}));

vi.mock("@clipfast/shared", () => ({
  uploadFile: mocks.uploadFile,
  prisma: {
    clip: {
      update: mocks.clipUpdate,
    },
  },
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/cut", () => ({
  trimClipFile: mocks.trimClipFile,
}));

vi.mock("../processors/transcribe", () => ({
  transcribeVideo: vi.fn(),
}));

vi.mock("../processors/analyze", () => ({
  analyzeHighlights: vi.fn(),
}));

vi.mock("../processors/subtitles", () => ({
  burnSubtitles: vi.fn(),
}));

import { processTrimClipJob } from "../pipeline";

describe("processTrimClipJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadVideo.mockResolvedValue("/tmp/original.mp4");
    mocks.trimClipFile.mockResolvedValue("/tmp/trimmed.mp4");
  });

  it("downloads the source clip, trims it, uploads the result, and updates the placeholder clip", async () => {
    await processTrimClipJob({
      clipId: "clip_new",
      originalClipStorageKey: "clips/u1/job1/original.mp4",
      jobId: "job1",
      userId: "u1",
      start: 2.5,
      end: 9.25,
    });

    expect(mocks.downloadVideo).toHaveBeenCalledWith(
      undefined,
      "clips/u1/job1/original.mp4"
    );
    expect(mocks.trimClipFile).toHaveBeenCalledWith(
      "/tmp/original.mp4",
      2.5,
      9.25
    );
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringMatching(/^clips\/u1\/job1\/.+\.mp4$/),
      "/tmp/trimmed.mp4",
      "video/mp4"
    );
    expect(mocks.clipUpdate).toHaveBeenCalledWith({
      where: { id: "clip_new" },
      data: {
        storageKey: expect.stringMatching(/^clips\/u1\/job1\/.+\.mp4$/),
        duration: 7,
      },
    });
  });
});
