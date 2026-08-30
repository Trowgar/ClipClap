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
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { downloadVideo } from "../processors/download";
import { cutClips, trimClipFile, type CutResult } from "../processors/cut";
import { probeTimeline } from "../processors/normalize";
import { generateThumbnail } from "../processors/thumbnail";
import {
  burnSubtitles,
  createAssFilter,
  segmentsToCues,
  sliceCues,
  summariseRestores,
} from "../processors/subtitles";
import {
  asHighlights,
  asTranscription,
  requireString,
  type RenderStagePayload,
} from "./types";
import { computeCropPlan } from "../reframe";
import { loadReframeConfig, type ReframeConfig } from "../reframe/config";
import { buildFiltergraph } from "../reframe/filtergraph";
import { detectLetterboxBars } from "../reframe/letterbox";
import { sliceCropPlan } from "../reframe/plan";
import { buildReframeCheck, markEncodeFailed } from "../reframe/telemetry";
import type { ReframeCheck } from "../reframe/telemetry";
import type { CropPlan, FilterSpec, MusicDirectionOpts } from "../reframe/types";

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

/**
 * The job's reframe config, with ONE override applied: a music-shorts job
 * (spec 2026-08-23-music-shorts, task M4) always renders with the stream
 * layouts forced off, regardless of the REFRAME_STREAM/REFRAME_STREAM_
 * VIRTUAL_CAM env literals.
 *
 * Measured 2026-08-23: the corpus E2E render of the Baby Shark hook window
 * (task M3's output, rendered through the real reframe engine) classified
 * stream+virtualCam - cartoon faces sit at ~8% of frame width, well inside
 * the stream classifier's small-face band - and shipped a TWO-TILE layout,
 * a boy-face tile stacked over a girl tile. Wrong product: a music short's
 * full performance frame IS the content, and the stream/virtual-cam layouts
 * exist for gameplay-with-a-webcam, not for a music video. Face-crop itself
 * (engine "faces", normal_face) is untouched by this override - the
 * Believer corpus render proved normal_face already frames a music video
 * well, so only the two stream-family knobs are forced off here, nothing
 * else about crop planning.
 *
 * This is the ONE place the per-job reframe config is born (renderClips'
 * only `loadReframeConfig()` call) rather than a condition sprinkled at
 * each `reframeCfg.stream`/`reframeCfg.streamVirtualCam` read site - both
 * reads downstream (computeCropPlan's own stream classification, and
 * buildFiltergraph's tile layout) see the override transparently because
 * they only ever see this one object.
 *
 * Reads the ANALYZE JobStep's own outputJson (stages/analyze.ts's
 * `completeJobStep` call) the same way stages/analyze.ts itself reads the
 * TRANSCRIBE step's row for `energyEnvelope` (task M3) - a direct
 * `prisma.jobStep.findUnique` on the `jobId_step` unique index. A missing
 * row, a missing `telemetry` key, or any path other than the exact literal
 * "music-shorts" all fall through to the unmodified env-sourced config -
 * the same "malformed degrades safely, never throws" discipline as that
 * read.
 *
 * Also returns `isMusicShorts` (tasks R1/R3/R4, spec 2026-08-23-music-shorts)
 * so `renderClips` can gate the letterbox-bar/punch-in/fade additions on the
 * SAME telemetry read that already gates the M4 stream override, rather than
 * querying the ANALYZE step a second time.
 */
async function loadReframeConfigForJob(
  jobId: string
): Promise<{ cfg: ReframeConfig; isMusicShorts: boolean }> {
  const cfg = loadReframeConfig();
  const analyzeStep = await prisma.jobStep.findUnique({
    where: { jobId_step: { jobId, step: "ANALYZE" } },
    select: { outputJson: true },
  });
  const telemetry = (
    analyzeStep?.outputJson as Record<string, unknown> | null | undefined
  )?.telemetry as Record<string, unknown> | undefined;
  const isMusicShorts = telemetry?.path === "music-shorts";
  if (isMusicShorts) {
    // musicMode (v1.1, spec 2026-08-23-music-shorts): reaches the planner via
    // ReframeConfig -> PlanOptions (see reframe/index.ts's planDetected), so
    // a faceless shot anchors on the detector's saliency centroid instead of
    // the frame centre, and every shot carries its spreadFrac for
    // filtergraph.ts's punch-in gate.
    return {
      cfg: { ...cfg, stream: false, streamVirtualCam: false, musicMode: true },
      isMusicShorts,
    };
  }
  return { cfg, isMusicShorts };
}

/**
 * Builds the ONE `musicDirection` object (tasks R1/R3/R4, spec
 * 2026-08-23-music-shorts) threaded explicitly into `buildFiltergraph` and
 * `cutClips` for a music-shorts job - never an env knob, because none of it
 * is operator-tunable. Bar detection runs ONCE per job (not per highlight),
 * sampled across the union of the job's own highlight windows; a failure or
 * a "no constant bar" verdict degrades to the zero pair, never to skipping
 * the render or throwing - punch-in and fades still apply on a source with
 * no letterbox at all, which is the common case.
 */
async function buildMusicDirection(
  sourcePath: string,
  highlights: Array<{ start: number; end: number }>
): Promise<MusicDirectionOpts> {
  const bars = await detectLetterboxBars(sourcePath, highlights);
  return {
    topBar: bars?.topBar ?? 0,
    bottomBar: bars?.bottomBar ?? 0,
    punchIn: true,
    fades: true,
  };
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

    // Retry idempotency (spec 2026-08-24-render-retry-and-stream-gate §1,
    // incident job cmt6ag9q8): a stall-recovery retry re-runs this FULL-JOB
    // path from scratch. Attempt 1 died silently mid-loop after creating 4
    // of 7 clip rows; attempt 2 re-created all 7 on top of the 4 orphans,
    // and delivery (which only filters deletedAt, never dedups by highlight
    // identity) sent all 11, 4 of them twice. Soft-delete any live leftovers
    // of a prior attempt before this attempt creates a single row per
    // highlight - delivery already excludes deletedAt rows in its own read
    // path, so the orphans become invisible there without touching anything
    // already sent (a row can only carry a telegramFileId after FINALIZE,
    // which never runs until this stage completes, so nothing delivered is
    // ever soft-deleted here). Scoped to THIS render path only - renderTrim's
    // single-clip re-render never reaches this function.
    //
    // telegramFileId: null is a second, independent guard on top of the
    // deletedAt: null scope above: under the narrow stall-reclaim race where
    // a prior attempt actually finished AND got delivered before this
    // retry's cleanup runs, the plain deletedAt: null clause would soft-
    // delete already-delivered rows, and the web dashboard (job.service's
    // getJob/getUserJobs, which reads clips with no deletedAt filter at all)
    // would then read them as expired. Excluding telegramFileId-carrying
    // rows protects them from that, and it can never let a duplicate slip
    // through either way - deliverClips already skips any row that already
    // carries a telegramFileId.
    await prisma.clip.updateMany({
      where: { jobId: payload.jobId, deletedAt: null, telegramFileId: null },
      data: { deletedAt: new Date() },
    });

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
    const { cfg: reframeCfg, isMusicShorts } = await loadReframeConfigForJob(
      payload.jobId
    );
    // R1/R3/R4 (spec 2026-08-23-music-shorts): built ONCE for the whole job,
    // from the source file and the union of its highlight windows - never
    // per-highlight, and never for a non-music job (undefined there, which
    // keeps every downstream call byte-identical to today).
    const musicDirection = isMusicShorts
      ? await buildMusicDirection(sourcePath, highlights)
      : undefined;
    const reframeChecks: ReframeCheck[] = [];
    // Telemetry for the dropped-word repair, summed over the job's clips.
    // `unresolved` growing is the signal that Whisper's output shape changed.
    const subtitleSummary = {
      segmentOccurrences: 0,
      restoredHead: 0,
      restoredTail: 0,
      unresolved: 0,
      merged: 0,
    };
    // Detection has a wall-clock budget per highlight; when a source is too
    // heavy it times out repeatedly. Stop paying that cost for the rest of the
    // job after two timeouts in a row (reset on any non-timeout result).
    let consecutiveTimeouts = 0;

    for (const [clipIndex, highlight] of highlights.entries()) {
      // The face is chosen from the language actually SPOKEN in this clip.
      // The highlight's own language wins over the job's because a source can
      // switch language partway through and the job carries only the dominant
      // one; both are nullable and an absent value keeps the Latin face.
      const clipLanguage = highlight.language ?? job.language;
      // Derived even when subtitles are off so the editor can enable them later.
      // clipLanguage passed through so CJK gets its own chunking budget
      // (subtitles.ts chunkParamsForLanguage) - without it every ja/zh/ko cue
      // would still chunk under the 3-word Latin cap, three single-character
      // Whisper "words" at a time, even after the face fix stops them
      // rendering as tofu (spec 2026-08-25-cjk-subtitles.md).
      const cues = segmentsToCues(
        transcription.segments,
        highlight.start,
        highlight.end,
        clipLanguage
      );
      // Same segments, same window, same repair as the cues above - counted
      // rather than re-derived, so the manifest describes what was drawn.
      const restores = summariseRestores(
        transcription.segments,
        highlight.start,
        highlight.end
      );
      subtitleSummary.segmentOccurrences += restores.segmentOccurrences;
      subtitleSummary.restoredHead += restores.restoredHead;
      subtitleSummary.restoredTail += restores.restoredTail;
      subtitleSummary.unresolved += restores.unresolved;
      subtitleSummary.merged += restores.merged;

      // Crop and subtitle burn happen in ONE encode pass - re-encoding the
      // cut a second time just for subtitles doubled render time.
      let assFilter: { filter: string; assPath: string } | null = null;
      if (job.subtitles && cues.length > 0) {
        assFilter = await createAssFilter(cues, clipLanguage);
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
          reframeChecks.push(
            buildReframeCheck({
              plan: null,
              shotCount: 0,
              detectMs: 0,
              fallbackReason: "skipped_after_timeouts",
            })
          );
        } else {
          const reframe = await computeCropPlan(
            sourcePath,
            highlight.start,
            highlight.end,
            reframeCfg
          );
          cropPlan = reframe.plan;
          if (reframe.plan) {
            filterSpec = buildFiltergraph(
              reframe.plan,
              assFilter?.filter,
              musicDirection
            );
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
          reframeChecks.push(
            buildReframeCheck({
              plan: reframe.plan,
              shotCount: reframe.shotCount,
              detectMs: reframe.detectMs,
              fallbackReason: reframe.fallbackReason,
              cutRecovery: reframe.cutRecovery,
              safetyShadow: reframe.safetyShadow,
            })
          );
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
          filterSpec,
          musicDirection?.fades,
          { jobId: payload.jobId, clipIndex }
        );
      } catch (error) {
        if (!filterSpec) throw error;
        console.warn(
          `[render] reframe encode fallback on job ${payload.jobId}:`,
          error
        );
        filterSpec = null;
        cropPlan = null;
        const idx = reframeChecks.length - 1;
        if (idx >= 0) reframeChecks[idx] = markEncodeFailed(reframeChecks[idx]);
        [cutResult] = await cutClips(
          sourcePath,
          [highlight],
          assFilter?.filter,
          null,
          musicDirection?.fades,
          { jobId: payload.jobId, clipIndex }
        );
      }
      tempFiles.push(cutResult.clipPath);
      // Black-tail trim (spec 2026-08-25-cjk-subtitles §Black-tail trim):
      // cutClips pulls the end back off a source that goes black right at the
      // nominal exit (RENDER_BLACK_TAIL_TRIM only) - undefined/equal to
      // highlight.end otherwise, so every downstream read of "the end" must
      // use this, not highlight.end, or the stored/measured clip would
      // describe a window longer than what was actually cut.
      const effectiveEnd = cutResult.effectiveEnd ?? highlight.end;
      // duration error and A/V start skew are DIFFERENT failures: a clip can
      // have perfect duration and 400ms lip-sync offset (spec §10)
      try {
        const probe = await probeTimeline(cutResult.clipPath);
        const actualDuration = await probeDuration(cutResult.clipPath);
        const renderDurationErrorMs = Math.round(
          Math.abs(actualDuration - (effectiveEnd - highlight.start)) * 1000
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
          duration: Math.round(effectiveEnd - highlight.start),
          startTime: highlight.start,
          endTime: effectiveEnd,
          // What was actually burned, not the job-level request: assFilter is
          // only set when job.subtitles is on AND this highlight has cues in
          // range, so a dialogue-free highlight burns nothing even when the
          // job asked for subtitles. A later edit of this clip trusts this
          // column to know whether re-burning would double-burn.
          subtitles: assFilter !== null,
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
          subtitles: subtitleSummary,
        } as unknown as Prisma.InputJsonValue,
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
    // The trim payload predates Arabic and carries no language, so read it.
    // One query, and only when something is actually going to be drawn.
    // clips.language is null on 13 rows in production, hence the job fallback.
    const trimLanguage = wantSubs
      ? await prisma.clip
          .findUnique({
            where: { id: payload.clipId },
            select: { language: true, job: { select: { language: true } } },
          })
          // Both `?.` are load-bearing. `row?.job.language` would THROW when
          // the row exists without its relation - which is exactly what a
          // mocked findUnique returns - and the catch below would swallow it
          // into a silent null, i.e. the Latin face on every trim, passing
          // every test.
          .then((row) => row?.language ?? row?.job?.language ?? null)
          .catch(() => null)
      : null;

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
        assFilter = await createAssFilter(windowedCues, trimLanguage);
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
        const subbedPath = await burnSubtitles(trimmedPath, windowedCues, trimLanguage);
        tempFiles.push(subbedPath);
        finalPath = subbedPath;
      } else if (wantSubs) {
        console.warn(
          `[render] trim fallback on job ${payload.jobId}: clip ${payload.clipId} already has subtitles burned in, skipping the requested subtitle edit to avoid double-burning`
        );
      }
    }

    // Record what actually happened to the pixels, not what the edit asked
    // for - a later edit of THIS clip reads this column (via editClip's
    // originalHasBurnedSubtitles) to decide whether burning again would
    // double-burn, so it must describe the file, not the request.
    // Clean source: this render is the only thing that could have burned
    // subtitles, so the outcome is exactly wantSubs. Fallback: the file
    // already carried burned-in text when originalHasBurnedSubtitles is
    // true, and that text survives untouched even when this edit asked for
    // subtitles off - the column must still say true.
    const subtitlesBurned = cleanSourcePath
      ? wantSubs
      : payload.originalHasBurnedSubtitles || wantSubs;

    const storageKey = `clips/${payload.userId}/${payload.jobId}/${randomUUID()}.mp4`;
    await uploadFile(storageKey, finalPath, "video/mp4");
    await prisma.clip.update({
      where: { id: payload.clipId },
      data: {
        storageKey,
        duration: Math.round(payload.end - payload.start),
        subtitles: subtitlesBurned,
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
  ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
  return Number(stdout.trim()) || 0;
}
