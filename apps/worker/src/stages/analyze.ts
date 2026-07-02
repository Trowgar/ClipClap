import {
  getStageQueue,
  jobStepService,
  prisma,
} from "@clipclap/shared";
import type { Prisma } from "@prisma/client";
import { analyzeHighlights } from "../processors/analyze";
import { asTranscription, type AnalyzeStagePayload } from "./types";

export async function runAnalyzeStage(
  payload: AnalyzeStagePayload
): Promise<void> {
  try {
    await jobStepService.startJobStep(payload.jobId, "ANALYZE", payload);
    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "ANALYZING" },
    });

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: payload.jobId },
    });
    const transcription = asTranscription(job.transcriptJson);

    const startedAt = Date.now();
    const highlights = await analyzeHighlights(transcription);
    const analyzeMs = Date.now() - startedAt;

    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "ANALYZING",
        highlights: highlights as unknown as Prisma.InputJsonValue,
        analyzeMs,
      },
    });
    await jobStepService.completeJobStep(payload.jobId, "ANALYZE", {
      highlights: highlights.length,
      analyzeMs,
    });
    await getStageQueue("render").add("render", {
      jobId: payload.jobId,
      userId: payload.userId,
      mode: "clips",
    });
  } catch (error) {
    await jobStepService.failJobStep(payload.jobId, "ANALYZE", error);
    await markJobFailed(payload.jobId, error);
    throw error;
  }
}

async function markJobFailed(jobId: string, error: unknown) {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
    },
  });
}
