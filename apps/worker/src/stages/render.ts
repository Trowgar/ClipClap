import {
  computeClipExpiresAt,
  getStageQueue,
  jobStepService,
  prisma,
  uploadFile,
} from "@clipclap/shared";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { downloadVideo } from "../processors/download";
import { cutClips, trimClipFile, type CutResult } from "../processors/cut";
import { probeTimeline } from "../processors/normalize";
import { generateThumbnail } from "../processors/thumbnail";
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
import { computeCropPlan } from "../reframe";
import { loadReframeConfig } from "../reframe/config";
import { buildFiltergraph } from "../reframe/filtergraph";
import { planLayoutCounts, sliceCropPlan } from "../reframe/plan";
import type { CropPlan, FilterSpec } from "../reframe/types";

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
      job.normalizedArtifactKey ?? job.sourceArtifactKey,
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
    const renderChecks: Array<{
      renderDurationErrorMs: number;
      renderAvStartSkewMs: number | null;
    }> = [];
    const reframeCfg = loadReframeConfig();
    const reframeChecks: Array<{
      shotCount: number;
      detectMs: number;
      layouts?: Record<"single" | "split" | "center", number>;
      fallbackReason?: string;
    }> = [];
    // Detection has a wall-clock budget per highlight; when a source is too
    // heavy it times out repeatedly. Stop paying that cost for the rest of the
    // job after two timeouts in a row (reset on any non-timeout result).
    let consecutiveTimeouts = 0;

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
      // Smart reframe: per-shot face-aware crop (spec 2026-07-24). Any
      // failure degrades to the legacy center crop - never fails the render.
      let filterSpec: FilterSpec | null = null;
      let cropPlan: CropPlan | null = null;
      if (reframeCfg.engine === "faces") {
        if (consecutiveTimeouts >= 2) {
          // Two detection timeouts in a row: skip the remaining highlights of
          // this job so we stop burning the wall-clock budget. Each skipped
          // highlight takes the legacy center crop (filterSpec stays null).
          reframeChecks.push({
            shotCount: 0,
            detectMs: 0,
            fallbackReason: "skipped_after_timeouts",
          });
        } else {
          const reframe = await computeCropPlan(
            sourcePath,
            highlight.start,
            highlight.end,
            reframeCfg
          );
          cropPlan = reframe.plan;
          if (reframe.plan) {
            filterSpec = buildFiltergraph(reframe.plan, assFilter?.filter);
          } else {
            console.warn(
              `[render] reframe fallback on job ${payload.jobId}: ${reframe.fallbackReason}`
            );
          }
          if (reframe.fallbackReason === "timeout") {
            consecutiveTimeouts++;
          } else {
            consecutiveTimeouts = 0;
          }
          reframeChecks.push({
            shotCount: reframe.shotCount,
            detectMs: reframe.detectMs,
            ...(reframe.plan ? { layouts: planLayoutCounts(reframe.plan) } : {}),
            ...(reframe.fallbackReason
              ? { fallbackReason: reframe.fallbackReason }
              : {}),
          });
        }
      }
      // A filterSpec must never fail the render: if the reframe encode throws,
      // fall back once to the legacy center crop and record the degradation.
      let cutResult: CutResult;
      try {
        [cutResult] = await cutClips(
          sourcePath,
          [highlight],
          assFilter?.filter,
          filterSpec
        );
      } catch (error) {
        if (!filterSpec) throw error;
        console.warn(
          `[render] reframe encode fallback on job ${payload.jobId}:`,
          error
        );
        filterSpec = null;
        cropPlan = null;
        const check = reframeChecks[reframeChecks.length - 1];
        if (check) {
          delete check.layouts;
          check.fallbackReason = "encode_failed";
        }
        [cutResult] = await cutClips(
          sourcePath,
          [highlight],
          assFilter?.filter,
          null
        );
      }
      tempFiles.push(cutResult.clipPath);
      // duration error and A/V start skew are DIFFERENT failures: a clip can
      // have perfect duration and 400ms lip-sync offset (spec §10)
      try {
        const probe = await probeTimeline(cutResult.clipPath);
        const actualDuration = await probeDuration(cutResult.clipPath);
        const renderDurationErrorMs = Math.round(
          Math.abs(actualDuration - (highlight.end - highlight.start)) * 1000
        );
        const renderAvStartSkewMs =
          probe.videoStart !== null && probe.audioStart !== null
            ? Math.round(Math.abs(probe.videoStart - probe.audioStart) * 1000)
            : null;
        renderChecks.push({ renderDurationErrorMs, renderAvStartSkewMs });
        if (renderDurationErrorMs > 500 || (renderAvStartSkewMs ?? 0) > 80) {
          console.warn(
            `[render] drift on job ${payload.jobId}: durationErrorMs=${renderDurationErrorMs} avStartSkewMs=${renderAvStartSkewMs}`
          );
        }
      } catch (error) {
        console.warn(`[render] probe failed for job ${payload.jobId}:`, error);
      }
      // subtitle cue sanity (spec §7): cues must live inside the clip window
      if (cues.length > 0) {
        const clipDuration = highlight.end - highlight.start;
        const last = cues[cues.length - 1];
        if (cues[0].start < 0 || last.end > clipDuration + 0.5) {
          console.warn(
            `[render] cue window violation on job ${payload.jobId}: first=${cues[0].start} last=${last.end} duration=${clipDuration}`
          );
        }
      }
      const finalClipPath = cutResult.clipPath;

      const storageKey = `clips/${payload.userId}/${payload.jobId}/${randomUUID()}.mp4`;
      await uploadFile(storageKey, finalClipPath, "video/mp4");
      await prisma.clip.create({
        data: {
          jobId: payload.jobId,
          userId: payload.userId,
          title: highlight.title,
          description: highlight.description ?? null,
          score: highlight.score ?? null,
          language: highlight.language ?? null,
          lowQuality: highlight.lowQuality ?? false,
          hookStart: highlight.hookStart ?? null,
          hookEnd: highlight.hookEnd ?? null,
          payoffAt: highlight.payoffAt ?? null,
          clipKind: highlight.kind ?? null,
          storageKey,
          duration: Math.round(highlight.end - highlight.start),
          startTime: highlight.start,
          endTime: highlight.end,
          subtitles: job.subtitles,
          subtitleTrack: { cues } as unknown as Prisma.InputJsonValue,
          cropPlan: cropPlan
            ? (cropPlan as unknown as Prisma.InputJsonValue)
            : undefined,
          expiresAt: clipExpiresAt,
        },
      });
      clipKeys.push(storageKey);
      clipsGenerated += 1;
    }

    const renderMs = Date.now() - startedAt;

    // 16:9 still from the ORIGINAL source for the dashboard card. The clips are
    // 9:16, so reusing one as the card preview crops heads; a native-aspect
    // frame from the source fits cleanly. Best-effort - a thumbnail failure
    // must not fail the render. Sampled at the first highlight so the frame is
    // on-content rather than an intro/black frame.
    let thumbnailKey: string | undefined;
    if (highlights.length > 0) {
      try {
        const thumbPath = await generateThumbnail(sourcePath, highlights[0].start);
        tempFiles.push(thumbPath);
        const key = `work/${payload.userId}/${payload.jobId}/thumb-${randomUUID()}.jpg`;
        await uploadFile(key, thumbPath, "image/jpeg");
        thumbnailKey = key;
      } catch (error) {
        console.error(
          `[render] thumbnail generation failed for job ${payload.jobId}:`,
          error
        );
      }
    }

    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "CUTTING",
        renderMs,
        clipsGenerated,
        ...(thumbnailKey ? { thumbnailKey } : {}),
        renderManifest: {
          mode: "clips",
          clipsGenerated,
          clipKeys,
          renderChecks,
          reframe: {
            engine: reframeCfg.engine,
            checks: reframeChecks,
          },
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
    let slicedPlan: CropPlan | null = null;
    // The queue payload snapshots sourceArtifactKey at enqueue time, so it can
    // point at an object the retention sweep has since deleted. That is a
    // failure to OBTAIN the source, not a render failure - degrade to the
    // clip-file fallback below rather than throwing. An encode error further
    // down keeps its own existing behaviour.
    let cleanSourcePath: string | null = null;
    if (cleanSource) {
      try {
        cleanSourcePath = await downloadVideo(undefined, payload.sourceArtifactKey!);
        tempFiles.push(cleanSourcePath);
      } catch (error) {
        console.warn(
          `[render] trim source artifact unavailable on job ${payload.jobId} (key=${payload.sourceArtifactKey}), falling back to clip file:`,
          error
        );
        cleanSourcePath = null;
      }
    }
    if (cleanSourcePath) {
      const sourcePath = cleanSourcePath;
      let assFilter: { filter: string; assPath: string } | null = null;
      if (wantSubs) {
        assFilter = await createAssFilter(windowedCues);
        tempFiles.push(assFilter.assPath);
      }
      // Reuse the stored crop plan re-windowed to the trim range (clip-relative,
      // exactly like sliceCues) so trims keep the face-aware framing.
      const reframeCfg = loadReframeConfig();
      let filterSpec: FilterSpec | null = null;
      if (reframeCfg.engine === "faces") {
        // Defense in depth on top of sliceCropPlan's own guard: a malformed
        // stored cropPlan must never fail the trim - degrade to legacy crop.
        try {
          const clipRow = await prisma.clip.findUnique({
            where: { id: payload.clipId },
            select: { cropPlan: true },
          });
          if (clipRow?.cropPlan) {
            slicedPlan = sliceCropPlan(
              clipRow.cropPlan as unknown as CropPlan,
              payload.start,
              payload.end
            );
            if (slicedPlan) {
              // assFilter is null when subtitles are off, so this composes correctly
              filterSpec = buildFiltergraph(slicedPlan, assFilter?.filter);
            }
          }
        } catch (error) {
          console.warn(
            `[render] trim reframe reuse failed on job ${payload.jobId}:`,
            error
          );
          filterSpec = null;
          slicedPlan = null;
        }
      }
      const trimHighlight = {
        start: payload.sourceStart!,
        end: payload.sourceEnd!,
        title: "edit",
        reason: "re-render",
      };
      // A filterSpec must never fail the render: on an encode throw, fall back
      // once to the legacy center crop (see the clips path for the rationale).
      let cutResult: CutResult;
      try {
        [cutResult] = await cutClips(
          sourcePath,
          [trimHighlight],
          assFilter?.filter,
          filterSpec
        );
      } catch (error) {
        if (!filterSpec) throw error;
        console.warn(
          `[render] reframe encode fallback on job ${payload.jobId}:`,
          error
        );
        filterSpec = null;
        slicedPlan = null;
        [cutResult] = await cutClips(
          sourcePath,
          [trimHighlight],
          assFilter?.filter,
          null
        );
      }
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
      // originalClipStorageKey's pixels may already have subtitles burned in
      // (see RenderStagePayload.originalHasBurnedSubtitles). Burned-in pixels
      // cannot be un-burned, so on this degraded path a subtitle EDIT cannot
      // be applied, and neither can turning subtitles off: skipping the burn
      // and keeping the original text is the best available outcome, since
      // burning the new cues on top would stack two overlapping layers of
      // text, which is strictly worse.
      if (wantSubs && !payload.originalHasBurnedSubtitles) {
        const subbedPath = await burnSubtitles(trimmedPath, windowedCues);
        tempFiles.push(subbedPath);
        finalPath = subbedPath;
      } else if (wantSubs) {
        console.warn(
          `[render] trim fallback on job ${payload.jobId}: clip ${payload.clipId} already has subtitles burned in, skipping the requested subtitle edit to avoid double-burning`
        );
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
        cropPlan: slicedPlan
          ? (slicedPlan as unknown as Prisma.InputJsonValue)
          : undefined,
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

async function probeDuration(path: string): Promise<number> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { stdout } = await promisify(execFile)("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path,
  ]);
  return Number(stdout.trim()) || 0;
}
