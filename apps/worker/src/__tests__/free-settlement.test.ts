import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  getStageQueue: vi.fn(),
  queueAdd: vi.fn(),
  uploadFile: vi.fn(),
  downloadVideo: vi.fn(),
  normalizeSource: vi.fn(),
  jobFind: vi.fn(),
  jobFindUnique: vi.fn(),
  jobUpdate: vi.fn(),
  jobStepFindUnique: vi.fn(),
  probeLocalFile: vi.fn(),
  findFreeCharge: vi.fn(),
  freeBalanceSeconds: vi.fn(),
  reviseFreeChargeSeconds: vi.fn(),
  refundFailedJob: vi.fn(),
  refundZeroClipJob: vi.fn(),
  trueUpFreeCost: vi.fn(),
}));

vi.mock("@clipclap/shared", async () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  getStageQueue: mocks.getStageQueue,
  uploadFile: mocks.uploadFile,
  // real implementation: the stored `[CODE] ` prefix IS the contract the bot
  // and the web app parse, so a mock format would test nothing
  tagJobError: (
    await vi.importActual<typeof import("@clipclap/shared/lib/job-error")>(
      "@clipclap/shared/lib/job-error"
    )
  ).tagJobError,
  probeLocalFile: mocks.probeLocalFile,
  // Pricing is not what this suite tests - the cost figures it asserts on are
  // stubbed onto the prisma reads below. An empty table keeps finalize's
  // telemetry deterministic no matter what MODEL_PRICES_JSON holds in the
  // environment the tests happen to run in. The two lookups are the real ones:
  // they are pure, and a mock of them would be a second implementation of the
  // unknown-model-yields-undefined rule that the real cost tests rely on.
  ...(await vi.importActual<
    typeof import("@clipclap/shared/config/model-prices")
  >("@clipclap/shared/config/model-prices")),
  // ...but NOT the real loadModelPrices: it reads process.env. Overrides the
  // spread above, so keep it below.
  loadModelPrices: () => ({ tokensPerMillionUsd: {}, audioPerMinuteUsd: {} }),
  findFreeCharge: mocks.findFreeCharge,
  freeBalanceSeconds: mocks.freeBalanceSeconds,
  reviseFreeChargeSeconds: mocks.reviseFreeChargeSeconds,
  refundFailedJob: mocks.refundFailedJob,
  refundZeroClipJob: mocks.refundZeroClipJob,
  trueUpFreeCost: mocks.trueUpFreeCost,
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFind,
      findUnique: mocks.jobFindUnique,
      update: mocks.jobUpdate,
    },
    // finalize reads the ANALYZE step for the per-model token breakdown.
    jobStep: { findUnique: mocks.jobStepFindUnique },
  },
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/normalize", () => ({
  normalizeSource: mocks.normalizeSource,
}));

import { FreeAllowanceExceededError } from "../processors/errors";
import { runDownloadStage } from "../stages/download";
import { runFinalizeStage } from "../stages/finalize";
import { settleFreeLedger } from "../stages/free-settlement";
import { recheckSourceDuration } from "../stages/source-recheck";

const RECHECK = { jobId: "job1", userId: "u1", localPath: "/tmp/source.mp4" };

describe("download-stage source re-check", () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clear wipes the recorded calls but
    // KEEPS the implementations, so one test's mockRejectedValue leaks into
    // every later test in the file and silently turns a settlement into a
    // logged no-op.
    vi.resetAllMocks();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
    mocks.probeLocalFile.mockResolvedValue({
      ok: true,
      durationSec: 612.4,
      title: "Upload",
    });
    mocks.findFreeCharge.mockResolvedValue(null);
  });

  it("writes the measured duration over whatever the client claimed", async () => {
    await recheckSourceDuration(RECHECK);

    // Rounded, not floored or ceiled: Job.sourceDurationSec is Int? and the
    // submit path rounds too, so a corrected row and an uncorrected one cannot
    // differ by a second for no reason.
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: { sourceDurationSec: 612 },
    });
  });

  it("touches no ledger row for a paying account", async () => {
    mocks.findFreeCharge.mockResolvedValue(null);

    await recheckSourceDuration(RECHECK);

    expect(mocks.freeBalanceSeconds).not.toHaveBeenCalled();
    expect(mocks.reviseFreeChargeSeconds).not.toHaveBeenCalled();
    expect(mocks.refundFailedJob).not.toHaveBeenCalled();
  });

  it("corrects an upload's zero-second reservation to the measured length", async () => {
    mocks.findFreeCharge.mockResolvedValue({ seconds: 0, estimatedCostUsd: 0 });
    mocks.freeBalanceSeconds.mockResolvedValue(3600);

    await recheckSourceDuration(RECHECK);

    expect(mocks.reviseFreeChargeSeconds).toHaveBeenCalledWith("u1", "job1", 612);
    expect(mocks.refundFailedJob).not.toHaveBeenCalled();
  });

  it("measures against the balance WITH this job's own reservation added back", async () => {
    // The 1200s already sitting on this job's CHARGE row (a URL probed at
    // submit) has been subtracted from the balance. Comparing the measured
    // duration against the bare balance would charge the job twice: 612s
    // against 100s left would fail a job that fits perfectly well, because the
    // 1200 it is replacing is still being counted against it.
    mocks.findFreeCharge.mockResolvedValue({
      seconds: 1200,
      estimatedCostUsd: 0.19,
    });
    mocks.freeBalanceSeconds.mockResolvedValue(100);

    await recheckSourceDuration(RECHECK);

    expect(mocks.reviseFreeChargeSeconds).toHaveBeenCalledWith("u1", "job1", 612);
    expect(mocks.refundFailedJob).not.toHaveBeenCalled();
  });

  it("refuses and refunds when the measured length overruns the headroom", async () => {
    mocks.findFreeCharge.mockResolvedValue({ seconds: 0, estimatedCostUsd: 0 });
    mocks.freeBalanceSeconds.mockResolvedValue(300);

    await expect(recheckSourceDuration(RECHECK)).rejects.toThrow(
      FreeAllowanceExceededError
    );

    expect(mocks.refundFailedJob).toHaveBeenCalledWith("u1", "job1");
    // The reservation is NOT corrected on the way out. Writing the real seconds
    // first would floor the balance at zero and lose how far over the source
    // was, and it would leave an approved-looking charge on the ledger for a
    // job that never ran.
    expect(mocks.reviseFreeChargeSeconds).not.toHaveBeenCalled();
  });

  it("refunds before it throws, so a lost stage still leaves the allowance back", async () => {
    mocks.findFreeCharge.mockResolvedValue({ seconds: 0, estimatedCostUsd: 0 });
    mocks.freeBalanceSeconds.mockResolvedValue(300);
    const order: string[] = [];
    mocks.refundFailedJob.mockImplementation(async () => {
      order.push("refund");
    });

    await recheckSourceDuration(RECHECK).catch(() => order.push("throw"));

    expect(order).toEqual(["refund", "throw"]);
  });

  it("lets the job through when ffprobe is missing, and says so loudly", async () => {
    // An operational fault is not a verdict about the user. Refusing a paying
    // customer because a binary went missing from the image is the one outcome
    // this branch exists to prevent.
    mocks.probeLocalFile.mockResolvedValue({
      ok: false,
      reason: "probe-unavailable",
    });
    mocks.findFreeCharge.mockResolvedValue({ seconds: 0, estimatedCostUsd: 0 });
    mocks.freeBalanceSeconds.mockResolvedValue(0);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recheckSourceDuration(RECHECK)).resolves.toBeUndefined();

    expect(mocks.jobUpdate).not.toHaveBeenCalled();
    expect(mocks.refundFailedJob).not.toHaveBeenCalled();
    expect(mocks.reviseFreeChargeSeconds).not.toHaveBeenCalled();
    expect(errors.mock.calls[0]?.[0]).toContain("ffprobe is UNAVAILABLE");
    errors.mockRestore();
  });

  it("lets the job through when ffprobe ran but could not read the file", async () => {
    mocks.probeLocalFile.mockResolvedValue({ ok: false, reason: "no-duration" });
    mocks.findFreeCharge.mockResolvedValue({ seconds: 0, estimatedCostUsd: 0 });
    mocks.freeBalanceSeconds.mockResolvedValue(0);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recheckSourceDuration(RECHECK)).resolves.toBeUndefined();

    expect(mocks.refundFailedJob).not.toHaveBeenCalled();
    warns.mockRestore();
  });
});

describe("download stage wiring", () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clear wipes the recorded calls but
    // KEEPS the implementations, so one test's mockRejectedValue leaks into
    // every later test in the file and silently turns a settlement into a
    // logged no-op.
    vi.resetAllMocks();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: null,
      sourceKey: "uploads/u1/vod.mp4",
    });
    mocks.downloadVideo.mockResolvedValue("/tmp/source.mp4");
    mocks.normalizeSource.mockResolvedValue({
      path: "/tmp/source.mp4",
      action: "none",
    });
    mocks.probeLocalFile.mockResolvedValue({
      ok: true,
      durationSec: 4000,
      title: "Upload",
    });
  });

  it("fails the job with an actionable code and never reaches transcribe", async () => {
    mocks.findFreeCharge.mockResolvedValue({ seconds: 0, estimatedCostUsd: 0 });
    mocks.freeBalanceSeconds.mockResolvedValue(600);

    await expect(
      runDownloadStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow(FreeAllowanceExceededError);

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: {
        status: "FAILED",
        error:
          "[FREE_ALLOWANCE_EXCEEDED] free allowance exceeded: source measured " +
          "4000s, account has 600s of free allowance left (reservation of 0s refunded)",
      },
    });
    // TRANSCRIBE is where the money leaves the account, and it is never queued.
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    // Nor is the refused source copied into R2 first.
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("measures before it uploads, so a refused source is never stored", async () => {
    mocks.findFreeCharge.mockResolvedValue(null);

    await runDownloadStage({ jobId: "job1", userId: "u1" });

    expect(mocks.probeLocalFile).toHaveBeenCalledWith("/tmp/source.mp4");
    expect(mocks.uploadFile).toHaveBeenCalled();
    expect(mocks.queueAdd).toHaveBeenCalledWith("transcribe", {
      jobId: "job1",
      userId: "u1",
    });
  });
});

describe("finalize settlement", () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clear wipes the recorded calls but
    // KEEPS the implementations, so one test's mockRejectedValue leaks into
    // every later test in the file and silently turns a settlement into a
    // logged no-op.
    vi.resetAllMocks();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
    // No ANALYZE step row: this suite is about the ledger, and pricing falls
    // back to the aggregate columns exactly as it did before the breakdown.
    mocks.jobStepFindUnique.mockResolvedValue(null);
  });

  it("trues up before it refunds", async () => {
    // The refund row carries a deliberate estimatedCostUsd of 0 so the month's
    // real spend stays visible. trueUpFreeCost is scoped to kind CHARGE today
    // and so cannot reach it in either order - but the scope is one `where`
    // clause from being widened, and only this order stays correct if it is.
    const order: string[] = [];
    mocks.jobFindUnique.mockResolvedValue({
      userId: "u1",
      clipsGenerated: 0,
      estimatedTranscriptionCostUsd: 0.3,
      estimatedAnalysisCostUsd: 0.12,
      estimatedComputeCostUsd: 0.3,
    });
    mocks.trueUpFreeCost.mockImplementation(async () => {
      order.push("trueUp");
    });
    mocks.refundZeroClipJob.mockImplementation(async () => {
      order.push("refund");
      return true;
    });

    await settleFreeLedger("job1", "DONE");

    expect(order).toEqual(["trueUp", "refund"]);
    expect(mocks.trueUpFreeCost).toHaveBeenCalledWith(
      "u1",
      "job1",
      expect.closeTo(0.42, 10)
    );
  });

  it("charges the ledger the cash lines only, never compute", async () => {
    // The numbers are a real prod job: 0.179 whisper-1, 0.054 critic, 0.179 of
    // rented server. The server is paid for whether this job runs or not, so
    // the monthly ceiling - which bounds MONEY - must not be spent on it.
    // Charging the total burned the ceiling about 37% faster than the spend it
    // exists to bound.
    mocks.jobFindUnique.mockResolvedValue({
      userId: "u1",
      clipsGenerated: 4,
      estimatedTranscriptionCostUsd: 0.179,
      estimatedAnalysisCostUsd: 0.054,
      estimatedComputeCostUsd: 0.179,
    });

    await settleFreeLedger("job1", "DONE");

    expect(mocks.trueUpFreeCost).toHaveBeenCalledWith(
      "u1",
      "job1",
      expect.closeTo(0.233, 10)
    );
  });

  it("does not even read the compute line off the job row", async () => {
    // Stronger than checking the arithmetic: if the select ever goes back to
    // estimatedTotalCostUsd, that column carries compute inside it and no
    // assertion about the sum would notice.
    mocks.jobFindUnique.mockResolvedValue({
      userId: "u1",
      clipsGenerated: 1,
      estimatedTranscriptionCostUsd: 0.1,
      estimatedAnalysisCostUsd: 0.02,
    });

    await settleFreeLedger("job1", "DONE");

    const select = mocks.jobFindUnique.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("estimatedTotalCostUsd");
    expect(select).not.toHaveProperty("estimatedComputeCostUsd");
    expect(select.estimatedTranscriptionCostUsd).toBe(true);
    expect(select.estimatedAnalysisCostUsd).toBe(true);
  });

  it("refunds a failed job and never spends the zero-clip forgiveness on it", async () => {
    mocks.jobFindUnique.mockResolvedValue({
      userId: "u1",
      clipsGenerated: 0,
      estimatedTranscriptionCostUsd: 0.3,
      estimatedAnalysisCostUsd: 0.12,
      estimatedComputeCostUsd: 0.3,
    });

    await settleFreeLedger("job1", "FAILED");

    expect(mocks.refundFailedJob).toHaveBeenCalledWith("u1", "job1");
    // A failed job also has zero clips. Letting both fire would burn the one
    // forgiveness the user never used on breakage that was ours.
    expect(mocks.refundZeroClipJob).not.toHaveBeenCalled();
  });

  it("refunds nothing when the run produced clips", async () => {
    mocks.jobFindUnique.mockResolvedValue({
      userId: "u1",
      clipsGenerated: 3,
      estimatedTranscriptionCostUsd: 0.3,
      estimatedAnalysisCostUsd: 0.12,
      estimatedComputeCostUsd: 0.3,
    });

    await settleFreeLedger("job1", "DONE");

    expect(mocks.trueUpFreeCost).toHaveBeenCalled();
    expect(mocks.refundZeroClipJob).not.toHaveBeenCalled();
    expect(mocks.refundFailedJob).not.toHaveBeenCalled();
  });

  it("leaves the reservation's estimate alone when there is no real cost figure", async () => {
    // A job that failed before the telemetry was computed has null here.
    // Stamping 0 onto the CHARGE row would erase its reservation from the
    // month's total - the one number that bounds the whole free tier.
    mocks.jobFindUnique.mockResolvedValue({
      userId: "u1",
      clipsGenerated: 0,
      estimatedTranscriptionCostUsd: null,
      estimatedAnalysisCostUsd: null,
    });

    await settleFreeLedger("job1", "FAILED");

    expect(mocks.trueUpFreeCost).not.toHaveBeenCalled();
    expect(mocks.refundFailedJob).toHaveBeenCalledWith("u1", "job1");
  });

  it("never lets a ledger error change the job's outcome", async () => {
    mocks.jobFindUnique.mockResolvedValue({
      userId: "u1",
      clipsGenerated: 1,
      estimatedTranscriptionCostUsd: 0.3,
      estimatedAnalysisCostUsd: 0.12,
      estimatedComputeCostUsd: 0.3,
    });
    mocks.trueUpFreeCost.mockRejectedValue(new Error("connection reset"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(settleFreeLedger("job1", "DONE")).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("settles a DONE job only after the status has been written", async () => {
    const order: string[] = [];
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      sourceDurationSec: 600,
      processingStartedAt: new Date("2026-07-29T10:00:00.000Z"),
      transcribeMs: 1000,
      analyzeMs: 1000,
      renderMs: 1000,
      clipsGenerated: 0,
    });
    mocks.jobUpdate.mockImplementation(async () => {
      order.push("status");
      return {};
    });
    mocks.jobFindUnique.mockImplementation(async () => {
      order.push("settle");
      return {
        userId: "u1",
        clipsGenerated: 0,
        estimatedTranscriptionCostUsd: 0.06,
        estimatedAnalysisCostUsd: 0.05,
      };
    });

    await runFinalizeStage({ jobId: "job1", userId: "u1" });

    expect(order).toEqual(["status", "settle"]);
    expect(mocks.refundZeroClipJob).toHaveBeenCalledWith("u1", "job1");
  });

  it("settles a finalize that threw as a FAILED job", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      sourceDurationSec: 600,
      processingStartedAt: new Date("2026-07-29T10:00:00.000Z"),
      transcribeMs: 1000,
      analyzeMs: 1000,
      renderMs: 1000,
      clipsGenerated: 2,
    });
    mocks.completeJobStep.mockRejectedValue(new Error("job_steps write failed"));
    mocks.jobFindUnique.mockResolvedValue({
      userId: "u1",
      clipsGenerated: 2,
      estimatedTranscriptionCostUsd: 0.06,
      estimatedAnalysisCostUsd: 0.05,
    });

    await expect(
      runFinalizeStage({ jobId: "job1", userId: "u1" })
    ).rejects.toThrow("job_steps write failed");

    expect(mocks.refundFailedJob).toHaveBeenCalledWith("u1", "job1");
  });

  it("does nothing at all when the job row is gone", async () => {
    mocks.jobFindUnique.mockResolvedValue(null);

    await settleFreeLedger("job1", "FAILED");

    expect(mocks.trueUpFreeCost).not.toHaveBeenCalled();
    expect(mocks.refundFailedJob).not.toHaveBeenCalled();
  });
});
