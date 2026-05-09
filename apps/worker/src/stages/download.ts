import {
  getStageQueue,
  jobStepService,
  prisma,
  uploadFile,
} from "@clipfast/shared";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { downloadVideo } from "../processors/download";
import type { DownloadStagePayload } from "./types";

export async function runDownloadStage(
  payload: DownloadStagePayload
): Promise<void> {
  let localPath: string | undefined;

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

    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "DOWNLOADING", sourceArtifactKey },
    });
    await jobStepService.completeJobStep(payload.jobId, "DOWNLOAD", {
      sourceArtifactKey,
    });
    await getStageQueue("transcribe").add("transcribe", payload);
  } catch (error) {
    await jobStepService.failJobStep(payload.jobId, "DOWNLOAD", error);
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
