import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedError } from "bullmq";

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  downloadVideo: vi.fn(),
  normalizeSource: vi.fn(),
  uploadFile: vi.fn(),
  getStageQueue: vi.fn(),
  queueAdd: vi.fn(),
  jobFind: vi.fn(),
  jobUpdate: vi.fn(),
}));

vi.mock("@clipclap/shared", async () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  getStageQueue: mocks.getStageQueue,
  uploadFile: mocks.uploadFile,
  // Real implementation on purpose: this suite exists to test flap DETECTION,
  // and mocking the classifier away would test nothing but our own plumbing.
  isBotCheckFailure: (
    await vi.importActual<typeof import("@clipclap/shared/lib/ytdlp-proxy")>(
      "@clipclap/shared/lib/ytdlp-proxy"
    )
  ).isBotCheckFailure,
  // Real implementation: the fall-through (non-parked) failure path tags the
  // stored error via safeTagJobError -> tagJobError, and this suite asserts
  // on the "[SOURCE_UNAVAILABLE]" prefix that only the real one produces.
  tagJobError: (
    await vi.importActual<typeof import("@clipclap/shared/lib/job-error")>(
      "@clipclap/shared/lib/job-error"
    )
  ).tagJobError,
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFind,
      update: mocks.jobUpdate,
    },
  },
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/normalize", () => ({
  normalizeSource: mocks.normalizeSource,
}));

import { SourceUnavailableError } from "../processors/errors";
import { runDownloadStage } from "../stages/download";

/** A minimal stand-in for the BullMQ job handle the worker processor passes
 *  into runDownloadStage - see FlapWaitJob in stages/download.ts. */
function fakeBullJob(data: Record<string, unknown>) {
  return {
    data,
    updateData: vi.fn(),
    moveToDelayed: vi.fn(),
  };
}

const PAYLOAD = { jobId: "job1", userId: "u1" };
const URL_JOB_ROW = {
  id: "job1",
  userId: "u1",
  sourceUrl: "https://youtube.com/watch?v=x",
  sourceKey: null,
};

/** yt-dlp's real error shape: SourceUnavailableError's message is built as
 *  `yt-dlp could not fetch ${url}: ${detail}`, and `detail` is Node's
 *  execFile rejection message, which itself carries the child's stderr tail
 *  after a "Command failed: ..." prefix (verified by hand against
 *  promisify(execFile) - see the task report). This fixture reproduces that
 *  shape rather than a bare "HTTP Error 403" string. */
function ytDlp403Error(): SourceUnavailableError {
  return new SourceUnavailableError(
    "yt-dlp could not fetch https://youtube.com/watch?v=x: Command failed: yt-dlp ...\n" +
      "ERROR: unable to download video data: HTTP Error 403: Forbidden"
  );
}

function ytDlpBotCheckError(): SourceUnavailableError {
  return new SourceUnavailableError(
    "yt-dlp could not fetch https://youtube.com/watch?v=x: Command failed: yt-dlp ...\n" +
      "ERROR: [youtube] x: Sign in to confirm you're not a bot"
  );
}

describe("download stage: flap-wait parking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobFind.mockResolvedValue(URL_JOB_ROW);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parks a first 403 flap: updateData(flapWaits: 1), moveToDelayed(~+10min), throws DelayedError, never fails the job", async () => {
    mocks.downloadVideo.mockRejectedValue(ytDlp403Error());
    const bullJob = fakeBullJob(PAYLOAD);
    const before = Date.now();

    await expect(
      runDownloadStage(PAYLOAD, bullJob, "t")
    ).rejects.toBeInstanceOf(DelayedError);

    const after = Date.now();

    expect(bullJob.updateData).toHaveBeenCalledTimes(1);
    expect(bullJob.updateData).toHaveBeenCalledWith({
      jobId: "job1",
      userId: "u1",
      flapWaits: 1,
    });

    expect(bullJob.moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = bullJob.moveToDelayed.mock.calls[0];
    expect(token).toBe("t");
    expect(timestamp).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(timestamp).toBeLessThanOrEqual(after + 10 * 60 * 1000);

    expect(mocks.failJobStep).not.toHaveBeenCalled();
    expect(mocks.jobUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("parks a second flap at the 30-minute wait and bumps the counter to 2", async () => {
    mocks.downloadVideo.mockRejectedValue(ytDlp403Error());
    const bullJob = fakeBullJob({ ...PAYLOAD, flapWaits: 1 });
    const before = Date.now();

    await expect(
      runDownloadStage(PAYLOAD, bullJob, "t")
    ).rejects.toBeInstanceOf(DelayedError);

    const after = Date.now();

    expect(bullJob.updateData).toHaveBeenCalledWith({
      jobId: "job1",
      userId: "u1",
      flapWaits: 2,
    });
    const [timestamp] = bullJob.moveToDelayed.mock.calls[0];
    expect(timestamp).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
    expect(timestamp).toBeLessThanOrEqual(after + 30 * 60 * 1000);
  });

  it("parks a third flap at the 90-minute wait and bumps the counter to 3", async () => {
    // Pins the third rung's literal and the `flapWaits < LENGTH` boundary:
    // index 2 is the last delay the ladder still grants before the fourth
    // failure (flapWaits: 3) falls through as exhausted.
    mocks.downloadVideo.mockRejectedValue(ytDlp403Error());
    const bullJob = fakeBullJob({ ...PAYLOAD, flapWaits: 2 });
    const before = Date.now();

    await expect(
      runDownloadStage(PAYLOAD, bullJob, "t")
    ).rejects.toBeInstanceOf(DelayedError);

    const after = Date.now();

    expect(bullJob.updateData).toHaveBeenCalledWith({
      jobId: "job1",
      userId: "u1",
      flapWaits: 3,
    });
    const [timestamp] = bullJob.moveToDelayed.mock.calls[0];
    expect(timestamp).toBeGreaterThanOrEqual(before + 90 * 60 * 1000);
    expect(timestamp).toBeLessThanOrEqual(after + 90 * 60 * 1000);
  });

  it("degrades to the normal failure path when the park itself fails (moveToDelayed rejects)", async () => {
    // A lock-token mismatch or a Redis hiccup can make the BullMQ pair itself
    // throw. On the last BullMQ attempt this catch block is the only place
    // anything still runs, so a park failure that escapes unguarded would
    // skip failJobStep/markJobFailed entirely and strand the Prisma row in
    // DOWNLOADING forever - never billed, never cleared, never delivered.
    // The stage must fall through to the ordinary failure path instead, with
    // the ORIGINAL flap error (not the park error), and no DelayedError may
    // escape.
    const error = ytDlp403Error();
    mocks.downloadVideo.mockRejectedValue(error);
    const bullJob = fakeBullJob(PAYLOAD);
    bullJob.moveToDelayed.mockRejectedValue(new Error("lock mismatch"));

    await expect(runDownloadStage(PAYLOAD, bullJob, "t")).rejects.toBe(error);

    expect(mocks.failJobStep).toHaveBeenCalledWith("job1", "DOWNLOAD", error);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: expect.stringContaining("SOURCE_UNAVAILABLE") },
    });
  });

  it("falls through to the real FAILED path once the ladder is exhausted", async () => {
    const error = ytDlp403Error();
    mocks.downloadVideo.mockRejectedValue(error);
    const bullJob = fakeBullJob({ ...PAYLOAD, flapWaits: 3 });

    await expect(
      runDownloadStage(PAYLOAD, bullJob, "t")
    ).rejects.toBe(error);

    expect(bullJob.moveToDelayed).not.toHaveBeenCalled();
    expect(bullJob.updateData).not.toHaveBeenCalled();
    expect(mocks.failJobStep).toHaveBeenCalledWith("job1", "DOWNLOAD", error);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: expect.stringContaining("SOURCE_UNAVAILABLE") },
    });
  });

  it("parks a bot-check failure the same as a bare 403", async () => {
    mocks.downloadVideo.mockRejectedValue(ytDlpBotCheckError());
    const bullJob = fakeBullJob(PAYLOAD);

    await expect(
      runDownloadStage(PAYLOAD, bullJob, "t")
    ).rejects.toBeInstanceOf(DelayedError);

    expect(bullJob.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(bullJob.updateData).toHaveBeenCalledWith({
      jobId: "job1",
      userId: "u1",
      flapWaits: 1,
    });
  });

  it("does not park a non-flap failure - normal failure path runs instead", async () => {
    const error = new SourceUnavailableError(
      "yt-dlp could not fetch https://youtube.com/watch?v=x: Video unavailable"
    );
    mocks.downloadVideo.mockRejectedValue(error);
    const bullJob = fakeBullJob(PAYLOAD);

    await expect(runDownloadStage(PAYLOAD, bullJob, "t")).rejects.toBe(error);

    expect(bullJob.moveToDelayed).not.toHaveBeenCalled();
    expect(bullJob.updateData).not.toHaveBeenCalled();
    expect(mocks.failJobStep).toHaveBeenCalledWith("job1", "DOWNLOAD", error);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: expect.stringContaining("SOURCE_UNAVAILABLE") },
    });
  });

  it("DOWNLOAD_FLAP_WAIT=off disables parking even for a 403", async () => {
    vi.stubEnv("DOWNLOAD_FLAP_WAIT", "off");
    const error = ytDlp403Error();
    mocks.downloadVideo.mockRejectedValue(error);
    const bullJob = fakeBullJob(PAYLOAD);

    await expect(runDownloadStage(PAYLOAD, bullJob, "t")).rejects.toBe(error);

    expect(bullJob.moveToDelayed).not.toHaveBeenCalled();
    expect(bullJob.updateData).not.toHaveBeenCalled();
    expect(mocks.failJobStep).toHaveBeenCalledWith("job1", "DOWNLOAD", error);
  });

  it("falls through to the normal failure path when no BullMQ job handle is passed (direct call)", async () => {
    const error = ytDlp403Error();
    mocks.downloadVideo.mockRejectedValue(error);

    await expect(runDownloadStage(PAYLOAD)).rejects.toBe(error);

    expect(mocks.failJobStep).toHaveBeenCalledWith("job1", "DOWNLOAD", error);
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { status: "FAILED", error: expect.stringContaining("SOURCE_UNAVAILABLE") },
    });
  });
});
