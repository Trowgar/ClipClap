import {
  getStageQueue,
  jobStepService,
  prisma,
} from "@clipfast/shared";
import type { Prisma } from "@prisma/client";
import { unlink } from "fs/promises";
import { downloadVideo } from "../processors/download";
import { transcribeVideo } from "../processors/transcribe";
import {
  inferDurationFromSegments,
  requireString,
  type TranscribeStagePayload,
} from "./types";

export async function runTranscribeStage(
  payload: TranscribeStagePayload
): Promise<void> {
  let localPath: string | undefined;

  try {
    await jobStepService.startJobStep(payload.jobId, "TRANSCRIBE", payload);
    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "TRANSCRIBING" },
    });

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: payload.jobId },
    });
    const sourceArtifactKey = requireString(
      job.sourceArtifactKey,
      "sourceArtifactKey"
    );
    localPath = await downloadVideo(undefined, sourceArtifactKey);

    const startedAt = Date.now();
    const transcription = await transcribeVideo(localPath);
    const transcribeMs = Date.now() - startedAt;
    const inferredSourceDurationSec =
      job.sourceDurationSec ?? inferDurationFromSegments(transcription);

    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "TRANSCRIBING",
        transcription: transcription.text,
        transcriptJson: transcription as unknown as Prisma.InputJsonValue,
        transcribeMs,
        ...(inferredSourceDurationSec > 0
          ? { sourceDurationSec: inferredSourceDurationSec }
          : {}),
      },
    });
    await jobStepService.completeJobStep(payload.jobId, "TRANSCRIBE", {
      segments: transcription.segments.length,
      transcribeMs,
    });
    await getStageQueue("analyze").add("analyze", payload);
  } catch (error) {
    await jobStepService.failJobStep(payload.jobId, "TRANSCRIBE", error);
    await markJobFailed(payload.jobId, error);
    throw error;
  } finally {
    if (localPath) await unlink(localPath).catch(() => {});
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
