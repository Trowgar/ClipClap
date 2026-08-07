/**
 * Before/after frame strips for the window-placement change, ranked by how far
 * the window actually moved.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-shift-sheets.ts"
 *
 * `eval-bisection.ts` answers "how much delivered time has the crop edge
 * cutting a face in half", and it answers it well. It cannot answer the
 * question this script exists for, and says so in its own header: a shot where
 * NOBODY was cut before and nobody is cut after, but where the subject has been
 * pushed toward the edge to spare a face the viewer would never have noticed,
 * scores identically to a shot that was never touched. The bisection count
 * improves; the framing gets worse; no number in this project can see it. That
 * is the regression spec §5.1 predicted, and the only instrument for it is a
 * pair of frames side by side.
 *
 * So: every detector shot of every real clip since SINCE is asked where the
 * window would have gone before this change and where it goes now, the shots
 * where those differ are ranked by the size of the shift, and the worst six are
 * rendered as `.corpus/shift-sheets/<label>-pair.png` - LEFT the old window,
 * RIGHT the new one, one frame from the middle of the shot, the same frame
 * cropped twice.
 *
 * ---------------------------------------------------------------------------
 * THE "BEFORE" IS THE SHIPPED FUNCTION, NOT A COPY OF ITS ARITHMETIC
 * ---------------------------------------------------------------------------
 *
 * The old position comes from `windowXFor`, imported. Re-deriving
 * `evenClamp((minX + maxX) / 2 - cropW / 2, ...)` here would be three lines and
 * would look identical today, and the first time either the clamp or the
 * evenness rule changed, every strip this script produced would be a comparison
 * against a window that never shipped. A drifted "before" does not make the
 * pictures slightly wrong, it makes them evidence about nothing.
 *
 * `placeWindow` supplies the new position, with `others` taken the way
 * `buildCropPlan` takes it: this shot's surviving tracks minus the group, by
 * identity, INCLUDING faces under the min-face guard - the guard decides who
 * may anchor a window, not who may be sliced by one.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RISK, STATED RATHER THAN PAPERED OVER
 * ---------------------------------------------------------------------------
 *
 * The anchor group is rebuilt by calling `selectGroupForShot` with an
 * `AnchorPolicy` whose `sourceClass` is read off the plan's own profile.
 * `canAnchor` reads that class, so the class decides who is anchorable, which
 * decides the group, which decides both positions compared here. If a clip's
 * profile were ever absent, DEFAULT_CLASS below is used instead - and a
 * defaulted class can silently produce a different group than the planner used,
 * making both the "old" and the "new" x for that clip positions the engine
 * never computed.
 *
 * That is tolerable HERE, and only here, because this script does not produce
 * an acceptance number. It picks which frames to look at; the frames are the
 * evidence, and a frame is not made truer or falser by how it was selected. The
 * count of clips that hit the default is printed so a reader can see whether it
 * ever happened at all.
 *
 * If any of this is ever turned into a metric - a percentage, a total, a
 * pass/fail - the default must be deleted and the script must REFUSE the clip.
 * A metric computed from a guessed anchor group is a number that cannot be
 * wrong out loud, which is the exact failure this project has shipped twice.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE PICTURES ARE, AND WHAT THEY ARE NOT
 * ---------------------------------------------------------------------------
 *
 * - The two halves are the SAME decoded frame, cropped at two x positions, so
 *   any difference between them is the placement rule and nothing else. No
 *   subtitles, no camera motion (`motion: false`), no filtergraph.
 * - FOUR frames per case, not one. The first draft took a single frame at the
 *   shot midpoint and it was the wrong instrument: `placeWindow` scores MEDIAN
 *   boxes over the whole shot, and a face present in 7 of 12 samples has a
 *   median box that describes no particular instant. Two of the six largest
 *   shifts rendered a midpoint at which the outsider driving the move was
 *   simply not on screen, so the picture showed a window sliding across empty
 *   background for no visible reason - which reads as a regression and is
 *   actually a frame chosen at a moment the decision was not about. The frames
 *   are therefore the shot midpoint plus up to three SAMPLE TIMES of the
 *   outsider the rule was reacting to: the moments that motivated the move are
 *   the moments that can judge it.
 * - Every track's median box, sample count and time coverage is printed beside
 *   its case, so a reader can tell a face that is there throughout from a face
 *   that appears for a second and drags a median with it.
 * - The ranking is over detector shots, not over plan spans. A shot may be
 *   merged away by `mergeAdjacentLayouts`, or may not be a `single` at all -
 *   the layout the plan actually gave it is printed beside every case, and a
 *   case whose layout is not `single` moved a window the viewer never saw.
 * - `drawtext` has no font in this image and fails the whole graph, so nothing
 *   is burned into the pictures. Every label is on stdout.
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
  bisectionSeverity,
  buildCropPlan,
  cropWidthFor,
  faceVisibility,
  placeWindow,
  selectGroupForShot,
  windowXFor,
  type AnchorPolicy,
} from "../reframe/plan";
import { detectShots } from "../reframe/shots";
import type { FaceTrack, ShotTracks, SourceClass } from "../reframe/types";
import { corpusDir, loadManifest } from "./corpus-fetch";

const execFileAsync = promisify(execFile);

/** Same corpus as `eval-bisection.ts`: the real jobs the baseline was measured
 *  on. Any other set would produce pictures of a different change. */
const SINCE = new Date("2026-08-06T00:00:00Z");

/** How many pairs get rendered. Six because a reader will actually look at six.
 *  They are the six LARGEST shifts, which is the set most likely to contain the
 *  regression - a subject shoved to the edge shows up as a big move, not a
 *  small one. */
const TOP_N = 6;

/** Frames rendered per case: the shot midpoint plus up to three sample times of
 *  the outsider the rule reacted to. One frame per case was measurably not
 *  enough - see the header. */
const FRAMES_PER_CASE = 4;

/** See the header: used only when a plan carries no profile, counted, printed,
 *  and forbidden the moment this script produces a number. */
const DEFAULT_CLASS: SourceClass = "normal_face";

/** Each half of a pair. 9:16, big enough to judge composition rather than merely
 *  identify who is present - the question is where the subject sits in frame,
 *  and a thumbnail cannot answer it. */
const TILE_W = 405;
const TILE_H = 720;
/** A white gutter down the middle so the seam between the two crops is never
 *  mistaken for content. `hstack` refuses inputs of differing height, so both
 *  halves are scaled and padded to exactly the same size before stacking. */
const GUTTER = 6;

/** Same budgets `eval-bisection.ts` uses: some sources here are 1080p60 and a
 *  whole clip is sampled in one pass. */
const SHOTS_TIMEOUT_MS = 120_000;
const FACES_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = 300_000;

/** Tracks that clear the planner's per-shot noise floor.
 *
 *  A LOCAL COPY of `survivingTracks` in plan.ts, which is private there;
 *  `eval-bisection.ts` carries the same copy for the same reason. Both clauses
 *  are copied, not just the easy one: keeping `samples >= 2` and dropping the
 *  relative clause would hand `placeWindow` outsiders the planner had already
 *  discarded, and this script would then rank shots by a shift the engine never
 *  makes. The two constants are duplicated for the same reason - a partial copy
 *  is worse than none. */
const MIN_TRACK_SAMPLES = 2;
const MIN_SAMPLE_FRAC = 0.3;
function survivingTracks(tracks: FaceTrack[]): FaceTrack[] {
  const maxSamples = Math.max(0, ...tracks.map((t) => t.samples));
  return tracks.filter(
    (t) =>
      t.samples >= MIN_TRACK_SAMPLES && t.samples >= MIN_SAMPLE_FRAC * maxSamples
  );
}

interface ShiftCase {
  clipId: string;
  title: string;
  /** The job artifact, re-presigned at render time: collecting every clip in
   *  the corpus takes longer than a presigned URL lives. */
  artifactKey: string;
  /** The frames to grab. `at` is absolute source time - the clip's own offset
   *  plus a clip-relative shot time - and `why` says what that instant is, so a
   *  reader knows whether they are looking at the shot's middle or at a moment
   *  the outsider was actually detected. */
  frames: { at: number; why: string }[];
  shotIndex: number;
  /** Clip-relative, as the plan and the detector report them. */
  shotStart: number;
  shotEnd: number;
  sourceWidth: number;
  sourceHeight: number;
  cropW: number;
  oldX: number;
  newX: number;
  shift: number;
  groupSize: number;
  others: number;
  /** The layout the plan gave the span covering this shot's midpoint. A shift on
   *  a shot whose span is not `single` moved a window nobody ever saw. */
  layout: string;
  /** True when this shot's own geometry was merged away - the span covering it
   *  starts before it does, so it renders at an earlier shot's x. */
  merged: boolean;
  /** One line per track: median box, samples, time coverage, and what the old
   *  and new windows do to it. A face that is present throughout and a face
   *  that flickers for a second both produce a median box; only this tells them
   *  apart, and the difference decides whether a shift was worth making. */
  diag: string[];
}

/**
 * One line describing what a window does to a track, printed beside every
 * rendered case.
 *
 * `path` is absent from older sidecar builds, which the type marks optional; a
 * track without it prints its median box and no coverage rather than failing.
 */
function trackLine(
  role: string,
  t: FaceTrack,
  oldX: number,
  newX: number,
  cropW: number
): string {
  const cover = t.path?.length
    ? `t ${t.path[0].t.toFixed(1)}-${t.path[t.path.length - 1].t.toFixed(1)}s`
    : "t (no path)";
  const vis = (x: number) => `${(faceVisibility(t, x, cropW) * 100).toFixed(0)}%`;
  return (
    `${role.padEnd(6)} id${String(t.id).padEnd(3)} ` +
    `x=${t.box.x.toFixed(0)}..${(t.box.x + t.box.w).toFixed(0)} w=${t.box.w.toFixed(0)}  ` +
    `${String(t.samples).padStart(3)} samples ${cover}  ` +
    `visible ${vis(oldX).padStart(4)} -> ${vis(newX).padStart(4)}`
  );
}

/**
 * The frames worth looking at for one case.
 *
 * The shot midpoint always, because it is the shot's most representative single
 * instant. Then up to three sample times of `worst` - the outsider whose
 * bisection the rule was reacting to - spread across its own path, because the
 * midpoint can easily fall at a moment that face is not on screen, and a
 * picture taken then shows a window moving for no visible reason.
 */
function framesFor(
  shotStart: number,
  shotEnd: number,
  worst: FaceTrack | null
): { t: number; why: string }[] {
  const mid = (shotStart + shotEnd) / 2;
  const frames = [{ t: mid, why: "shot midpoint" }];
  const path = worst?.path?.filter((s) => s.t >= shotStart && s.t <= shotEnd) ?? [];
  const wanted = FRAMES_PER_CASE - frames.length;
  for (let k = 0; k < wanted && path.length > 0; k += 1) {
    // Spread over the path rather than taking the first three, which on a
    // 12-sample track would all land inside the same half-second.
    const s = path[Math.floor(((k + 0.5) * path.length) / wanted)];
    frames.push({ t: s.t, why: `id${worst!.id} detected at x=${s.x.toFixed(0)}` });
  }
  return frames;
}

/**
 * Source dimensions.
 *
 * `-read_intervals` so ffprobe seeks to the clip instead of demuxing a two-hour
 * remote file from byte zero, times 53 clips.
 */
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
 * One frame, cropped at two x positions, stacked left-old right-new.
 *
 * Both halves come from a single `split` of the same decoded frame, so the two
 * sides cannot differ by a frame's worth of motion and be read as a difference
 * in placement. `force_original_aspect_ratio=decrease` plus `pad` gives both
 * halves byte-identical dimensions before `hstack`, which refuses mismatched
 * heights outright rather than adapting. `setsar=1` after each scale: a scale
 * derives SAR from the crop aspect, and a non-square SAR reaching `hstack`
 * would stack differently-shaped pixels.
 */
async function renderPair(
  c: ShiftCase,
  at: number,
  url: string,
  outPng: string
): Promise<void> {
  const fit =
    `scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,` +
    `pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const graph =
    `[0:v]split=2[a][b];` +
    `[a]crop=${c.cropW}:${c.sourceHeight}:${c.oldX}:0,${fit},` +
    `pad=${TILE_W + GUTTER}:${TILE_H}:0:0:white[l];` +
    `[b]crop=${c.cropW}:${c.sourceHeight}:${c.newX}:0,${fit},` +
    `pad=${TILE_W + GUTTER}:${TILE_H}:${GUTTER}:0:white[r];` +
    `[l][r]hstack=inputs=2[pair]`;
  await execFileAsync(
    "ffmpeg",
    [
      "-nostdin", "-v", "error",
      "-ss", at.toFixed(3),
      "-i", url,
      "-filter_complex", graph,
      "-map", "[pair]",
      "-frames:v", "1",
      outPng, "-y",
    ],
    { timeout: RENDER_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
}

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const outDir = join(corpusDir(manifest), "shift-sheets");
  await mkdir(outDir, { recursive: true });

  const jobs = await prisma.job.findMany({
    where: {
      createdAt: { gte: SINCE },
      // A nullable STRING column, so `not: null` is right here. The Json
      // columns elsewhere in this repo need `Prisma.DbNull`; that rule does not
      // reach this one.
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

  const cases: ShiftCase[] = [];
  let clipsPlanned = 0;
  let noPlanClips = 0;
  let failedClips = 0;
  let defaultedProfiles = 0;
  let shotsExamined = 0;
  let shotsWithGroup = 0;
  const failures: string[] = [];
  const clipsWithShift = new Set<string>();

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
            // Explicit, not inherited: the camera layer is a different change
            // and a strip that silently had it on would not be evidence about
            // this one.
            motion: false,
            camera: DEFAULT_CAMERA,
          },
          cam
        );
        if (!plan) {
          // A null plan renders as the legacy centre crop for the whole clip:
          // no window this change can move. Counted rather than skipped in
          // silence.
          noPlanClips += 1;
          continue;
        }
        clipsPlanned += 1;
        if (!plan.profile) defaultedProfiles += 1;

        // The rule the planner applied to THIS clip. See the header for what a
        // defaulted class would cost.
        const policy: AnchorPolicy = {
          minFaceWidth: cfg.faceSmallFrac * W,
          sourceClass: plan.profile?.class ?? DEFAULT_CLASS,
          camRect: cam?.rect ?? null,
        };

        for (const [i, shot] of shots.entries()) {
          shotsExamined += 1;
          // `survivingTracks` first, exactly as `buildCropPlan` does it: the
          // group must be a subset of THESE objects for the identity filter
          // below to produce the outsiders the planner passed to `placeWindow`.
          const surviving = survivingTracks(
            tracks.find((t) => t.shotIndex === i)?.tracks ?? []
          );
          const group = selectGroupForShot(surviving, policy, cropW, W);
          if (!group) continue;
          shotsWithGroup += 1;
          const others = surviving.filter((t) => !group.includes(t));
          const oldX = windowXFor(group, cropW, W);
          const newX = placeWindow(group, others, cropW, W);
          if (oldX === newX) continue;

          const mid = (shot.start + shot.end) / 2;
          const span = plan.shots.find((s) => s.end > mid && s.start <= mid);
          clipsWithShift.add(clip.id);
          // The outsider the rule was reacting to: the one the OLD window cut
          // worst. It is what stage 2 minimised, so it is the face whose frames
          // decide whether the move was worth making.
          const worst = others.reduce<FaceTrack | null>(
            (acc, t) =>
              acc === null ||
              bisectionSeverity(faceVisibility(t, oldX, cropW)) >
                bisectionSeverity(faceVisibility(acc, oldX, cropW))
                ? t
                : acc,
            null
          );
          cases.push({
            clipId: clip.id,
            title: clip.title ?? "(untitled)",
            artifactKey,
            frames: framesFor(shot.start, shot.end, worst).map((f) => ({
              at: clip.startTime + f.t,
              why: f.why,
            })),
            diag: [
              ...group.map((t) => trackLine("ANCHOR", t, oldX, newX, cropW)),
              ...others.map((t) =>
                trackLine(t === worst ? "worst" : "other", t, oldX, newX, cropW)
              ),
            ],
            shotIndex: i,
            shotStart: shot.start,
            shotEnd: shot.end,
            sourceWidth: W,
            sourceHeight: H,
            cropW,
            oldX,
            newX,
            shift: Math.abs(newX - oldX),
            groupSize: group.length,
            others: others.length,
            layout: span?.layout ?? "(no span)",
            merged: span ? span.start < shot.start - 1e-6 : false,
          });
        }
      } catch (error) {
        failedClips += 1;
        failures.push(`${clip.id} ${(error as Error).message.slice(0, 120)}`);
      }
    }
  }

  cases.sort((a, b) => b.shift - a.shift || a.clipId.localeCompare(b.clipId));

  console.log("\n=== window shifts");
  console.log(`  jobs                : ${jobs.length}`);
  console.log(`  clips planned       : ${clipsPlanned}  (no plan ${noPlanClips}, failed ${failedClips})`);
  console.log(`  detector shots      : ${shotsExamined}  (with an anchor group ${shotsWithGroup})`);
  console.log(`  shots that MOVED    : ${cases.length} in ${clipsWithShift.size} clips`);
  console.log(`  profile defaulted   : ${defaultedProfiles} clips  ${defaultedProfiles === 0 ? "(never - the group is the planner's)" : "!! see the header"}`);
  if (cases.length > 0) {
    const shifts = cases.map((c) => c.shift).sort((a, b) => a - b);
    const median = shifts[Math.floor(shifts.length / 2)];
    console.log(`  shift px            : min ${shifts[0]}  median ${median}  max ${shifts[shifts.length - 1]}`);
  }

  console.log(`\n=== every shift, largest first`);
  for (const [rank, c] of cases.entries()) {
    console.log(
      `  ${String(rank + 1).padStart(3)} ${String(c.shift).padStart(4)}px  ` +
        `${String(c.oldX).padStart(4)} -> ${String(c.newX).padStart(4)}  ` +
        `${c.layout.padEnd(7)}${c.merged ? " merged" : "      "}  ` +
        `${c.shotStart.toFixed(1)}-${c.shotEnd.toFixed(1)}s  ` +
        `g${c.groupSize}/o${c.others}  ${c.clipId.slice(0, 8)} ${c.title.slice(0, 44)}`
    );
  }

  console.log(`\n=== rendering the top ${TOP_N}`);
  for (const [rank, c] of cases.slice(0, TOP_N).entries()) {
    const name = `${String(rank + 1).padStart(2, "0")}-${c.clipId.slice(0, 8)}-shot${c.shotIndex}`;
    console.log(`\n  [${rank + 1}] ${name}`);
    console.log(`      shift       : ${c.shift}px   old x=${c.oldX}  new x=${c.newX}  (cropW ${c.cropW} of ${c.sourceWidth})`);
    console.log(`      clip        : ${c.clipId}  ${c.title}`);
    console.log(`      shot        : #${c.shotIndex}  ${c.shotStart.toFixed(2)}-${c.shotEnd.toFixed(2)}s (clip-relative)`);
    console.log(`      plan span   : ${c.layout}${c.merged ? " (this shot's geometry was merged away)" : ""}`);
    for (const line of c.diag) console.log(`      ${line}`);
    try {
      // Re-presigned once per case: collecting the corpus takes longer than a
      // URL lives, and one case is four frames off the same URL.
      const url = await getPresignedDownloadUrl(c.artifactKey, 7200);
      for (const [fi, f] of c.frames.entries()) {
        const outPng = join(outDir, `${name}-f${fi + 1}.png`);
        await renderPair(c, f.at, url, outPng);
        console.log(`      f${fi + 1} ${f.at.toFixed(2)}s  ${f.why.padEnd(30)} ${outPng}`);
      }
      console.log(`      LEFT = old window, RIGHT = new window`);
    } catch (error) {
      console.log(`      ! FAILED: ${(error as Error).message.slice(0, 200)}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n=== clips that failed (${failures.length})`);
    for (const f of failures) console.log(`  ${f}`);
  }

  console.log(
    "\nThese pictures answer a question no number here can: whether a shot that " +
      "moved is still well framed. Read them; do not infer them from the pixels above."
  );

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
