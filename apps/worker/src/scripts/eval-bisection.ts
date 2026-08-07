/**
 * Acceptance for the window-placement change: how much delivered time has the
 * crop edge cutting a detected face in half?
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-bisection.ts"
 *
 * Every clip of every real job since SINCE is re-planned from its OWN detector
 * run over its own time range, and every `single` span of the resulting plan is
 * asked what its window does to the faces it did not anchor. Measured at 225s of
 * 1250s anchored time before the change, in 13 of 53 clips, worst span 68.4s
 * (spec §1.1).
 *
 * ---------------------------------------------------------------------------
 * THE 15%..85% BAND BELONGS TO THIS METRIC, NOT TO THE RULE
 * ---------------------------------------------------------------------------
 *
 * A face counts as bisected here when strictly between 15% and 85% of its width
 * shows. That band is the REPORT's, and it is not a tuning knob anywhere: the
 * rule itself has no threshold (spec §3), it minimises `bisectionSeverity`,
 * which is continuous and whose zero is a property of the geometry rather than a
 * number somebody chose. The band exists only so that this script can say "this
 * many seconds" instead of printing a distribution of severities that nobody can
 * compare against a previous run. Widening or narrowing it changes what this
 * report says and changes nothing whatsoever about what the engine renders.
 *
 * ---------------------------------------------------------------------------
 * "NEAR ZERO" IS NOT AN ACCEPTANCE CRITERION
 * ---------------------------------------------------------------------------
 *
 * Every surviving bisected span is printed on its own line - clip, time,
 * duration, how crowded the shot is, and the visible fraction and width of each
 * cut face. A remainder that is a detection artefact is a pass; a remainder the
 * rule failed to reach is not; and only the listing tells them apart. A total on
 * its own cannot, so this script never reports one on its own.
 *
 * ---------------------------------------------------------------------------
 * A RESULT BELOW 84s IS NOT A WIN
 * ---------------------------------------------------------------------------
 *
 * The analysis predicted 225s falls to about 84s: two crowded shots, one with
 * seven faces and one with six, where a 608px window cannot spare everyone
 * (spec §2.2). Falling further means the rule did something the analysis did not
 * predict, and that has to be understood before the change is trusted. The
 * verdict line at the bottom says so rather than reporting it as success.
 *
 * It did not fall further. The first full run came in ABOVE, at 177s, and the
 * clause above is kept anyway - it was written before the number was known, it
 * is the reason the two floors below are both printed, and a later run that
 * lands under 84s must face it rather than be congratulated by it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MEASURES, EXACTLY, BECAUSE THE COMPARISON IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * - The unit is a MERGED plan span, not a detector shot, and a span counts once
 *   in full if any overlapping detector shot has a cut face. That is the unit
 *   the 225s baseline was measured in ("longest single span 68.4s"), and a
 *   finer unit would produce a smaller number for a reason that has nothing to
 *   do with whether the rule worked. Attributing only the overlapping shot's own
 *   seconds would be the more honest duration of the visible defect; it would
 *   also not be comparable, so it is not what the headline uses.
 * - A span is listed whenever ANY face is cut under EITHER floor, and each
 *   listed span says which total it belongs to. Listing only the strict spans
 *   would print two lines while claiming 177 seconds remain, which is the one
 *   thing this script exists not to do.
 * - Only faces the span did NOT anchor are counted. The anchor group is
 *   re-derived per detector shot from `selectGroupForShot`, the same function
 *   the planner used, under the same `AnchorPolicy` - never a second copy of
 *   that logic. Anchored faces are counted too, on a diagnostic line of their
 *   own: `placeWindow` searches only positions that keep every group member
 *   whole, so that line must be 0, and if it is not, the rule cut the very face
 *   it was pointed at and the headline would never show it.
 * - Faces wider than the window are excluded from the headline: they can never
 *   be whole, centring on them is correct, and §7c already handles them. The
 *   baseline put that at 25s. Excluded time is reported on its own line, split
 *   into "an oversize face straddles the edge" and "and it is the ONLY reason
 *   this span is not in the headline", because only the second is time the
 *   exclusion is actually hiding.
 *
 *   This script measures 0s of it against the baseline's 25s, and the difference
 *   is a second sign that the baseline counted the anchor group as well: the only
 *   face normally wider than a 608px window is the close-up the window is
 *   pointed AT, and the exclusion here runs after the group has been removed. It
 *   is left as it is - "the window bisects the person it is framing" is §7c's
 *   subject, not this change's - and the anchored-face diagnostic below is what
 *   watches that case instead.
 * - The control section re-scores the same spans at `windowXFor` - where the
 *   window sat BEFORE this change - to check that this script's metric
 *   reproduces the 225s baseline at all. It is approximate in one known way:
 *   merging is decided on `x`, so under the old placement the spans themselves
 *   would have merged differently, and this re-scores the NEW spans at the old
 *   x. If the control lands far from 225s, the headline is not comparable to
 *   the baseline and no verdict below can be trusted.
 * - EVERYTHING IS REPORTED UNDER TWO NOISE FLOORS, and that is the single most
 *   important thing about this script. The first version used one - the
 *   planner's own `survivingTracks`, both clauses - and its control landed at
 *   81s against a 225s baseline. A headline cannot be compared to a baseline it
 *   cannot reproduce, so the second version computed both floors in one pass:
 *
 *     floor                        control (old x)   today's x
 *     LAX     samples >= 2 only          221s            177s
 *     STRICT  survivingTracks             81s             37s
 *
 *   LAX reproduces the baseline (221s in 11 clips against 225s in 13 of 53), so
 *   LAX is the metric the 225 -> 84 prediction was written in, and the verdict
 *   is taken on it. That identification is circumstantial and is worth saying
 *   so: 221 is not 225 and 11 is not 13, the baseline's run is not in the
 *   repository to read, and the control approximates the old merge. It is an
 *   inference from a 4-second gap against a 140-second one, not a proof. Read on STRICT alone the change looks like 81 -> 37, which
 *   is "below the predicted 84s" and a triumph; read on the metric that was
 *   actually predicted it is 221 -> 177, which is well above it. Same run, same
 *   rule, same 44 seconds removed. The floors are not a knob to pick a flattering
 *   one from - they are printed together precisely so that nobody can.
 *
 *   The gap between them is not a measurement curiosity either. `placeWindow`
 *   takes `others` from `survivingTracks`, so a face the noise floor discarded is
 *   a face the rule was never given and can never uncut, however plainly it is a
 *   person on screen. That is why LAX-only spans are marked `~` in the listing:
 *   they are not failures of the rule, they are outside its input.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT SEE
 * ---------------------------------------------------------------------------
 *
 * - The detector is re-run here, not replayed from what the job actually
 *   rendered with. Sampling is deterministic (fps=2, fixed model, fixed
 *   thresholds), so this is reproducible, but it measures TODAY'S engine over
 *   yesterday's clip ranges, not the exact pixels a user received.
 * - It is geometry only. "No face straddles the edge" is not "the window is
 *   framed well" - the silent regression this change risks, a subject shoved to
 *   the edge to spare a bystander, is invisible here by construction and is
 *   Task 4's frame strips to judge (spec §5.1).
 * - `center`, `split` and `stream` spans are not examined. Only `single` spans
 *   have a window this change can move.
 *
 * Read-only: no database writes, no R2 writes, no job touched, and it does not
 * turn REFRAME_MOTION on - `motion: false` is passed explicitly so that the
 * camera layer cannot smuggle itself into this change's acceptance number.
 */
import { execFile } from "child_process";
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
  faceVisibility,
  selectGroupForShot,
  windowXFor,
  type AnchorPolicy,
} from "../reframe/plan";
import { detectShots } from "../reframe/shots";
import type { FaceTrack, ShotTracks } from "../reframe/types";

const execFileAsync = promisify(execFile);

/** The corpus: the real jobs whose clips produced the 225-second baseline. */
const SINCE = new Date("2026-08-06T00:00:00Z");

/** The reporting band. See the header: it is this script's, not the rule's. */
const LOW = 0.15;
const HIGH = 0.85;

/** Spec §1.1 and §2.2, so the report can print what it is being compared to. */
const BASELINE_ANCHORED = 1250;
const BASELINE_TOTAL = 225;
const BASELINE_CLIPS = "13 of 53";
const BASELINE_WORST = 68.4;
const BASELINE_OVERSIZE = 25;
const BASELINE_IRREDUCIBLE = 84;

/** Same budgets the pipeline gives these two stages, doubled and quadrupled -
 *  some sources here are 1080p60 and a whole clip is sampled in one pass. */
const SHOTS_TIMEOUT_MS = 120_000;
const FACES_TIMEOUT_MS = 180_000;

/** Tracks that clear the planner's per-shot noise floor.
 *
 *  A LOCAL COPY of `survivingTracks` in plan.ts, which is private there and is
 *  not being exported for a measurement script. Both clauses are copied, not
 *  just the easy one: filtering on `samples >= 2` alone would count a stray
 *  low-sample track as a person the window cut in half when the planner had
 *  already discarded it, which inflates the headline with detections the engine
 *  never considered. The two constants are duplicated for the same reason - a
 *  copy that keeps one and drops the other is worse than no copy at all.
 *
 *  If this drifts from plan.ts the symptom is a listed span whose cut faces all
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

interface CutSpan {
  clip: string;
  title: string;
  start: number;
  end: number;
  seconds: number;
  /** The most surviving faces any ONE detector shot under this span has - "how
   *  crowded is this shot", which is what separates §2.2's two scenes (7 faces
   *  and 6) from the rest. A MAXIMUM and not a sum: a merged span covering
   *  three two-face shots is not a six-face scene, and summing would make it
   *  look like one in exactly the listing that has to tell them apart. */
  crowd: number;
  /** The same maximum under the LAX floor. Spec §2.2 names its two crowded
   *  scenes by face count, and those counts are LAX counts. */
  crowdLax: number;
  /** Detector shots merged into this span, so a large `crowd` can be read
   *  against how much merging happened. */
  shots: number;
  /** True when at least one cut face clears the planner's own noise floor, so
   *  the span is in the STRICT total and not only in the LAX one. */
  strict: boolean;
  /** True when EVERY cut face in this span belongs to a shot other than the one
   *  whose geometry the merge kept.
   *
   *  This is the one way a span can be bisected that the rule cannot reach.
   *  `placeWindow` runs per detector shot and minimises the worst cut among
   *  that shot's outsiders; `mergeAdjacentLayouts` then throws away every x but
   *  the first when neighbouring shots agree within 4% of frame width. So a face
   *  that only exists in the second shot of a merged pair was never in any
   *  objective the rule optimised. A span flagged here is not "the rule failed",
   *  it is "the rule was never asked", and the two need different fixes. */
  mergeBlind: boolean;
  faces: string;
}

async function probe(
  url: string,
  at: number
): Promise<{ width: number; height: number }> {
  // -read_intervals so ffprobe seeks to the clip instead of demuxing the whole
  // remote file from byte zero; on a 2-hour 1080p60 source that is the
  // difference between a second and a minute, times 53 clips.
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

/** Bisected by a window at `x`, in this report's sense only. */
function isCut(track: FaceTrack, x: number, cropW: number): boolean {
  const visible = faceVisibility(track, x, cropW);
  return visible > LOW && visible < HIGH;
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

  let clipsPlanned = 0;
  let noPlanClips = 0;
  let anchoredSec = 0;
  let bisectedSec = 0;
  let anchorCutSec = 0;
  let oversizeBandSec = 0;
  let oversizeOnlySec = 0;
  let controlBisectedSec = 0;
  let laxBisectedSec = 0;
  let laxControlSec = 0;
  let worstSpan = 0;
  let worstLaxSpan = 0;
  const spans: CutSpan[] = [];
  const clipsHit = new Set<string>();
  const controlClipsHit = new Set<string>();
  const laxClipsHit = new Set<string>();
  const laxControlClipsHit = new Set<string>();
  const failures: string[] = [];
  let failedClips = 0;

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
        const cropW = cropWidthFor(H);
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
        if (!plan) {
          // A null plan renders as the legacy centre crop for the whole clip.
          // It has no `single` span, so it cannot contribute to this metric at
          // all - counted rather than skipped in silence.
          noPlanClips += 1;
          continue;
        }
        if (!plan.profile) throw new Error("plan_has_no_profile");
        clipsPlanned += 1;

        // The rule the planner applied to THIS clip, rebuilt from the plan's
        // own profile so that the anchor group re-derived below is the group
        // the planner actually chose - `canAnchor` reads the source class, and
        // guessing it here would silently change who counts as an outsider.
        const policy: AnchorPolicy = {
          minFaceWidth: cfg.faceSmallFrac * W,
          sourceClass: plan.profile.class,
          camRect: cam?.rect ?? null,
        };

        for (const span of plan.shots) {
          if (span.layout !== "single") continue;
          const seconds = span.end - span.start;
          anchoredSec += seconds;

          // A merged `single` span can cover several detector shots, each with
          // its own faces and its own anchor group, all rendered at the FIRST
          // shot's x - merging keeps that one. So every overlapping shot is
          // scored against this span's x, which is what the viewer sees.
          let crowd = 0;
          let crowdLax = 0;
          let shotCount = 0;
          let cutAnchored = false;
          let cutOversize = false;
          let strictCut = false;
          let strictControlCut = false;
          let laxCut = false;
          let laxControlCut = false;
          let cutInFirstShot = false;
          const cutFaces: string[] = [];
          // The old placement, for the control: the window `windowXFor` would
          // have produced for the group of the FIRST overlapping shot, which is
          // the group whose geometry merging kept.
          let controlX: number | null = null;

          for (const [i, shot] of shots.entries()) {
            if (!(shot.end > span.start && shot.start < span.end)) continue;
            const shotTracks = tracks.find((t) => t.shotIndex === i)?.tracks ?? [];
            const surviving = survivingTracks(shotTracks);
            shotCount += 1;
            if (surviving.length > crowd) crowd = surviving.length;
            // The crowd under the LAX floor as well: §2.2 identifies its two
            // scenes by "7 faces" and "6 faces", and the strict count alone
            // reports one of them as a two-face shot, which makes the listing
            // unable to confirm the very spans it exists to confirm.
            const laxCount = shotTracks.filter(
              (t) => t.samples >= MIN_TRACK_SAMPLES
            ).length;
            if (laxCount > crowdLax) crowdLax = laxCount;
            const group = selectGroupForShot(shotTracks, policy, cropW, W);
            // Unreachable in principle: merging only ever joins `single` to
            // `single`, and a shot is `single` exactly when its group is
            // non-null. Reported rather than assumed, because if it ever fires,
            // every face in the shot would silently become an "outsider".
            if (!group) {
              failures.push(
                `${clip.id} @${span.start.toFixed(1)}s: single span over a shot with no anchor group`
              );
              continue;
            }
            if (controlX === null) controlX = windowXFor(group, cropW, W);
            // Every track the LAX floor keeps, which is a superset of the strict
            // one. Both floors are walked in a single pass over this list so
            // that a face can never be counted by one and missed by the other
            // for any reason except the floor itself.
            //
            // Identity, not id: `selectGroupForShot` filters these very objects
            // rather than copying them, so `includes` is exact on both sets.
            const lax = shotTracks.filter((t) => t.samples >= MIN_TRACK_SAMPLES);
            for (const track of lax) {
              if (group.includes(track)) continue;
              const inStrict = surviving.includes(track);
              if (track.box.w > cropW) {
                // Wider than the window: it can never be whole and §7c already
                // owns it. Kept out of both totals, counted on its own line.
                if (isCut(track, span.x, cropW)) cutOversize = true;
                continue;
              }
              if (controlX !== null && isCut(track, controlX, cropW)) {
                laxControlCut = true;
                if (inStrict) strictControlCut = true;
              }
              if (!isCut(track, span.x, cropW)) continue;
              laxCut = true;
              if (inStrict) strictCut = true;
              // ANY cut face in the first shot, strict or not. Scoping this to
              // strict faces made every lax-only span report MERGE-BLIND while
              // printing an `s0` face beside it, which is a contradiction on one
              // line and a wrong judgement of the span.
              if (shotCount === 1) cutInFirstShot = true;
              cutFaces.push(
                `${inStrict ? "" : "~"}s${shotCount - 1}:` +
                  `${(100 * faceVisibility(track, span.x, cropW)).toFixed(0)}%vis/` +
                  `${((100 * track.box.w) / W).toFixed(1)}%w/` +
                  // Samples over the detector's sample rate is how long this
                  // face was actually on screen. A span is charged in FULL to a
                  // face cut anywhere inside it, so this is the column that says
                  // whether a 68-second span is 68 seconds of a bisected person
                  // or 5 seconds of one inside a 68-second window.
                  `${(track.samples / cfg.sampleFps).toFixed(1)}s-seen`
              );
            }
            // The face the window was POINTED at, cut by its own window. The
            // search range in `placeWindow` makes this impossible; measured
            // anyway, because if it happens neither total can show it.
            for (const track of group) {
              if (track.box.w > cropW) continue;
              if (isCut(track, span.x, cropW)) cutAnchored = true;
            }
          }

          if (cutAnchored) anchorCutSec += seconds;
          if (cutOversize) oversizeBandSec += seconds;
          if (cutOversize && cutFaces.length === 0) oversizeOnlySec += seconds;
          if (strictControlCut) {
            controlBisectedSec += seconds;
            controlClipsHit.add(clip.id);
          }
          if (laxControlCut) {
            laxControlSec += seconds;
            laxControlClipsHit.add(clip.id);
          }
          if (laxCut) {
            laxBisectedSec += seconds;
            laxClipsHit.add(clip.id);
            if (seconds > worstLaxSpan) worstLaxSpan = seconds;
          }
          if (strictCut) {
            bisectedSec += seconds;
            clipsHit.add(clip.id);
            if (seconds > worstSpan) worstSpan = seconds;
          }
          if (cutFaces.length === 0) continue;

          spans.push({
            clip: clip.id,
            title: (clip.title || label).slice(0, 38),
            start: span.start,
            end: span.end,
            seconds,
            crowd,
            crowdLax,
            shots: shotCount,
            strict: strictCut,
            mergeBlind: !cutInFirstShot,
            faces: cutFaces.join(" "),
          });
        }
      } catch (error) {
        failedClips += 1;
        failures.push(
          `${clip.id} (${duration.toFixed(0)}s, ${label}): ${(error as Error).message.slice(0, 80)}`
        );
        process.stderr.write(`  ! ${(error as Error).message.slice(0, 100)}\n`);
      }
    }
  }

  const pct = (n: number) =>
    anchoredSec > 0 ? `${((100 * n) / anchoredSec).toFixed(1)}%` : "-";
  const totalClips = jobs.reduce((n, j) => n + j.clips.length, 0);

  console.log(`corpus                            : ${jobs.length} jobs, ${totalClips} clips since ${SINCE.toISOString().slice(0, 10)}`);
  console.log(`clips with a plan                 : ${clipsPlanned}  (${noPlanClips} planned to null, ${failedClips} failed to measure)`);
  console.log(`time on an anchored (single) crop : ${anchoredSec.toFixed(0)}s  (was ${BASELINE_ANCHORED}s)`);
  console.log("");
  console.log("1. the acceptance number, under both noise floors");
  console.log("   LAX is the one the 84s target applies to: it is the floor that reproduces the");
  console.log("   baseline. STRICT counts only faces the engine itself believed in.");
  console.log(`   bisected, LAX    (samples >= 2)  : ${laxBisectedSec.toFixed(0)}s (${pct(laxBisectedSec)}) in ${laxClipsHit.size} clips, longest ${worstLaxSpan.toFixed(1)}s`);
  console.log(`     the same measurement at OLD x  : ${laxControlSec.toFixed(0)}s in ${laxControlClipsHit.size} clips   vs baseline ${BASELINE_TOTAL}s in ${BASELINE_CLIPS}, longest ${BASELINE_WORST}s`);
  console.log(`   bisected, STRICT (planner floor) : ${bisectedSec.toFixed(0)}s (${pct(bisectedSec)}) in ${clipsHit.size} clips, longest ${worstSpan.toFixed(1)}s`);
  console.log(`     the same measurement at OLD x  : ${controlBisectedSec.toFixed(0)}s in ${controlClipsHit.size} clips`);
  console.log(`   what the rule actually removed   : ${(laxControlSec - laxBisectedSec).toFixed(0)}s LAX, ${(controlBisectedSec - bisectedSec).toFixed(0)}s STRICT`);
  console.log(`   excluded, face wider than window : ${oversizeBandSec.toFixed(0)}s straddling an edge, of which ${oversizeOnlySec.toFixed(0)}s is the only reason that span is not counted above  (baseline excluded ${BASELINE_OVERSIZE}s)`);
  console.log("");
  console.log(`2. every remaining bisected span, for one-by-one judgement (${spans.length})`);
  console.log("   dur @start  N(+M)f/Ksh = most faces in any one detector shot, strict (+ sub-floor),");
  console.log("                            over shots merged into the span");
  console.log("              then every cut face, sN = which detector shot it belongs to (s0 set the x):");
  console.log("              visible%/width% of frame/SECONDS THE FACE IS ON SCREEN");
  console.log("              the span is charged in full to a face cut anywhere in it, so a large dur");
  console.log("              beside a small s-seen is a short bisection inside a long span");
  console.log("              a leading ~ = below the planner's noise floor, so LAX-only AND invisible");
  console.log("                            to placeWindow, which derives `others` from surviving tracks");
  console.log("              MERGE-BLIND = no cut face is in s0, so the rule never saw this face either:");
  console.log("                            merging keeps the first shot's x and discards the rest");
  if (spans.length === 0) console.log("   none");
  for (const s of [...spans].sort((a, b) => b.seconds - a.seconds)) {
    console.log(
      `   ${`${s.seconds.toFixed(1)}s`.padStart(7)} @${`${s.start.toFixed(1)}s`.padStart(7)}` +
        `  ${`${s.crowd}+${s.crowdLax - s.crowd}f/${s.shots}sh`.padEnd(11)}` +
        `${(s.strict ? "STRICT" : "lax   ").padEnd(7)}` +
        `${s.faces.padEnd(70)}${s.mergeBlind ? "MERGE-BLIND " : ""}${s.clip} ${s.title}`
    );
  }
  console.log("");
  console.log("3. diagnostics");
  console.log(`   an ANCHORED face cut by its own window: ${anchorCutSec.toFixed(0)}s  (must be 0 - placeWindow only searches positions that keep the group whole)`);
  console.log(`   clips that failed to measure    : ${failedClips} (excluded from every figure above)`);
  for (const f of failures) console.log(`     ! ${f}`);
  console.log("   Both controls re-score the NEW spans at windowXFor. Merging is decided on x, so");
  console.log("   under the old placement the spans themselves would have merged differently:");
  console.log("   the controls are close to the old world, not identical to it.");
  console.log("");
  console.log("4. verdict, on the LAX number - the baseline's own metric");
  if (laxBisectedSec > BASELINE_IRREDUCIBLE + 1) {
    console.log(`   ABOVE the ${BASELINE_IRREDUCIBLE}s the analysis predicted would remain. Some resolvable span was`);
    console.log("   not reached - find it in the listing above. The two mechanisms that can put a");
    console.log("   span there without the rule ever failing are marked in the listing: a ~ face is");
    console.log("   one the rule was not given, and MERGE-BLIND is a span it was not asked about.");
  } else if (laxBisectedSec < BASELINE_IRREDUCIBLE - 1) {
    console.log(`   BELOW the ${BASELINE_IRREDUCIBLE}s the analysis predicted would remain. This is NOT a win until it`);
    console.log("   is explained: the rule did something the analysis did not predict, and an");
    console.log("   unexplained improvement is an unexplained behaviour.");
  } else {
    console.log(`   AT the ${BASELINE_IRREDUCIBLE}s the analysis predicted - the two crowded shots of spec 2.2,`);
    console.log("   one with 7 faces and one with 6. Confirm the listing is those two and nothing else.");
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
