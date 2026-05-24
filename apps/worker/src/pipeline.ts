import { jobService, uploadFile, prisma, getPlanLimits, computeClipExpiresAt } from "@clipfast/shared";
import type { TranscriptionResult, Highlight } from "@clipfast/shared";
import { downloadVideo } from "./processors/download";
import { transcribeVideo } from "./processors/transcribe";
import { analyzeHighlights } from "./processors/analyze";
import { cutClips, trimClipFile } from "./processors/cut";
import { burnSubtitles } from "./processors/subtitles";
import { buildJobCostTelemetry } from "./cost-telemetry";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";

export async function processVideoJob(
  jobId: string,
  userId: string
): Promise<void> {
  const tempFiles: string[] = [];
  const processingStartedAt = new Date();
  let transcribeMs = 0;
  let analyzeMs = 0;
  let renderMs = 0;
  let clipsGenerated = 0;

  const cleanup = async () => {
    for (const f of tempFiles) {
      await unlink(f).catch(() => {});
    }
  };

  try {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const planLimits = getPlanLimits(user.plan);
    // Compute once per job: the user's plan won't change mid-job, so all
    // clips created in this run share the same retention window.
    const clipExpiresAt = computeClipExpiresAt(user.plan, user.billingCycle);

    // Step 1: Download
    await jobService.updateJobStatus(jobId, "DOWNLOADING");
    const videoPath = await downloadVideo(
      job.sourceUrl ?? undefined,
      job.sourceKey ?? undefined
    );
    tempFiles.push(videoPath);
    console.log(`[${jobId}] Downloaded to ${videoPath}`);

    // Step 2: Transcribe
    await jobService.updateJobStatus(jobId, "TRANSCRIBING");
    const transcribeStartedAt = Date.now();
    const transcription: TranscriptionResult =
      await transcribeVideo(videoPath);
    transcribeMs = Date.now() - transcribeStartedAt;
    const inferredSourceDurationSec =
      job.sourceDurationSec ?? inferDurationFromSegments(transcription);
    await jobService.updateJobStatus(jobId, "TRANSCRIBING", {
      transcription: transcription.text,
    });
    if (!job.sourceDurationSec && inferredSourceDurationSec > 0) {
      await prisma.job.update({
        where: { id: jobId },
        data: { sourceDurationSec: inferredSourceDurationSec },
      });
    }
    console.log(
      `[${jobId}] Transcribed: ${transcription.segments.length} segments`
    );

    // Step 3: Analyze
    await jobService.updateJobStatus(jobId, "ANALYZING");
    const analyzeStartedAt = Date.now();
    const highlights: Highlight[] =
      await analyzeHighlights(transcription);
    analyzeMs = Date.now() - analyzeStartedAt;
    await jobService.updateJobStatus(jobId, "ANALYZING", {
      highlights,
    });
    console.log(`[${jobId}] Found ${highlights.length} highlights`);

    // Step 4: Cut + Subtitles + Upload
    await jobService.updateJobStatus(jobId, "CUTTING");
    const renderStartedAt = Date.now();

    for (const highlight of highlights) {
      // Cut the clip
      const [cutResult] = await cutClips(videoPath, [highlight]);
      tempFiles.push(cutResult.clipPath);

      let finalClipPath = cutResult.clipPath;

      // Add subtitles if enabled
      if (job.subtitles) {
        const preset = (job.subtitlePreset as "tiktok" | "minimal" | "bold") || "tiktok";
        const subbedPath = await burnSubtitles(
          cutResult.clipPath,
          transcription.segments,
          highlight.start,
          highlight.end,
          preset
        );
        tempFiles.push(subbedPath);
        finalClipPath = subbedPath;
      }

      // TODO: Add watermark for FREE plan (post-MVP polish)

      // Upload to R2
      const storageKey = `clips/${userId}/${jobId}/${randomUUID()}.mp4`;
      await uploadFile(storageKey, finalClipPath, "video/mp4");

      // Create clip record
      await prisma.clip.create({
        data: {
          jobId,
          userId,
          title: highlight.title,
          storageKey,
          duration: Math.round(highlight.end - highlight.start),
          startTime: highlight.start,
          endTime: highlight.end,
          subtitles: job.subtitles,
          subtitlePreset: job.subtitlePreset,
          expiresAt: clipExpiresAt,
        },
      });
      clipsGenerated += 1;

      console.log(`[${jobId}] Clip uploaded: ${highlight.title}`);
    }
    renderMs = Date.now() - renderStartedAt;

    // Done
    const processingEndedAt = new Date();
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "DONE",
        ...buildJobCostTelemetry({
          sourceDurationSec: inferredSourceDurationSec,
          processingStartedAt,
          processingEndedAt,
          transcribeMs,
          analyzeMs,
          renderMs,
          clipsGenerated,
          transcriptionModel:
            process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
        }),
      },
    });
    console.log(`[${jobId}] Job complete - ${highlights.length} clips`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[${jobId}] Pipeline failed:`, message);
    await jobService.updateJobStatus(jobId, "FAILED", { error: message });
    throw error;
  } finally {
    await cleanup();
  }
}

function inferDurationFromSegments(transcription: TranscriptionResult): number {
  const lastEnd = transcription.segments.reduce(
    (max, segment) => Math.max(max, segment.end),
    0
  );
  return Math.ceil(lastEnd);
}

export interface TrimClipJobData {
  clipId: string;
  originalClipStorageKey: string;
  jobId: string;
  userId: string;
  start: number;
  end: number;
}

export async function processTrimClipJob(
  data: TrimClipJobData
): Promise<void> {
  const tempFiles: string[] = [];

  const cleanup = async () => {
    for (const f of tempFiles) {
      await unlink(f).catch(() => {});
    }
  };

  try {
    const originalPath = await downloadVideo(
      undefined,
      data.originalClipStorageKey
    );
    tempFiles.push(originalPath);

    const trimmedPath = await trimClipFile(
      originalPath,
      data.start,
      data.end
    );
    tempFiles.push(trimmedPath);

    const storageKey = `clips/${data.userId}/${data.jobId}/${randomUUID()}.mp4`;
    await uploadFile(storageKey, trimmedPath, "video/mp4");

    await prisma.clip.update({
      where: { id: data.clipId },
      data: {
        storageKey,
        duration: Math.round(data.end - data.start),
      },
    });
  } finally {
    await cleanup();
  }
}
