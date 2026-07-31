import { jobStepService, prisma } from "@clipclap/shared";
import { buildJobCostTelemetry } from "../cost-telemetry";
import { criticModel, transcriptionModel } from "../models";
import { settleFreeLedger } from "./free-settlement";
import type { FinalizeStagePayload } from "./types";

export async function runFinalizeStage(
  payload: FinalizeStagePayload
): Promise<void> {
  try {
    await jobStepService.startJobStep(payload.jobId, "FINALIZE", payload);

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: payload.jobId },
    });
    const processingEndedAt = new Date();
    const processingStartedAt = job.processingStartedAt ?? processingEndedAt;

    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "DONE",
        error: null,
        ...buildJobCostTelemetry({
          sourceDurationSec: job.sourceDurationSec,
          processingStartedAt,
          processingEndedAt,
          transcribeMs: job.transcribeMs ?? 0,
          analyzeMs: job.analyzeMs ?? 0,
          renderMs: job.renderMs ?? 0,
          clipsGenerated: job.clipsGenerated,
          transcriptionModel: transcriptionModel(),
          analysisInputTokens: job.analysisInputTokens,
          analysisOutputTokens: job.analysisOutputTokens,
          criticModel: criticModel(),
        }),
      },
    });

    // Settle the free ledger against the outcome that was just written: true up
    // the reservation's cost from the telemetry above, and give the allowance
    // back if the run produced nothing. It runs AFTER the status write, not
    // before, because the refunds are only safe on a state the job has actually
    // reached - a refund written against an outcome that then fails to persist
    // would be released for a job BullMQ retries and may still finish.
    await settleFreeLedger(payload.jobId, "DONE");

    await jobStepService.completeJobStep(payload.jobId, "FINALIZE", {
      status: "DONE",
    });
  } catch (error) {
    await jobStepService.failJobStep(payload.jobId, "FINALIZE", error);
    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    // Same rule on this side: the FAILED write comes first, and only a job that
    // is recorded as failed gets its allowance back. settleFreeLedger swallows
    // its own errors so the original failure is what propagates.
    await settleFreeLedger(payload.jobId, "FAILED");
    throw error;
  }
}
