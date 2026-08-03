import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The seam from "which models actually answered" to "what the job cost".
 *
 * Task 2 tied pricing to the model the CONFIG names. Job cmscht6rp001xq41s5rhjx6q0
 * (2026-08-03, the first production job on gpt-5.6-luna) showed the other half of
 * the same seam: every critic batch AND the finalizer failed on Luna and were
 * re-run on gpt-5-mini, so the tokens on the row were spent by a model whose name
 * appears nowhere on it. Priced at the configured critic's rate the job recorded
 * $0.024 for work that cost about $0.032 - and that figure is what
 * settleFreeLedger charges against the free-tier budget.
 *
 * This file runs the REAL cost-telemetry against a real price table, so it fails
 * if either end of the plumbing breaks: the read of the ANALYZE step, or the
 * pricing of what it carries. The other suites stub the table to empty, which
 * makes every cost null and every pricing bug invisible.
 */
const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  jobFind: vi.fn(),
  jobFindUnique: vi.fn(),
  jobUpdate: vi.fn(),
  jobStepFindUnique: vi.fn(),
  refundFailedJob: vi.fn(),
  refundZeroClipJob: vi.fn(),
  trueUpFreeCost: vi.fn(),
}));

/** Hoisted: stages/finalize.ts parses the table at module load, which happens
 *  inside the mock factory - before a plain const would be initialised. */
const PRICE_TABLE = vi.hoisted(() => ({
  tokensPerMillionUsd: {
    "gpt-5.6-luna": { input: 0.2, output: 1.2 },
    "gpt-5-mini": { input: 0.25, output: 2.0 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
  },
  audioPerMinuteUsd: { "whisper-1": 0.006, "gpt-4o-mini-transcribe": 0.003 },
}));

vi.mock("@clipclap/shared", async () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  // The real lookups - they are pure, and a mock of them would be a second
  // implementation of the unknown-model-yields-undefined rule.
  ...(await vi.importActual<typeof import("@clipclap/shared/config/model-prices")>(
    "@clipclap/shared/config/model-prices"
  )),
  // ...but a fixed table, below the spread so it wins: the real loader reads
  // process.env and this suite asserts exact dollars.
  loadModelPrices: () => PRICE_TABLE,
  refundFailedJob: mocks.refundFailedJob,
  refundZeroClipJob: mocks.refundZeroClipJob,
  trueUpFreeCost: mocks.trueUpFreeCost,
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFind,
      findUnique: mocks.jobFindUnique,
      update: mocks.jobUpdate,
    },
    jobStep: { findUnique: mocks.jobStepFindUnique },
  },
}));

import { runFinalizeStage, readAnalysisUsageByModel } from "../stages/finalize";

/** The real job's row: 44733 in / 12198 out, recorded at $0.024. */
const JOB_ROW = {
  id: "job1",
  sourceDurationSec: 1499,
  processingStartedAt: new Date("2026-08-03T09:00:00.000Z"),
  transcribeMs: 30_000,
  analyzeMs: 62_221,
  renderMs: 120_000,
  clipsGenerated: 12,
  analysisInputTokens: 44_733,
  analysisOutputTokens: 12_198,
  error: null,
};

/** The shape the engine writes into JobStep.outputJson. */
const FALLBACK_USAGE = {
  engine: "recall-critic",
  usage: {
    requests: 18,
    inputTokens: 44_733,
    outputTokens: 12_198,
    byModel: {
      // 8 critic attempts + 2 finalizer attempts that threw: a throw carries no
      // usage object, so the tokens they burned are not knowable from our side.
      "gpt-5.6-luna": { inputTokens: 0, outputTokens: 0, requests: 10 },
      "gpt-4o-mini": { inputTokens: 12_000, outputTokens: 2_000, requests: 3 },
      "gpt-5-mini": { inputTokens: 32_733, outputTokens: 10_198, requests: 5 },
    },
  },
};

function writtenData() {
  return mocks.jobUpdate.mock.calls.at(-1)?.[0]?.data as Record<string, unknown>;
}

describe("finalize prices a job by the models that answered", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.jobFind.mockResolvedValue(JOB_ROW);
    mocks.jobFindUnique.mockResolvedValue(null);
    mocks.jobStepFindUnique.mockResolvedValue({ outputJson: FALLBACK_USAGE });
  });

  it("reads the ANALYZE step of THIS job for the breakdown", async () => {
    // Under a mocked Prisma a wrong step name or a wrong key is invisible: the
    // stub answers whatever it is asked. So the query itself is asserted.
    await runFinalizeStage({ jobId: "job1", userId: "u1" });
    expect(mocks.jobStepFindUnique).toHaveBeenCalledWith({
      where: { jobId_step: { jobId: "job1", step: "ANALYZE" } },
      select: { outputJson: true },
    });
  });

  it("charges each model its own rate, not the configured critic's", async () => {
    await runFinalizeStage({ jobId: "job1", userId: "u1" });
    // gpt-4o-mini 12000 in / 2000 out = 0.0018 + 0.0012 = 0.0030
    // gpt-5-mini  32733 in / 10198 out = 0.008183 + 0.020396 = 0.028579
    // -> 0.031762, rounded 0.032. The bug recorded 0.024.
    expect(writtenData().estimatedAnalysisCostUsd).toBe(0.032);
  });

  it("still stamps the CONFIGURED critic on the row", async () => {
    // The row must stay able to say what the deployment asked for; that is the
    // only way a reader can see that it is not what ran.
    await runFinalizeStage({ jobId: "job1", userId: "u1" });
    expect(writtenData().criticModel).toBe("gpt-5.6-luna");
  });

  it("falls back to the aggregate columns when the step has no breakdown", async () => {
    // Jobs analyzed before the breakdown existed, and the legacy engine, price
    // exactly as they did before - unchanged, not newly null.
    mocks.jobStepFindUnique.mockResolvedValue({
      outputJson: { usage: { inputTokens: 44_733, outputTokens: 12_198, requests: 18 } },
    });
    await runFinalizeStage({ jobId: "job1", userId: "u1" });
    // 44733 * 0.20/M + 12198 * 1.20/M = 0.02358 -> 0.024
    expect(writtenData().estimatedAnalysisCostUsd).toBe(0.024);
  });

  it("ignores a breakdown that disagrees with the job row's totals", async () => {
    // analyze writes the job row first and the step second; a crash between the
    // two leaves the PREVIOUS attempt's step behind. Two records about
    // different work - pricing the older one would be a confident wrong number.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.jobStepFindUnique.mockResolvedValue({
      outputJson: {
        usage: {
          inputTokens: 999,
          outputTokens: 999,
          byModel: { "gpt-5-mini": { inputTokens: 999, outputTokens: 999, requests: 1 } },
        },
      },
    });
    await runFinalizeStage({ jobId: "job1", userId: "u1" });
    expect(writtenData().estimatedAnalysisCostUsd).toBe(0.024);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "does not match the job row"
    );
    vi.restoreAllMocks();
  });
});

describe("readAnalysisUsageByModel", () => {
  const totals = { inputTokens: 100, outputTokens: 10 };

  it("reads a well-formed breakdown that reconciles with the row", () => {
    expect(
      readAnalysisUsageByModel(
        {
          usage: {
            byModel: {
              "gpt-5-mini": { inputTokens: 60, outputTokens: 4, requests: 1 },
              "gpt-4o-mini": { inputTokens: 40, outputTokens: 6, requests: 2 },
            },
          },
        },
        totals
      )
    ).toEqual({
      "gpt-5-mini": { inputTokens: 60, outputTokens: 4 },
      "gpt-4o-mini": { inputTokens: 40, outputTokens: 6 },
    });
  });

  it("returns null for a payload that carries no breakdown at all", () => {
    for (const payload of [null, undefined, "nonsense", [], {}, { usage: {} }, { usage: 7 }]) {
      expect(readAnalysisUsageByModel(payload, { inputTokens: 0, outputTokens: 0 })).toBeNull();
    }
  });

  it("nulls the WHOLE map when one entry is malformed, never a partial", () => {
    // Dropping the bad entry would silently under-count that model's tokens,
    // which is the quiet-wrong-number failure this whole file exists to stop.
    for (const bad of [
      { inputTokens: "40", outputTokens: 6 },
      { inputTokens: 40 },
      { inputTokens: -40, outputTokens: 6 },
      { inputTokens: Number.NaN, outputTokens: 6 },
      null,
      42,
    ]) {
      expect(
        readAnalysisUsageByModel(
          {
            usage: {
              byModel: {
                "gpt-5-mini": { inputTokens: 60, outputTokens: 4, requests: 1 },
                "gpt-4o-mini": bad,
              },
            },
          },
          totals
        )
      ).toBeNull();
    }
  });

  it("returns null when the buckets do not sum to the row's totals", () => {
    const warn = vi.fn();
    expect(
      readAnalysisUsageByModel(
        { usage: { byModel: { "gpt-5-mini": { inputTokens: 60, outputTokens: 4 } } } },
        totals,
        warn
      )
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts a null-column row only when the breakdown is empty of tokens", () => {
    const warn = vi.fn();
    expect(
      readAnalysisUsageByModel(
        { usage: { byModel: { "gpt-5.6-luna": { inputTokens: 0, outputTokens: 0 } } } },
        { inputTokens: null, outputTokens: null },
        warn
      )
    ).toEqual({ "gpt-5.6-luna": { inputTokens: 0, outputTokens: 0 } });
    expect(warn).not.toHaveBeenCalled();
  });
});
