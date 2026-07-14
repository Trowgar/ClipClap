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
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
    },
  });
}
