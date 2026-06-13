import {
  computeClipExpiresAt,
  getStageQueue,
  jobStepService,
  prisma,
  uploadFile,
} from "@clipfast/shared";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { downloadVideo } from "../processors/download";
import { cutClips, trimClipFile } from "../processors/cut";
import {
  burnSubtitles,
  createAssFilter,
  segmentsToCues,
  sliceCues,
} from "../processors/subtitles";
import {
  asHighlights,
  asTranscription,
  requireString,
  type RenderStagePayload,
} from "./types";

export async function runRenderStage(
  payload: RenderStagePayload
): Promise<void> {
  await jobStepService.startJobStep(payload.jobId, "RENDER", payload);

  try {
    if (payload.mode === "trim") {
      await renderTrim(payload);
      await jobStepService.completeJobStep(payload.jobId, "RENDER", {
        mode: "trim",
        clipId: payload.clipId,
      });
      return;
    }

    await renderClips(payload);
  } catch (error) {
    await jobStepService.failJobStep(payload.jobId, "RENDER", error);
    if (payload.mode === "clips") {
      await markJobFailed(payload.jobId, error);
    }
    throw error;
  }
}

async function renderClips(
  payload: Extract<RenderStagePayload, { mode: "clips" }>
) {
  const tempFiles: string[] = [];

  try {
    await prisma.job.update({
      where: { id: payload.jobId },
      data: { status: "CUTTING" },
    });

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: payload.jobId },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: payload.userId },
      select: { plan: true, billingCycle: true },
    });
    const sourceArtifactKey = requireString(
      job.sourceArtifactKey,
      "sourceArtifactKey"
    );
    const transcription = asTranscription(job.transcriptJson);
    const highlights = asHighlights(job.highlights);
    const clipExpiresAt = computeClipExpiresAt(user.plan, user.billingCycle);

    const sourcePath = await downloadVideo(undefined, sourceArtifactKey);
    tempFiles.push(sourcePath);

    const startedAt = Date.now();
    let clipsGenerated = 0;
    const clipKeys: string[] = [];

    for (const highlight of highlights) {
      // Derived even when subtitles are off so the editor can enable them later
      const cues = segmentsToCues(
        transcription.segments,
        highlight.start,
        highlight.end
      );

      // Crop and subtitle burn happen in ONE encode pass - re-encoding the
      // cut a second time just for subtitles doubled render time.
      let assFilter: { filter: string; assPath: string } | null = null;
      if (job.subtitles && cues.length > 0) {
        assFilter = await createAssFilter(cues);
        tempFiles.push(assFilter.assPath);
      }
      const [cutResult] = await cutClips(
        sourcePath,
        [highlight],
        assFilter?.filter
      );
      tempFiles.push(cutResult.clipPath);
      const finalClipPath = cutResult.clipPath;

      const storageKey = `clips/${payload.userId}/${payload.jobId}/${randomUUID()}.mp4`;
      await uploadFile(storageKey, finalClipPath, "video/mp4");
      await prisma.clip.create({
        data: {
          jobId: payload.jobId,
          userId: payload.userId,
          title: highlight.title,
          storageKey,
          duration: Math.round(highlight.end - highlight.start),
          startTime: highlight.start,
          endTime: highlight.end,
          subtitles: job.subtitles,
          subtitleTrack: { cues } as unknown as Prisma.InputJsonValue,
          expiresAt: clipExpiresAt,
        },
      });
      clipKeys.push(storageKey);
      clipsGenerated += 1;
    }

    const renderMs = Date.now() - startedAt;
    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "CUTTING",
        renderMs,
        clipsGenerated,
        renderManifest: {
          mode: "clips",
          clipsGenerated,
          clipKeys,
        } as Prisma.InputJsonValue,
      },
    });
    await jobStepService.completeJobStep(payload.jobId, "RENDER", {
      clipsGenerated,
      renderMs,
    });
    await getStageQueue("finalize").add("finalize", {
      jobId: payload.jobId,
      userId: payload.userId,
    });
  } finally {
    await cleanup(tempFiles);
  }
}

async function renderTrim(
  payload: Extract<RenderStagePayload, { mode: "trim" }>
) {
  const tempFiles: string[] = [];

  try {
    // Prefer cutting from the job's source artifact: the clip file already
    // has subtitles burned in, so re-encoding it would stack new text on old.
    const cleanSource =
      payload.sourceArtifactKey &&
      payload.sourceStart !== undefined &&
      payload.sourceEnd !== undefined;

    // Edited cues arrive relative to the ORIGINAL clip file; re-window them
    // to the new trim range so they match the trimmed output.
    const editedCues = payload.subtitleTrack?.cues ?? [];
    const windowedCues = sliceCues(editedCues, payload.start, payload.end);
    const wantSubs = payload.subtitles && windowedCues.length > 0;

    let finalPath: string;
    if (cleanSource) {
      const sourcePath = await downloadVideo(undefined, payload.sourceArtifactKey!);
      tempFiles.push(sourcePath);
      let assFilter: { filter: string; assPath: string } | null = null;
      if (wantSubs) {
        assFilter = await createAssFilter(windowedCues);
        tempFiles.push(assFilter.assPath);
      }
      const [cutResult] = await cutClips(
        sourcePath,
        [
          {
            start: payload.sourceStart!,
            end: payload.sourceEnd!,
            title: "edit",
            reason: "re-render",
          },
        ],
        assFilter?.filter
      );
      finalPath = cutResult.clipPath;
      tempFiles.push(finalPath);
    } else {
      const originalPath = await downloadVideo(
        undefined,
        payload.originalClipStorageKey
      );
      tempFiles.push(originalPath);
      const trimmedPath = await trimClipFile(originalPath, payload.start, payload.end);
      tempFiles.push(trimmedPath);
      finalPath = trimmedPath;
      if (wantSubs) {
        const subbedPath = await burnSubtitles(trimmedPath, windowedCues);
        tempFiles.push(subbedPath);
        finalPath = subbedPath;
      }
    }

    const storageKey = `clips/${payload.userId}/${payload.jobId}/${randomUUID()}.mp4`;
    await uploadFile(storageKey, finalPath, "video/mp4");
    await prisma.clip.update({
      where: { id: payload.clipId },
      data: {
        storageKey,
        duration: Math.round(payload.end - payload.start),
        subtitleTrack: { cues: windowedCues } as unknown as Prisma.InputJsonValue,
      },
    });
  } finally {
    await cleanup(tempFiles);
  }
}

async function cleanup(files: string[]) {
  for (const file of files) {
    await unlink(file).catch(() => {});
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
