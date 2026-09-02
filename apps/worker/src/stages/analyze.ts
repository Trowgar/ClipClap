import {
  getStageQueue,
  jobStepService,
  prisma,
} from "@clipclap/shared";
import type { Prisma } from "@prisma/client";
import { analyzeHighlightsV1 } from "../processors/analyze";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { AnalyzeTechnicalError } from "../analyze-v2/critic";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { resolveEngine } from "../analyze-v2/dispatch";
import { detectSong } from "../analyze-v2/song-gate";
import { selectHookWindows, type HookWindow } from "../analyze-v2/music-hook";
import { newUsage } from "../analyze-v2/llm";
import type { V2Result } from "../analyze-v2/types";
import { safeTagJobError } from "./job-error";
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
    const cfg = loadAnalyzeConfig();
    const engine = resolveEngine(payload.jobId, cfg);

    // TRANSCRIBE persists all three per-second envelopes on its own JobStep.
    // Read that row once when a downstream path needs signals: visual recall
    // consumes motion, while music-shorts consumes energy and luma. The dark
    // normal path intentionally does not perform this lookup or thread a
    // motion field into V2.
    const visualSignals = cfg.visualRecallMode !== "off"
      ? await readTranscribeEnvelopes(payload.jobId)
      : undefined;

    const startedAt = Date.now();

    if (engine === "legacy" || engine === "shadow") {
      // V1 ships. Shadow additionally runs V2 into JobStep output only.
      const highlights = await analyzeHighlightsV1(transcription);
      const analyzeMs = Date.now() - startedAt;
      await prisma.job.update({
        where: { id: payload.jobId },
        data: {
          status: "ANALYZING",
          highlights: highlights as unknown as Prisma.InputJsonValue,
          analyzeMs,
          analyzeEngine: "LEGACY",
          highlightsVersion: 1,
        },
      });

      let shadow: Prisma.InputJsonValue | undefined;
      if (engine === "shadow") {
        try {
          const v2 = await analyzeHighlightsV2(transcription, {
            cfg,
            transcriptPartial: job.transcriptPartial,
            sourceDurationSec: job.sourceDurationSec ?? undefined,
            sourceUrl: job.sourceUrl ?? undefined,
            ...(visualSignals ? { motionEnvelope: visualSignals.motionEnvelope } : {}),
          });
          shadow = {
            highlights: v2.highlights,
            noClipsReason: v2.noClipsReason ?? null,
            telemetry: v2.telemetry,
            usage: v2.usage,
          } as unknown as Prisma.InputJsonValue;
        } catch (error) {
          shadow = { error: error instanceof Error ? error.message : String(error) };
        }
      }

      await jobStepService.completeJobStep(payload.jobId, "ANALYZE", {
        engine,
        highlights: highlights.length,
        analyzeMs,
        ...(shadow !== undefined ? { shadowV2: shadow } : {}),
      });
      await getStageQueue("render").add("render", {
        jobId: payload.jobId,
        userId: payload.userId,
        mode: "clips",
      });
      return;
    }

    // recall-critic path: content outcomes never throw
    //
    // Song-lyric source refusal (spec 2026-08-10 "Clip arc audit..." task 8):
    // a deterministic, pre-scan check - BEFORE analyzeHighlightsV2 (and the
    // scanner/critic calls inside it) ever runs, the same "free" shape the
    // degenerate guard at the top of that function already has for an empty
    // transcript. Placed HERE rather than inside analyze-v2/index.ts (which
    // already owns the degenerate/NO_USABLE_SPEECH decision) because that
    // file is off limits for this task - other agents are editing it
    // concurrently for the arc-audit programme - so this is a second,
    // narrower pre-scan gate for a transcript that has plenty of words but
    // is verse. See analyze-v2/song-gate.ts for the measured thresholds.
    const songGate = cfg.songGateEnabled
      ? detectSong(transcription.segments)
      : null;

    // Music shorts (spec 2026-08-23-music-shorts, task M3): a firing song
    // gate is not automatically a refusal any more. When the source is a
    // single track (<= musicShortsMaxSec - the Леонтьев compilation case
    // stays refused above that ceiling) the hook-window detector gets a
    // shot BEFORE the refusal result below is built. `windows.length === 0`
    // (computeRepSpans found nothing AND the envelope is empty) falls
    // through to the existing refusal untouched - an honest zero, not a
    // guessed window.
    let musicShorts: {
      windows: HookWindow[];
      envelopeLen: number;
      lumaLen: number;
    } | null = null;
    if (
      songGate?.fired &&
      cfg.musicShortsEnabled &&
      typeof job.sourceDurationSec === "number" &&
      job.sourceDurationSec > 0 &&
      job.sourceDurationSec <= cfg.musicShortsMaxSec
    ) {
      const { energyEnvelope, lumaEnvelope } = visualSignals ?? await readTranscribeEnvelopes(payload.jobId);
      const windows = selectHookWindows(
        {
          segments: transcription.segments,
          energyEnvelope,
          lumaEnvelope,
          durationSec: job.sourceDurationSec,
        },
        cfg.musicShortsCount
      );
      if (windows.length > 0) {
        musicShorts = {
          windows,
          envelopeLen: energyEnvelope.length,
          lumaLen: lumaEnvelope.length,
        };
      }
    }

    const result: V2Result = musicShorts
      ? {
          highlights: musicShorts.windows.map((w, i) => ({
            start: w.startSec,
            end: w.endSec,
            title: `Hook ${i + 1}`,
            // Names the mechanism, not a guessed song title/chorus lyric -
            // the detector never sees track metadata. Owner may rename this
            // copy later (spec §2 leaves several music-shorts decisions
            // owner-pending; this wording is not one of the settled ones).
            description: "Chorus/hook segment of this track",
            lowQuality: false,
          })),
          // No noClipsReason: this is a normal non-empty result, not a
          // refusal - it must ride the SAME rails as any other >0-highlight
          // V2Result below (job update, completeJobStep, render enqueue).
          telemetry: {
            path: "music-shorts",
            songGate,
            musicShorts: {
              windows: musicShorts.windows,
              envelopeLen: musicShorts.envelopeLen,
              // music-shorts direction R2: luma envelope length alongside
              // envelopeLen (energy) above - each window's own darkSeconds
              // (see analyze-v2/music-hook.ts's HookWindow) already rides
              // along inside `windows` itself.
              lumaLen: musicShorts.lumaLen,
            },
          },
          // Zero LLM calls: the detector (analyze-v2/music-hook.ts) is pure
          // repetition/energy scoring, no scan, no critic, no finalizer.
          usage: newUsage(),
        }
      : songGate?.fired
      ? {
          highlights: [],
          // Resolves exactly like NO_USABLE_SPEECH does today: an honest
          // zero-clip DONE outcome, never FAILED (billing invariant,
          // engine-notes §6) - reusing the enum value rather than adding one,
          // per this task's own instruction not to touch the prisma schema.
          noClipsReason: "NO_USABLE_SPEECH",
          telemetry: { path: "song-gate", songGate },
          usage: newUsage(),
        }
      : await analyzeHighlightsV2(transcription, {
          cfg,
          transcriptPartial: job.transcriptPartial,
          // Powers ONLY the short-source rescue's "is this short" test - see
          // AnalyzeV2Options; source-recheck persisted this from the real
          // downloaded file before ANALYZE ever runs.
          sourceDurationSec: job.sourceDurationSec ?? undefined,
          // Powers ONLY resolveAnalysisMode's hostname rules (spec 2026-08-
          // 19-stream-analyze-mode, S1) - mirrors sourceDurationSec above.
          sourceUrl: job.sourceUrl ?? undefined,
          ...(visualSignals ? { motionEnvelope: visualSignals.motionEnvelope } : {}),
        });
    // Flag on but not fired: still recorded, so the job record can show the
    // gate evaluated this transcript and let it through - task 8's own
    // acceptance criterion ("telemetry present when the flag is on and
    // absent when off"). Merged onto the real result's telemetry rather than
    // replacing it, so nothing analyzeHighlightsV2 already recorded is lost.
    if (songGate && !songGate.fired) {
      (result.telemetry as Record<string, unknown>).songGate = songGate;
    }
    const analyzeMs = Date.now() - startedAt;

    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "ANALYZING",
        highlights: result.highlights as unknown as Prisma.InputJsonValue,
        analyzeMs,
        analyzeEngine: "RECALL_CRITIC",
        highlightsVersion: 2,
        noClipsReason: result.noClipsReason ?? null,
        analysisInputTokens: result.usage.inputTokens,
        analysisOutputTokens: result.usage.outputTokens,
        // The same usage object, decomposed - written in the SAME update as the
        // two totals above so the three can never disagree about a run. Stored
        // exactly as the engine built it (byModel keeps `requests` too, which
        // prices nothing but says how many attempts each model absorbed);
        // reshaping it here would mean two definitions of the breakdown.
        // finalize.ts prefers this column over the ANALYZE step's copy.
        analysisUsageByModel:
          result.usage.byModel as unknown as Prisma.InputJsonValue,
        // Music shorts v1 decision (spec §2): subtitles OFF, in this SAME
        // update - word timings on singing are unreliable, so burning a cue
        // track under a chorus would show text the singer never said at that
        // instant. Every other song-gate/refusal/normal path leaves
        // job.subtitles at whatever DOWNLOAD/the user already set.
        ...(musicShorts ? { subtitles: false } : {}),
      },
    });
    await jobStepService.completeJobStep(payload.jobId, "ANALYZE", {
      engine,
      highlights: result.highlights.length,
      analyzeMs,
      noClipsReason: result.noClipsReason ?? null,
      telemetry: result.telemetry as unknown as Prisma.InputJsonValue,
      usage: result.usage as unknown as Prisma.InputJsonValue,
    });

    if (result.highlights.length === 0) {
      // honest empty outcome: skip render, finalize DONE with the reason
      await getStageQueue("finalize").add("finalize", {
        jobId: payload.jobId,
        userId: payload.userId,
      });
      return;
    }

    await getStageQueue("render").add("render", {
      jobId: payload.jobId,
      userId: payload.userId,
      mode: "clips",
    });
  } catch (error) {
    // technical failures only (LLM outage after fallbacks, DB errors):
    // retryable FAILED, quota untouched, BullMQ retries the stage
    await jobStepService.failJobStep(payload.jobId, "ANALYZE", error);
    await markJobFailed(payload.jobId, error);
    // Thrown on, untouched. Nothing here may turn an analyze failure into a
    // BullMQ UnrecoverableError: this stage cannot tell a settled refusal from
    // an upstream outage the fallback model happened to refuse, and the retry
    // is the whole reason a technical failure is not billed. 6434d4d cancelled
    // the attempts for one class of failure and got the class wrong twice over
    // (see the note in analyze-v2/index.ts) - the attempts cost a few cents,
    // the wrong call costs the user their video.
    throw error;
  }
}

/**
 * The TRANSCRIBE step's own `energyEnvelope`, `lumaEnvelope`, and
 * `motionEnvelope` (stages/transcribe.ts's `completeJobStep` call) live on
 * that JobStep row's outputJson, not on the Job row, so they are read the same way
 * finalize.ts reads the ANALYZE step's `usage.byModel` back off its own
 * JobStep row: ONE direct `prisma.jobStep.findUnique` on the `jobId_step`
 * unique index for all three, never a second query for another envelope and
 * never either one threaded through the queue payload. Each envelope
 * degrades to `[]` independently on a missing/malformed shape (no row yet,
 * a shape from before that field existed, a non-array, a non-number
 * entry) rather than throwing - one envelope being malformed or absent
 * (e.g. an old job predating lumaEnvelope or motionEnvelope) must not poison the other, and
 * `selectHookWindows` already treats an empty envelope of either kind as
 * "no signal for that dimension," which is the correct behaviour here too,
 * not a special case.
 */
async function readTranscribeEnvelopes(
  jobId: string
): Promise<{ energyEnvelope: number[]; lumaEnvelope: number[]; motionEnvelope: number[] }> {
  const step = await prisma.jobStep.findUnique({
    where: { jobId_step: { jobId, step: "TRANSCRIBE" } },
    select: { outputJson: true },
  });
  const output = step?.outputJson as Record<string, unknown> | null | undefined;
  return {
    energyEnvelope: asNumberArray(output?.energyEnvelope),
    lumaEnvelope: asNumberArray(output?.lumaEnvelope),
    motionEnvelope: asNumberArray(output?.motionEnvelope),
  };
}

function asNumberArray(raw: unknown): number[] {
  return Array.isArray(raw) && raw.every((n) => typeof n === "number")
    ? (raw as number[])
    : [];
}

async function markJobFailed(jobId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Job.error is shown to the user verbatim by the bot and the web app, so the
  // stage that persists it attaches the code the UI translates. Tagging happens
  // HERE, not at the throw sites: the engine keeps raising plain domain errors
  // with their full diagnostics, and the boundary that turns one into a stored,
  // user-visible failure decides what the user is told. Anything else (a DB
  // error, a bug) stays untagged and renders as the generic message.
  const tagged =
    error instanceof AnalyzeTechnicalError
      ? safeTagJobError("ANALYSIS_UNAVAILABLE", message)
      : message;
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "FAILED", error: tagged },
  });
}
