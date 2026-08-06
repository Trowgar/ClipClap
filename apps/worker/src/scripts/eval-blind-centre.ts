/**
 * Acceptance for the small-face anchoring change: how much delivered clip time
 * is framed on nothing while people are visible in the source?
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-blind-centre.ts"
 *
 * Every clip of every real job since SINCE is re-planned from its OWN detector
 * run over its own time range, and the time the plan spends on a `center`
 * layout is split three ways:
 *
 *   1. no face detected at all      - centring is CORRECT, there is nothing to
 *                                     point the window at
 *   2. people present, all under 6% - THE DEFECT. Measured at 298 seconds of
 *                                     1679 delivered (17.7%) before this change:
 *                                     two men at 5.2% and 5.5% of frame width at
 *                                     opposite ends of a podcast table, with the
 *                                     window centred on the table between them
 *   3. some face at or above 6%     - a different cause (spread too wide, no
 *                                     split available, the stream branch), not
 *                                     this change's business
 *
 * ---------------------------------------------------------------------------
 * "NEAR ZERO" IS NOT AN ACCEPTANCE CRITERION
 * ---------------------------------------------------------------------------
 *
 * Bucket 2 is printed span by span - clip, time range, duration, and the width
 * and sample count of EVERY surviving face in it. A remainder that is a
 * one-frame detection artefact is a pass; a remainder the rule failed to reach
 * is not; and only the listing tells them apart. A total on its own cannot, so
 * this script never reports one on its own.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT SEE, STATED BECAUSE IT IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 * - A clip whose plan comes back NULL falls back to the legacy centre crop for
 *   its whole duration, which is blind centring by any reading - but it has no
 *   shots and no per-shot faces to bucket, so it cannot be split three ways.
 *   Those clips are counted and reported on their own line rather than dropped
 *   in silence (the throwaway version of this script simply `continue`d, which
 *   would have hidden a whole-clip regression behind a healthy-looking split).
 * - The detector is re-run here, not replayed from what the job actually
 *   rendered with. Sampling is deterministic (fps=2, fixed model, fixed
 *   thresholds) so this is reproducible, but it measures TODAY'S engine over
 *   yesterday's clip ranges, not the exact pixels a user received.
 * - It is geometry only. "A face is inside the window" is not "the window is
 *   framed well"; that judgement needs the frame strips, not this number.
 *
 * Read-only: no database writes, no R2 writes, no job touched, and it does not
 * turn REFRAME_MOTION on - `motion: false` is passed explicitly because this
 * change is unrelated to the camera layer and must not smuggle it in.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { getPresignedDownloadUrl, prisma } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { resolveCamRect } from "../reframe/cam-rect";
import { DEFAULT_CAMERA } from "../reframe/camera";
import { loadReframeConfig } from "../reframe/config";
import { detectFaces } from "../reframe/faces";
import { buildCropPlan } from "../reframe/plan";
import { detectShots } from "../reframe/shots";
import type { FaceTrack, ShotTracks } from "../reframe/types";

const execFileAsync = promisify(execFile);

/** The corpus: the real jobs whose clips produced the 1679-second baseline. */
const SINCE = new Date("2026-08-06T00:00:00Z");

/** Same budgets the pipeline gives these two stages, doubled and quadrupled -
 *  some sources here are 1080p60 and a whole clip is sampled in one pass. */
const SHOTS_TIMEOUT_MS = 120_000;
const FACES_TIMEOUT_MS = 180_000;

/** Tracks that clear the planner's per-shot noise floor.
 *
 *  A LOCAL COPY of `survivingTracks` in plan.ts, which is private there and is
 *  not being exported for a measurement script. Both clauses are copied, not
 *  just the easy one: filtering on `samples >= 2` alone would count a stray
 *  low-sample track as "a person is visible here" when the planner had already
 *  discarded it, which inflates buckets 2 and 3 with detections the engine
 *  never considered. The two constants are duplicated for the same reason - a
 *  copy that keeps one and drops the other is worse than no copy at all.
 *
 *  If this drifts from plan.ts the symptom is a bucket-2 entry whose faces all
 *  look like noise, which is exactly what the listing is for. */
const MIN_TRACK_SAMPLES = 2;
const MIN_SAMPLE_FRAC = 0.3;
function survivingTracks(tracks: FaceTrack[]): FaceTrack[] {
  const maxSamples = Math.max(0, ...tracks.map((t) => t.samples));
  return tracks.filter(
    (t) =>
      t.samples >= MIN_TRACK_SAMPLES && t.samples >= MIN_SAMPLE_FRAC * maxSamples
  );
}

interface Remainder {
  job: string;
  clip: string;
  title: string;
  sourceClass: string;
  start: number;
  end: number;
  seconds: number;
  faces: string;
}

async function probe(
  url: string,
  at: number
): Promise<{ width: number; height: number }> {
  // -read_intervals so ffprobe seeks to the clip instead of demuxing the whole
  // remote file from byte zero; on a 2-hour 1080p60 source that is the
  // difference between a second and a minute, times 47 clips.
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      "-read_intervals", `${at}%+1`,
      url,
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

async function main() {
  const cfg = loadReframeConfig();
  const jobs = await prisma.job.findMany({
    where: {
      createdAt: { gte: SINCE },
      // `normalizedArtifactKey` is a nullable STRING, so `not: null` is the
      // right filter here. The Json columns elsewhere in this repo need
      // `Prisma.DbNull` instead; that rule does not reach this one.
      normalizedArtifactKey: { not: null },
    },
    select: {
      id: true,
      originalFilename: true,
      normalizedArtifactKey: true,
      clips: {
        where: { deletedAt: null },
        select: { id: true, title: true, startTime: true, endTime: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  let noFaceSec = 0;
  let underGuardSec = 0;
  let otherCauseSec = 0;
  let deliveredSec = 0;
  let noPlanClips = 0;
  let noPlanSec = 0;
  let failedClips = 0;
  let failedSec = 0;
  // Bucket 1 with nothing detected at all reads differently from bucket 1 where
  // the detector saw something and the noise floor threw it away, so the second
  // case is counted separately rather than folded in.
  let noFaceButSubThresholdSec = 0;
  const remainders: Remainder[] = [];
  const failures: string[] = [];

  for (const [jobIndex, job] of jobs.entries()) {
    if (job.clips.length === 0) continue;
    const url = await getPresignedDownloadUrl(job.normalizedArtifactKey!, 7200);
    const label = (job.originalFilename ?? job.id).slice(0, 46);
    for (const [clipIndex, clip] of job.clips.entries()) {
      const duration = clip.endTime - clip.startTime;
      process.stderr.write(
        `[job ${jobIndex + 1}/${jobs.length} clip ${clipIndex + 1}/${job.clips.length}] ` +
          `${clip.id} ${duration.toFixed(0)}s  ${label}\n`
      );
      try {
        const { width: W, height: H } = await probe(url, clip.startTime);
        const shots = await detectShots(
          url, clip.startTime, clip.endTime, cfg, SHOTS_TIMEOUT_MS
        );
        const tracks: ShotTracks[] = await detectFaces(
          url, clip.startTime, clip.endTime, shots, W, H, cfg, FACES_TIMEOUT_MS
        );
        const cam = resolveCamRect(tracks.map((t) => t.camRect), W, H);
        const plan = buildCropPlan(
          shots,
          tracks,
          W,
          H,
          {
            faceSmallFrac: cfg.faceSmallFrac,
            faceLargeFrac: cfg.faceLargeFrac,
            stream: cfg.stream,
            camShare: cfg.camShare,
            // Explicit, not inherited: this change is unrelated to motion and
            // must not enable it to flatter its own number.
            motion: false,
            camera: DEFAULT_CAMERA,
          },
          cam
        );
        deliveredSec += duration;
        if (!plan) {
          noPlanClips += 1;
          noPlanSec += duration;
          continue;
        }

        const guard = cfg.faceSmallFrac * W;
        const sourceClass = plan.profile?.class ?? "unknown";
        for (const span of plan.shots) {
          if (span.layout !== "center") continue;
          const seconds = span.end - span.start;
          // A merged `center` span can cover several detector shots, so the
          // faces it was centred over are the union of those shots' tracks.
          // Merging only ever joins center to center, so every one of them
          // centred on its own account.
          const raw: FaceTrack[] = [];
          const surviving: FaceTrack[] = [];
          for (const [i, shot] of shots.entries()) {
            if (!(shot.end > span.start && shot.start < span.end)) continue;
            const shotTracks =
              tracks.find((t) => t.shotIndex === i)?.tracks ?? [];
            raw.push(...shotTracks);
            surviving.push(...survivingTracks(shotTracks));
          }
          if (surviving.length === 0) {
            noFaceSec += seconds;
            if (raw.length > 0) noFaceButSubThresholdSec += seconds;
            continue;
          }
          if (surviving.some((t) => t.box.w >= guard)) {
            otherCauseSec += seconds;
            continue;
          }
          underGuardSec += seconds;
          remainders.push({
            job: job.id,
            clip: clip.id,
            title: (clip.title || label).slice(0, 40),
            sourceClass,
            start: span.start,
            end: span.end,
            seconds,
            faces: surviving
              .map(
                (t) =>
                  `${((100 * t.box.w) / W).toFixed(1)}%/${t.samples}smp/${t.score.toFixed(2)}`
              )
              .join(" "),
          });
        }
      } catch (error) {
        failedClips += 1;
        failedSec += duration;
        failures.push(
          `${clip.id} (${duration.toFixed(0)}s, ${label}): ${(error as Error).message.slice(0, 80)}`
        );
        process.stderr.write(`  ! ${(error as Error).message.slice(0, 100)}\n`);
      }
    }
  }

  const centreSec = noFaceSec + underGuardSec + otherCauseSec;
  const share = (n: number) =>
    centreSec > 0 ? `${((100 * n) / centreSec).toFixed(1)}%` : "-";
  const clipCount = jobs.reduce((n, j) => n + j.clips.length, 0);

  console.log(`corpus                          : ${jobs.length} jobs, ${clipCount} clips since ${SINCE.toISOString().slice(0, 10)}`);
  console.log(`delivered clip time measured    : ${deliveredSec.toFixed(0)}s`);
  console.log(`on a blind centre crop          : ${centreSec.toFixed(0)}s`);
  console.log("");
  console.log("1. the three buckets, as a share of centre-crop time");
  console.log(`   no face detected at all      : ${noFaceSec.toFixed(0)}s (${share(noFaceSec)})  centring is CORRECT`);
  console.log(`   people present, all under 6% : ${underGuardSec.toFixed(0)}s (${share(underGuardSec)})  THE DEFECT - was 298s`);
  console.log(`   some face at or above 6%     : ${otherCauseSec.toFixed(0)}s (${share(otherCauseSec)})  another cause, not this change`);
  console.log("");
  console.log("2. the acceptance number");
  console.log(
    `   defect / delivered time      : ${
      deliveredSec > 0 ? ((100 * underGuardSec) / deliveredSec).toFixed(1) : "-"
    }%  (was 17.7%)`
  );
  console.log("");
  console.log(`3. every remaining defective span, one per line (${remainders.length})`);
  if (remainders.length === 0) console.log("   none");
  for (const r of remainders) {
    console.log(
      `   ${`${r.start.toFixed(1)}-${r.end.toFixed(1)}s`.padEnd(16)}` +
        `${`${r.seconds.toFixed(1)}s`.padEnd(8)}` +
        `${r.sourceClass.padEnd(13)}` +
        `${r.faces.padEnd(38)}` +
        `${r.clip} ${r.title}`
    );
  }
  console.log("");
  console.log("4. what this split could not see");
  console.log(`   clips with no plan at all    : ${noPlanClips} (${noPlanSec.toFixed(0)}s)  legacy centre crop for the WHOLE clip`);
  console.log(`   centre time with sub-floor faces: ${noFaceButSubThresholdSec.toFixed(0)}s  counted in bucket 1; the detector saw something the noise floor dropped`);
  console.log(`   clips that failed to measure : ${failedClips} (${failedSec.toFixed(0)}s, excluded from every figure above)`);
  for (const f of failures) console.log(`     ! ${f}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
