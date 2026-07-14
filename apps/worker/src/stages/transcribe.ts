import {
  getStageQueue,
  jobStepService,
  prisma,
} from "@clipclap/shared";
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
    const sourceKey = requireString(
      job.normalizedArtifactKey ?? job.sourceArtifactKey,
      "sourceArtifactKey"
    );
    localPath = await downloadVideo(undefined, sourceKey);

    const startedAt = Date.now();
    const outcome = await transcribeVideo(localPath);
    const transcribeMs = Date.now() - startedAt;
    const { transcription } = outcome;
    const inferredSourceDurationSec =
      job.sourceDurationSec ?? inferDurationFromSegments(transcription);

    const minCoverage = Number(process.env.TRANSCRIPT_MIN_COVERAGE) || 0.9;
    if (outcome.coverage < minCoverage) {
      throw new Error(
        `Transcript coverage ${(outcome.coverage * 100).toFixed(0)}% is below the ${(minCoverage * 100).toFixed(0)}% floor (${outcome.missingRanges.length} missing ranges)`
      );
    }

    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "TRANSCRIBING",
        transcription: transcription.text,
        transcriptJson: transcription as unknown as Prisma.InputJsonValue,
        transcribeMs,
        language: transcription.language ?? null,
        languageRaw: transcription.languageRaw ?? null,
        transcriptCoverage: outcome.coverage,
        transcriptPartial: outcome.partial,
        ...(inferredSourceDurationSec > 0
          ? { sourceDurationSec: inferredSourceDurationSec }
          : {}),
      },
    });
    await jobStepService.completeJobStep(payload.jobId, "TRANSCRIBE", {
      segments: transcription.segments.length,
      transcribeMs,
      language: transcription.language ?? null,
      coverage: outcome.coverage,
      missingRanges: outcome.missingRanges.length,
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
