import {
  getStageQueue,
  jobStepService,
  prisma,
  uploadFile,
} from "@clipclap/shared";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { downloadVideo } from "../processors/download";
import { normalizeSource } from "../processors/normalize";
import { SourceUnavailableError, UnsupportedInputError } from "../processors/errors";
import { safeTagJobError } from "./job-error";
import type { DownloadStagePayload } from "./types";

export async function runDownloadStage(
  payload: DownloadStagePayload
): Promise<void> {
  let localPath: string | undefined;
  let tempNormalizedPath: string | undefined;

  try {
    await jobStepService.startJobStep(payload.jobId, "DOWNLOAD", payload);
    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "DOWNLOADING", processingStartedAt: new Date() },
    });

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: payload.jobId },
    });
    localPath = await downloadVideo(
      job.sourceUrl ?? undefined,
      job.sourceKey ?? undefined
    );

    const sourceArtifactKey = `work/${payload.userId}/${payload.jobId}/source-${randomUUID()}.mp4`;
    await uploadFile(sourceArtifactKey, localPath, "video/mp4");

    // A/V timeline normalization (idempotent: BullMQ retries skip when done)
    let normalizedArtifactKey = job.normalizedArtifactKey;
    let normalizeAction = "cached";
    if (!normalizedArtifactKey) {
      const outcome = await normalizeSource(localPath);
      normalizeAction = outcome.action;
      if (outcome.action === "none") {
        normalizedArtifactKey = sourceArtifactKey;
      } else {
        normalizedArtifactKey = `work/${payload.userId}/${payload.jobId}/normalized-${randomUUID()}.mp4`;
        await uploadFile(normalizedArtifactKey, outcome.path, "video/mp4");
        tempNormalizedPath = outcome.path;
      }
    }

    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "DOWNLOADING", sourceArtifactKey, normalizedArtifactKey },
    });
    await jobStepService.completeJobStep(payload.jobId, "DOWNLOAD", {
      sourceArtifactKey,
      normalizedArtifactKey,
      normalizeAction,
    });
    await getStageQueue("transcribe").add("transcribe", payload);
  } catch (error) {
    await jobStepService.failJobStep(payload.jobId, "DOWNLOAD", error);
    await markJobFailed(payload.jobId, error);
    throw error;
  } finally {
    if (localPath) await unlink(localPath).catch(() => {});
    if (tempNormalizedPath) await unlink(tempNormalizedPath).catch(() => {});
  }
}

async function markJobFailed(jobId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Same rule as the analyze stage: the boundary that stores a user-visible
  // failure tags it, and the raw diagnostics stay in the message behind the
  // code. The two coded cases are the download failures a BullMQ retry can
  // never fix, because every attempt re-reads the identical file or re-fetches
  // the identical URL - so the copy has to hand the user something to do
  // instead of promising a rescue that is not coming. Everything else (R2,
  // ffmpeg, disk) stays untagged and renders as the generic message.
  const tagged =
    error instanceof UnsupportedInputError
      ? safeTagJobError("UNSUPPORTED_INPUT", message)
      : error instanceof SourceUnavailableError
        ? safeTagJobError("SOURCE_UNAVAILABLE", message)
        : message;
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "FAILED", error: tagged },
  });
}
