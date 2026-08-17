/**
 * How much anchored time sits on a face that never moves.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-insert-anchor.ts"
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION
 * ---------------------------------------------------------------------------
 *
 * Spec `2026-08-06-window-placement-design.md` §3.1 and engine-notes §7f both
 * state the same limitation in the same words: **"the largest face" is not
 * "the speaker"**. Clip `cmshgsrvr00091445kr748jsv` is the concrete form of it.
 * At 2769s the source shows a host talking on the left and, on the right, a
 * rounded-corner graphic insert containing a STILL PHOTOGRAPH of a face. The
 * plan's first span is `0.00-7.67 single x=1164` and the insert sits at roughly
 * source x 1170..1800, so the engine anchored on the photograph and framed a
 * motionless card for the opening 7.7 seconds - the part viewers already named
 * as the weak point.
 *
 * The owner says he has seen it elsewhere. This script exists to find out how
 * much of the corpus it costs, or to establish that it does not.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED, AND WHY IT IS NOT A DETECTOR
 * ---------------------------------------------------------------------------
 *
 * Two quantities that a photograph and a live person differ on:
 *
 * 1. BOX STILLNESS. `FaceTrack.path` is the per-sample boxes the detector was
 *    already computing (§7d). The maximum displacement of the box centre from
 *    its median, in source pixels and as a fraction of box width. A photograph
 *    inside a card does not move at all; a live head does. A track with fewer
 *    than 3 samples is reported SEPARATELY and never scored - two samples
 *    cannot evidence stillness, they can only fail to contradict it.
 *
 * 2. `FaceTrack.mouthActivity`. §7b established that this is NOT a speech
 *    signal - it is a 2fps mean absolute difference of a normalised mouth
 *    patch that a head turn, laughter or detector jitter produces as readily as
 *    speech, and it has never been validated as speech anywhere in this
 *    repository. It is used here for the only thing it honestly measures:
 *    whether the pixels change at all. A still image scores ~0. Nothing in this
 *    script reads it as "who is talking".
 *
 * **No threshold is applied and no total is reported behind one.** A cut-off
 * chosen here would decide the answer, which is the failure this project has
 * paid for repeatedly (§7d's four aggregates, `MIN_RESTORED_SEC`). The full
 * DISTRIBUTION of both quantities is printed so a reader can see whether
 * "still" is a distinct population or the tail of one continuum, the spans are
 * RANKED, and the top 8 are rendered as pictures. The frames decide which end
 * of the ranking is real.
 *
 * ---------------------------------------------------------------------------
 * SPANS, NOT SHOTS, FOR THE RANKING
 * ---------------------------------------------------------------------------
 *
 * The distribution is over anchored TRACKS of every detector shot that has an
 * anchor group. The ranking and the totals are over the plan's merged `single`
 * SPANS, because a span is what the viewer sees: `mergeAdjacentLayouts` keeps
 * the FIRST shot's geometry, so one shot's anchor governs the whole span. The
 * geometry-owning shot is therefore the shot the span is scored by, and the
 * whole span's duration is what a wrong anchor there costs.
 *
 * Corpus, presigning, detection calls and the `survivingTracks` copy are taken
 * from `eval-shift-sheets.ts` unchanged, so this measures the same clips the
 * bisection and shift work measured.
 *
 * `drawtext` has no font in this image and fails the whole graph, so every
 * label is on stdout and the pictures carry only a red rectangle.
 *
 * Read-only: no database writes, no R2 writes, no job touched.
 */
import { execFile } from "child_process";
import { mkdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { getPresignedDownloadUrl, prisma } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { resolveCamRect } from "../reframe/cam-rect";
import { DEFAULT_CAMERA } from "../reframe/camera";
import { loadReframeConfig } from "../reframe/config";
import { detectFaces } from "../reframe/faces";
import {
  buildCropPlan,
  cropWidthFor,
  selectGroupForShot,
  type AnchorPolicy,
} from "../reframe/plan";
import { detectShots } from "../reframe/shots";
import type { FaceTrack, ShotTracks, SourceClass } from "../reframe/types";
import { corpusDir, loadManifest } from "./corpus-fetch";

const execFileAsync = promisify(execFile);

/** Same corpus as `eval-shift-sheets.ts` and `eval-bisection.ts`: the real jobs
 *  every other reframe measurement of this week was taken on. */
const SINCE = new Date("2026-08-06T00:00:00Z");

/** How many spans get pictures. Eight because a reader will look at eight, and
 *  because a false positive at the top of the ranking is the single most useful
 *  thing this script can report - it needs enough frames to show one. */
const TOP_N = 8;

/** A track with fewer samples than this is not scored for stillness at all.
 *  Two samples give one displacement from a median that is their own midpoint;
 *  that number is not evidence of anything. Counted and printed separately. */
const MIN_STILLNESS_SAMPLES = 3;

/** See `eval-shift-sheets.ts`: used only when a plan carries no profile, and
 *  counted so a reader can see whether it ever happened. Unlike that script
 *  this one DOES produce numbers, so the count is printed loudly and any
 *  non-zero value invalidates the affected clips rather than merely warning. */
const DEFAULT_CLASS: SourceClass = "normal_face";

/** Output width of the rendered frames. The FULL source frame is kept - a
 *  cropped frame cannot show that the anchor was a card sitting beside a live
 *  speaker, which is the entire question. */
const OUT_W = 960;

/** Red rectangle thickness in SOURCE pixels, drawn before the downscale. */
const BOX_T = 8;

const SHOTS_TIMEOUT_MS = 120_000;
const FACES_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = 300_000;

/** A LOCAL COPY of `survivingTracks` from plan.ts, which is private there.
 *  `eval-shift-sheets.ts` and `eval-bisection.ts` carry the same copy for the
 *  same reason, and both clauses are copied: keeping only `samples >= 2` would
 *  hand `selectGroupForShot` tracks the planner had already discarded, and the
 *  groups scored here would then be groups the engine never anchored on. */
const MIN_TRACK_SAMPLES = 2;
const MIN_SAMPLE_FRAC = 0.3;
function survivingTracks(tracks: FaceTrack[]): FaceTrack[] {
  const maxSamples = Math.max(0, ...tracks.map((t) => t.samples));
  return tracks.filter(
    (t) =>
      t.samples >= MIN_TRACK_SAMPLES && t.samples >= MIN_SAMPLE_FRAC * maxSamples
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank quantile over an already-sorted array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

function printDistribution(label: string, values: number[], digits: number) {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(`\n  ${label}  (n = ${sorted.length})`);
  if (sorted.length === 0) {
    console.log("    (empty)");
    return;
  }
  const fmt = (v: number) => v.toFixed(digits).padStart(9);
  console.log(`    min ${fmt(sorted[0])}   max ${fmt(sorted[sorted.length - 1])}`);
  const deciles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  console.log(
    "    " + deciles.map((d) => `p${(d * 100).toFixed(0)}`.padStart(9)).join("")
  );
  console.log("    " + deciles.map((d) => fmt(quantile(sorted, d))).join(""));
}

/**
 * Box stillness for one track, or null when the track cannot be scored.
 *
 * `path` is absent from older sidecar builds, which the type marks optional, so
 * "no path" and "too few samples" are two different unscorable states and are
 * counted apart.
 */
interface Stillness {
  /** Max Euclidean displacement of the box centre from the median centre, px. */
  maxDisp: number;
  /** The same, divided by the track's median box width. */
  frac: number;
  samples: number;
}
function stillnessOf(track: FaceTrack): Stillness | null {
  const path = track.path;
  if (!path || path.length < MIN_STILLNESS_SAMPLES) return null;
  const cx = path.map((p) => p.x + p.w / 2);
  const cy = path.map((p) => p.y + p.h / 2);
  const mx = median(cx);
  const my = median(cy);
  let maxDisp = 0;
  for (let i = 0; i < path.length; i += 1) {
    maxDisp = Math.max(maxDisp, Math.hypot(cx[i] - mx, cy[i] - my));
  }
  return {
    maxDisp,
    frac: track.box.w > 0 ? maxDisp / track.box.w : NaN,
    samples: path.length,
  };
}

interface SpanCase {
  clipId: string;
  title: string;
  artifactKey: string;
  clipStart: number;
  /** Clip-relative, as the plan reports them. */
  spanStart: number;
  spanEnd: number;
  atClipStart: boolean;
  seconds: number;
  /** The detector shot whose geometry the merged span carries. */
  shotIndex: number;
  shotStart: number;
  shotEnd: number;
  /** Absolute source time of the frame to render, and why that instant. */
  frameAt: number;
  frameWhy: string;
  sourceWidth: number;
  sourceHeight: number;
  cropW: number;
  x: number;
  groupSize: number;
  /** Surviving tracks in this shot that are NOT in the anchor group. */
  others: number;
  /** Widest group member, source px - what the window was pointed at. */
  boxW: number;
  /** Max over group members. A group whose LIVELIEST member barely moves is a
   *  still group; a group holding one photograph and one talking head is not,
   *  and must not rank above it. */
  maxDisp: number;
  maxDispFrac: number;
  /** Max over group members, same argument. */
  mouthActivity: number;
  minSamples: number;
  diag: string[];
}

/** Source dimensions, seeking to the clip rather than demuxing from byte 0. */
async function probe(
  url: string,
  at: number
): Promise<{ width: number; height: number }> {
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

/**
 * One FULL source frame with the crop window drawn on it in red.
 *
 * The box is drawn at source resolution and the whole thing is then scaled to
 * `OUT_W`, so the rectangle lands exactly on the pixels the window would have
 * taken. `-2` on the height keeps the aspect and an even dimension.
 */
async function renderFrame(
  c: SpanCase,
  url: string,
  outPng: string
): Promise<void> {
  const graph =
    `drawbox=x=${c.x}:y=0:w=${c.cropW}:h=ih:color=red@1.0:t=${BOX_T},` +
    `scale=${OUT_W}:-2`;
  await execFileAsync(
    "ffmpeg",
    [
      "-nostdin", "-v", "error",
      "-ss", c.frameAt.toFixed(3),
      "-i", url,
      "-vf", graph,
      "-frames:v", "1",
      outPng, "-y",
    ],
    { timeout: RENDER_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
}

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const outDir = join(corpusDir(manifest), "insert-anchor");
  await mkdir(outDir, { recursive: true });

  const jobs = await prisma.job.findMany({
    where: {
      createdAt: { gte: SINCE },
      // A nullable STRING column, so `not: null` is right here.
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

  const cases: SpanCase[] = [];
  /** Every anchored track of every shot with a group - the distribution set. */
  const dispPx: number[] = [];
  const dispFrac: number[] = [];
  const mouth: number[] = [];
  /** Same, restricted to the tracks that could be scored for stillness, so the
   *  two distributions are read over the same population. */
  let tracksNoPath = 0;
  let tracksTooFewSamples = 0;
  let tracksScored = 0;

  let clipsPlanned = 0;
  let noPlanClips = 0;
  let failedClips = 0;
  let defaultedProfiles = 0;
  let shotsExamined = 0;
  let shotsWithGroup = 0;
  let singleSpans = 0;
  let spansNoOwner = 0;
  let totalAnchoredSec = 0;
  let openingAnchoredSec = 0;
  let unscorableSec = 0;
  /** Listed individually rather than counted. A span whose anchor cannot be
   *  scored is not a span that is fine - it is a span this instrument is blind
   *  to, and a reader looking for a particular clip must be able to find it
   *  here when it is not in the ranking. */
  const unscorable: string[] = [];
  const failures: string[] = [];

  for (const [jobIndex, job] of jobs.entries()) {
    if (job.clips.length === 0) continue;
    const artifactKey = job.normalizedArtifactKey!;
    const url = await getPresignedDownloadUrl(artifactKey, 7200);
    const label = (job.originalFilename ?? job.id).slice(0, 46);
    for (const [clipIndex, clip] of job.clips.entries()) {
      process.stderr.write(
        `[job ${jobIndex + 1}/${jobs.length} clip ${clipIndex + 1}/${job.clips.length}] ` +
          `${clip.id} ${(clip.endTime - clip.startTime).toFixed(0)}s  ${label}\n`
      );
      try {
        const { width: W, height: H } = await probe(url, clip.startTime);
        const cropW = cropWidthFor(H);
        const { shots } = await detectShots(
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
            // Explicit, not inherited: the camera layer is a different change
            // and it ships off.
            motion: false,
            camera: DEFAULT_CAMERA,
          },
          cam
        );
        if (!plan) {
          noPlanClips += 1;
          continue;
        }
        clipsPlanned += 1;
        if (!plan.profile) defaultedProfiles += 1;

        const policy: AnchorPolicy = {
          minFaceWidth: cfg.faceSmallFrac * W,
          sourceClass: plan.profile?.class ?? DEFAULT_CLASS,
          camRect: cam?.rect ?? null,
        };

        // --- The distribution set: every anchored track of every shot.
        const groups = new Map<number, FaceTrack[]>();
        const survivors = new Map<number, FaceTrack[]>();
        for (const [i] of shots.entries()) {
          shotsExamined += 1;
          const surviving = survivingTracks(
            tracks.find((t) => t.shotIndex === i)?.tracks ?? []
          );
          survivors.set(i, surviving);
          const group = selectGroupForShot(surviving, policy, cropW, W);
          if (!group) continue;
          shotsWithGroup += 1;
          groups.set(i, group);
          for (const t of group) {
            const s = stillnessOf(t);
            if (!t.path) {
              tracksNoPath += 1;
              continue;
            }
            if (!s) {
              tracksTooFewSamples += 1;
              continue;
            }
            tracksScored += 1;
            dispPx.push(s.maxDisp);
            dispFrac.push(s.frac);
            mouth.push(t.mouthActivity);
          }
        }

        // --- The ranking set: merged `single` spans, scored by the detector
        // shot whose geometry the span carries (the first one it covers).
        for (const span of plan.shots) {
          if (span.layout !== "single") continue;
          singleSpans += 1;
          const seconds = span.end - span.start;
          totalAnchoredSec += seconds;
          const atClipStart = span.start <= 1e-6;
          if (atClipStart) openingAnchoredSec += seconds;

          const ownerIndex = shots.findIndex((s) => s.end > span.start + 1e-6);
          const group = ownerIndex >= 0 ? groups.get(ownerIndex) : undefined;
          if (ownerIndex < 0 || !group) {
            // A `single` span whose owning shot has no group should not exist -
            // the branch that emits `single` runs off the group. Counted rather
            // than dropped in silence.
            spansNoOwner += 1;
            continue;
          }
          const shot = shots[ownerIndex];
          const scored = group.map((t) => ({ t, s: stillnessOf(t) }));
          if (scored.some((g) => g.s === null)) {
            // At least one anchored track cannot evidence stillness, so the
            // group cannot be scored. Never guessed at, never ranked.
            unscorableSec += seconds;
            unscorable.push(
              `${(span.start.toFixed(2) + "-" + span.end.toFixed(2) + "s").padStart(16)} ` +
                `${atClipStart ? " OPEN" : "     "} ${seconds.toFixed(1).padStart(6)}s  ` +
                `${clip.id} ${(clip.title ?? "").slice(0, 40)}\n` +
                group
                  .map((t) => `        ${trackLine("ANCHOR", t)}`)
                  .join("\n")
            );
            continue;
          }
          const maxDisp = Math.max(...scored.map((g) => g.s!.maxDisp));
          const maxDispFrac = Math.max(...scored.map((g) => g.s!.frac));
          const surviving = survivors.get(ownerIndex) ?? [];
          // WHEN to take the picture, and this is not a detail. The first
          // version of this script took the owning shot's midpoint and rank 1
          // came back as an empty street: a 54-second single-shot clip whose
          // anchor track was detected only between 34.5s and 38.5s, so the
          // midpoint fell 8 seconds before the anchored face existed and the
          // frame showed a red rectangle over a building. §7f records
          // `eval-shift-sheets.ts` making exactly this mistake and having to be
          // fixed before its pictures could be believed.
          //
          // So the instant is the MEDIAN SAMPLE TIME of the widest anchor
          // track - a moment the anchor was demonstrably on screen. It is
          // inside the owning shot by construction, and clamped into the span
          // for the merged case.
          const widest = group.reduce((a, b) => (b.box.w > a.box.w ? b : a));
          const times = widest.path!.map((p) => p.t);
          const anchorT = median(times);
          const frameT = Math.max(span.start, Math.min(span.end, anchorT));
          const frameAt = clip.startTime + frameT;
          cases.push({
            clipId: clip.id,
            title: clip.title ?? "(untitled)",
            artifactKey,
            clipStart: clip.startTime,
            spanStart: span.start,
            spanEnd: span.end,
            atClipStart,
            seconds,
            shotIndex: ownerIndex,
            shotStart: shot.start,
            shotEnd: shot.end,
            frameAt,
            frameWhy:
              `median sample of anchor id${widest.id} (t=${anchorT.toFixed(2)}s, ` +
              `shot ${shot.start.toFixed(1)}-${shot.end.toFixed(1)}s)`,
            sourceWidth: W,
            sourceHeight: H,
            cropW,
            x: span.x,
            groupSize: group.length,
            others: surviving.length - group.length,
            boxW: Math.max(...group.map((t) => t.box.w)),
            maxDisp,
            maxDispFrac,
            mouthActivity: Math.max(...group.map((t) => t.mouthActivity)),
            minSamples: Math.min(...scored.map((g) => g.s!.samples)),
            diag: [
              ...group.map((t) => trackLine("ANCHOR", t)),
              ...surviving
                .filter((t) => !group.includes(t))
                .map((t) => trackLine("other", t)),
            ],
          });
        }
      } catch (error) {
        failedClips += 1;
        failures.push(`${clip.id} ${(error as Error).message.slice(0, 120)}`);
      }
    }
  }

  // Stillest first. Ties by the fraction, then by clip, so the order is stable.
  cases.sort(
    (a, b) =>
      a.maxDisp - b.maxDisp ||
      a.maxDispFrac - b.maxDispFrac ||
      a.clipId.localeCompare(b.clipId)
  );

  console.log("\n=== corpus");
  console.log(`  jobs                 : ${jobs.length}`);
  console.log(`  clips planned        : ${clipsPlanned}  (no plan ${noPlanClips}, failed ${failedClips})`);
  console.log(`  detector shots       : ${shotsExamined}  (with an anchor group ${shotsWithGroup})`);
  console.log(`  profile defaulted    : ${defaultedProfiles} clips  ${defaultedProfiles === 0 ? "(never - every group is the planner's)" : "!! these clips' numbers are not the engine's"}`);
  console.log(`  single spans         : ${singleSpans}  (scored ${cases.length}, unscorable ${unscorable.length}, no owning group ${spansNoOwner})`);

  console.log("\n=== anchored time");
  console.log(`  total anchored       : ${totalAnchoredSec.toFixed(1)}s over ${singleSpans} single spans`);
  console.log(`  begins at clip start : ${openingAnchoredSec.toFixed(1)}s  (${totalAnchoredSec > 0 ? ((100 * openingAnchoredSec) / totalAnchoredSec).toFixed(1) : "0.0"}% of anchored time)`);
  console.log(`  not scorable         : ${unscorableSec.toFixed(1)}s in ${unscorable.length} spans - an anchored track with < ${MIN_STILLNESS_SAMPLES} path samples`);

  console.log("\n=== anchored TRACKS: can they be scored at all");
  console.log(`  scored               : ${tracksScored}`);
  console.log(`  no path (old sidecar): ${tracksNoPath}`);
  console.log(`  < ${MIN_STILLNESS_SAMPLES} samples          : ${tracksTooFewSamples}`);

  console.log("\n=== distributions over every scored anchored track");
  printDistribution("max centre displacement from median, SOURCE px", dispPx, 2);
  printDistribution("the same as a fraction of box width", dispFrac, 4);
  printDistribution("mouthActivity (NOT speech - see §7b; pixels changing at all)", mouth, 5);
  console.log(
    "\n  Read these before reading anything below. If the low end is continuous\n" +
      "  with the rest, stillness does not separate a population and this defect\n" +
      "  cannot be found by stillness alone - which is a result, not a failure."
  );

  // The whole ranking, not the top 20 alone. A reader arriving with a
  // particular clip in hand - the owner's reported one, say - must be able to
  // find where it landed, and "it is not in the top 20" is not an answer.
  // Printing all of them costs nothing and is the only way a MISS is visible.
  const HEADER =
    "  rank  disp_px  disp/w   mouth   boxW  span              open   secs  faces  clip";
  const row = (rank: number, c: SpanCase) =>
    `  ${String(rank + 1).padStart(4)} ` +
        `${c.maxDisp.toFixed(2).padStart(8)} ` +
        `${c.maxDispFrac.toFixed(3).padStart(7)} ` +
        `${c.mouthActivity.toFixed(4).padStart(7)} ` +
        `${c.boxW.toFixed(0).padStart(6)} ` +
        `${(c.spanStart.toFixed(2) + "-" + c.spanEnd.toFixed(2) + "s").padStart(16)} ` +
        `${c.atClipStart ? " OPEN" : "     "} ` +
        `${c.seconds.toFixed(1).padStart(6)} ` +
        `${String(c.others).padStart(6)} ` +
        `  ${c.clipId} ${c.title.slice(0, 40)}`;

  console.log(`\n=== anchored spans, STILLEST FIRST - top 20 of ${cases.length}`);
  console.log(HEADER);
  for (const [rank, c] of cases.slice(0, 20).entries()) console.log(row(rank, c));

  console.log(`\n=== the same ranking in full, all ${cases.length} scored spans`);
  console.log(HEADER);
  for (const [rank, c] of cases.entries()) console.log(row(rank, c));

  console.log(
    `\n=== spans this instrument CANNOT score (${unscorable.length}, ${unscorableSec.toFixed(1)}s)` +
      `\n    An anchored track with fewer than ${MIN_STILLNESS_SAMPLES} path samples. Not "fine" - unmeasured.`
  );
  for (const u of unscorable) console.log(`  ${u}`);

  console.log(`\n=== rendering the top ${TOP_N} (full source frame, red = the crop window)`);
  for (const [rank, c] of cases.slice(0, TOP_N).entries()) {
    const name = `${String(rank + 1).padStart(2, "0")}-${c.clipId}-${c.spanStart.toFixed(1)}s.png`;
    const outPng = join(outDir, name);
    console.log(`\n  [${rank + 1}] ${name}`);
    console.log(`      clip     : ${c.clipId}  ${c.title}`);
    console.log(`      span     : ${c.spanStart.toFixed(2)}-${c.spanEnd.toFixed(2)}s (${c.seconds.toFixed(1)}s)${c.atClipStart ? "  STARTS AT CLIP OPENING" : ""}`);
    console.log(`      window   : x=${c.x} w=${c.cropW} of ${c.sourceWidth}x${c.sourceHeight}`);
    console.log(`      frame at : source t=${c.frameAt.toFixed(2)}s - ${c.frameWhy}`);
    console.log(`      anchor   : ${c.groupSize} track(s), widest box ${c.boxW.toFixed(0)}px, ${c.others} other surviving face(s) in the shot`);
    console.log(`      stillness: max disp ${c.maxDisp.toFixed(2)}px = ${(100 * c.maxDispFrac).toFixed(1)}% of box width over >= ${c.minSamples} samples`);
    console.log(`      mouth    : ${c.mouthActivity.toFixed(5)}`);
    for (const line of c.diag) console.log(`      ${line}`);
    try {
      const url = await getPresignedDownloadUrl(c.artifactKey, 7200);
      await renderFrame(c, url, outPng);
      console.log(`      -> ${outPng}`);
    } catch (error) {
      console.log(`      ! FAILED: ${(error as Error).message.slice(0, 200)}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n=== clips that failed (${failures.length})`);
    for (const f of failures) console.log(`  ${f}`);
  }

  console.log(
    "\nNo threshold was applied anywhere above. Whether the still end of this\n" +
      "ranking is a graphic insert or a calm person is decided by looking at the\n" +
      "eight frames, not by the numbers that chose them."
  );

  await prisma.$disconnect();
}

/** One line per track beside a rendered case: where it is, how still it is, and
 *  how much its pixels moved. Printed for the anchor AND for every other
 *  surviving face, because "was there a live speaker the window missed" is
 *  answered by the frame and located by this. */
function trackLine(role: string, t: FaceTrack): string {
  const s = stillnessOf(t);
  const cover = t.path?.length
    ? `t ${t.path[0].t.toFixed(1)}-${t.path[t.path.length - 1].t.toFixed(1)}s`
    : "t (no path)";
  const still = s
    ? `disp ${s.maxDisp.toFixed(2)}px (${(100 * s.frac).toFixed(1)}% of w)`
    : "disp (unscorable)";
  return (
    `${role.padEnd(6)} id${String(t.id).padEnd(3)} ` +
    `x=${t.box.x.toFixed(0)}..${(t.box.x + t.box.w).toFixed(0)} ` +
    `y=${t.box.y.toFixed(0)}..${(t.box.y + t.box.h).toFixed(0)} ` +
    `w=${t.box.w.toFixed(0)}  ${String(t.samples).padStart(3)} samples ${cover}  ` +
    `${still}  mouth ${t.mouthActivity.toFixed(5)}`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
