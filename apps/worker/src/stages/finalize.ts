import { jobStepService, prisma } from "@clipfast/shared";
import { buildJobCostTelemetry } from "../cost-telemetry";
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
        ...buildJobCostTelemetry({
          sourceDurationSec: job.sourceDurationSec,
          processingStartedAt,
          processingEndedAt,
          transcribeMs: job.transcribeMs ?? 0,
          analyzeMs: job.analyzeMs ?? 0,
          renderMs: job.renderMs ?? 0,
          clipsGenerated: job.clipsGenerated,
          transcriptionModel:
            process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
        }),
      },
    });
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
    throw error;
  }
}
