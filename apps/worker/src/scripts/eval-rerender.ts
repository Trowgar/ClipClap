/**
 * The six clips the window-placement change moved, re-rendered beside the
 * files their owner actually received.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-rerender.ts"
 *
 * `eval-shift-sheets.ts` put the old and new crop windows side by side as
 * STILL FRAMES, and that was the right instrument for "did the window move
 * somewhere sensible". It is not the product. A clip is 20-80 seconds of a
 * window cutting between shots, under subtitles, at 30fps - and none of that is
 * visible in a pair of PNGs. Whether the change is an improvement is a question
 * about watching, so this script produces the two things a person can watch:
 *
 *   .corpus/rerender/<clipId>-before.mp4   the delivered mp4, pulled from R2
 *   .corpus/rerender/<clipId>-after.mp4    the same clip, today's code
 *
 * Nothing about the highlight changes between them - same in and out, same
 * transcript, same cues, same subtitle setting, same encoder settings - so a
 * difference between the two files is the crop window and nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE "AFTER" IS THE STAGE'S OWN PATH, NOT A HAND-ROLLED FFMPEG COMMAND
 * ---------------------------------------------------------------------------
 *
 * `renderOne` below is `renderClips` in stages/render.ts, per highlight, with
 * the database and R2 removed and nothing else changed: `segmentsToCues` ->
 * `createAssFilter` -> `computeCropPlan` -> `buildFiltergraph` -> `cutClips`,
 * same order, same encode-failure fallback. That matters more here than
 * anywhere else in this repo: an approximation with its own `-crf` or its own
 * scale filter would differ from the delivered file in ways that have nothing
 * to do with the crop, and the comparison the whole script exists for would be
 * measuring the approximation instead. The reframe config is read with
 * `loadReframeConfig()` and NOTHING is overridden - not `motion`, not the
 * engine flag. The question is what the product emits today, so the answer has
 * to come from the settings the product is running under today.
 *
 * ---------------------------------------------------------------------------
 * WHAT COULD NOT BE REPRODUCED, STATED RATHER THAN SUBSTITUTED
 * ---------------------------------------------------------------------------
 *
 * Everything in `renderClips` that writes is simply absent, and no stand-in was
 * invented for any of it. None of it touches the pixels:
 *
 *   - `prisma.job.update` (status CUTTING, renderMs, clipsGenerated,
 *     renderManifest), `prisma.clip.create`, and the `finalize` enqueue.
 *   - `uploadFile` for the clip and for the 16:9 dashboard thumbnail, and
 *     `generateThumbnail` with it.
 *   - `summariseRestores` and `buildReframeCheck`: telemetry whose only
 *     destination is `renderManifest`, a column this script may not write.
 *   - `probeTimeline` / `probeDuration` drift warnings. The equivalent probe is
 *     done at the end for BOTH files, where it can compare them, which is the
 *     only form of it that is useful here.
 *   - `computeClipExpiresAt` - a DB column, nothing more.
 *
 * One thing genuinely cannot be reproduced, and it is not a write:
 * `consecutiveTimeouts`. In the stage it is job-level state carried across
 * every highlight in order, and after two detection timeouts in a row the rest
 * of the job's highlights skip detection entirely and take the legacy centre
 * crop. This script renders a hand-picked SUBSET of a job's clips, so that
 * counter has no meaningful value to carry. It is therefore not modelled at
 * all: every clip here gets its detection attempt. For these six that is
 * faithful anyway - a highlight skipped after timeouts is stored with no
 * `cropPlan`, and all six carry one, so the skip did not fire for any of them.
 *
 * ---------------------------------------------------------------------------
 * Read-only. No database writes, no R2 writes, the delivered clips untouched.
 * The job sources are large, so each job's artifact is downloaded ONCE, used
 * for that job's clips, and deleted before the next job starts.
 */
import { execFile } from "child_process";
import { copyFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { prisma } from "@clipclap/shared";
import type { Highlight, WhisperSegment } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { cutClips, type CutResult } from "../processors/cut";
import { downloadVideo } from "../processors/download";
import { createAssFilter, segmentsToCues } from "../processors/subtitles";
import { computeCropPlan } from "../reframe";
import { loadReframeConfig } from "../reframe/config";
import { buildFiltergraph } from "../reframe/filtergraph";
import type { CropPlan, FilterSpec, ShotLayout } from "../reframe/types";
import { asHighlights, asTranscription } from "../stages/types";
import { corpusDir, loadManifest } from "./corpus-fetch";

const execFileAsync = promisify(execFile);

/**
 * The six clips `eval-shift-sheets.ts` found a moved window in, and the only
 * six whose delivered file still exists in R2. Hardcoded rather than re-derived
 * from a shift computation: this script must render the SAME six every time it
 * is run, including after the next placement change, or a reader comparing two
 * runs would be comparing two different clip sets.
 */
const CLIP_IDS = [
  "cmsi4gftv0005akgyb62kp2mb",
  "cmshccg7f001vhd2rgwxwr05b",
  "cmshgtqxt000f1445ai1cfoap",
  "cmsi4hqux000dakgy7rvfm3zy",
  "cmshgrj9h00051445wpa3q04q",
  "cmshgsrvr00091445kr748jsv",
];

/** A clip row's `startTime` matched against a highlight's `start`. Both are
 *  doubles written from the same value, so this is a float-safety epsilon and
 *  not a search radius - a highlight 10ms away is a DIFFERENT highlight and
 *  must not be silently accepted as this clip's. */
const TIME_EPSILON = 1e-3;

/** before vs after duration agreement. Anything larger is not the same cut and
 *  is reported as a failure of the comparison, not smoothed over. */
const DURATION_TOLERANCE_SEC = 0.1;

interface Probe {
  durationSec: number;
  width: number;
  height: number;
}

/** The x values a shot renders at, in the order the layout uses them. Every
 *  layout variant is spelled out: a `default` returning "" would turn a
 *  layout this script does not understand into a silent "no change". */
function shotXs(shot: ShotLayout): string {
  switch (shot.layout) {
    case "center":
      return `center x=${shot.x}`;
    case "single":
      return shot.xs?.length
        ? `single x=${shot.x} xs=[${shot.xs.map((k) => k.x).join(",")}]`
        : `single x=${shot.x}`;
    case "split":
      return `split top=${shot.top.x} bottom=${shot.bottom.x}`;
    case "stream":
      return `stream cam=${shot.cam.x} content=${shot.content.x}`;
    case "safe-fit":
      return `safe-fit reason=${shot.reason}`;
  }
}

/**
 * The two plans' spans laid on ONE timeline, so old and new x are compared at
 * the same instant of the clip.
 *
 * The obvious version of this - walk both `shots` arrays by index - is wrong,
 * and wrong in a way that reads as a much bigger regression than the truth.
 * `mergeAdjacentLayouts` collapses neighbouring spans that share an x, so
 * moving ONE span's window can stop a merge and give the new plan an extra
 * entry. Every later index then lines up against the wrong span and the table
 * reports a cascade of moves that never happened: on cmshgsrvr the index form
 * flagged 12 of 13 spans as MOVED when 2 actually did.
 *
 * So: every boundary from either plan becomes a cut point, and each resulting
 * interval is looked up in both plans by its own midpoint. An interval present
 * in one plan and absent from the other prints as "(none)" rather than being
 * paired with whatever happened to sit at that index.
 */
function timeline(
  oldPlan: CropPlan | null,
  newPlan: CropPlan | null
): { start: number; end: number; before?: ShotLayout; after?: ShotLayout }[] {
  const edges = [...(oldPlan?.shots ?? []), ...(newPlan?.shots ?? [])].flatMap(
    (s) => [s.start, s.end]
  );
  const cuts = [...new Set(edges)].sort((a, b) => a - b);
  const at = (plan: CropPlan | null, t: number) =>
    plan?.shots.find((s) => s.start <= t && s.end > t);
  const rows = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const [start, end] = [cuts[i], cuts[i + 1]];
    // Boundaries that differ only by float noise produce slivers no frame
    // lives in; they would print as spurious rows.
    if (end - start < 1e-3) continue;
    const mid = (start + end) / 2;
    rows.push({ start, end, before: at(oldPlan, mid), after: at(newPlan, mid) });
  }
  return rows;
}

/**
 * Duration and frame size of a finished file.
 *
 * `format=duration` for the duration - the container's, which is what a player
 * shows and what the stage's own drift check reads - and the video stream's
 * coded size, because a 9:16 clip that came out 1920x1080 is a broken render
 * regardless of how long it is.
 *
 * Two invocations rather than one `format=duration:stream=width,height`: with
 * `nokey=1` the combined form emits three bare numbers whose order is decided
 * by ffprobe's section ordering, and a reader of this file cannot tell whether
 * `[a, b, c]` is width/height/duration or duration/width/height. Getting that
 * backwards would silently report every clip as 26x1080 with a 1920s duration.
 * Each call here asks for one thing and gets one answer.
 */
async function probeFile(path: string): Promise<Probe> {
  const size = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      path,
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  const [width, height] = size.stdout.trim().split("x").map(Number);
  const dur = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  const durationSec = Number(dur.stdout.trim());
  if (!width || !height || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(
      `probe_failed: ${JSON.stringify(size.stdout)} ${JSON.stringify(dur.stdout)}`
    );
  }
  return { width, height, durationSec };
}

/**
 * One highlight through the render stage's own path.
 *
 * Mirrors `renderClips`'s per-highlight body in stages/render.ts. Keep the two
 * in step: the value of this script is entirely that the file it writes is the
 * file the product would have uploaded.
 */
async function renderOne(
  sourcePath: string,
  highlight: Highlight,
  transcriptSegments: WhisperSegment[],
  subtitlesOn: boolean,
  language: string | null | undefined,
  outPath: string
): Promise<{ plan: CropPlan | null; note: string }> {
  const tempFiles: string[] = [];
  try {
    const cues = segmentsToCues(
      transcriptSegments,
      highlight.start,
      highlight.end
    );

    // Same condition as the stage, with the job-level flag replaced by what the
    // Clip row records was actually burned - see the caller.
    let assFilter: { filter: string; assPath: string } | null = null;
    if (subtitlesOn && cues.length > 0) {
      // Same face the original render chose, or this script reproduces a
      // different file than the one it is supposed to be checking.
      assFilter = await createAssFilter(cues, language);
      tempFiles.push(assFilter.assPath);
    }

    const reframeCfg = loadReframeConfig();
    let filterSpec: FilterSpec | null = null;
    let cropPlan: CropPlan | null = null;
    let note = "";
    if (reframeCfg.engine === "faces") {
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
        note = `reframe fallback: ${reframe.fallbackReason}`;
      }
    } else {
      note = `REFRAME_ENGINE=${reframeCfg.engine} - legacy centre crop`;
    }

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
      // The stage's one retry: a reframe encode failure degrades to the legacy
      // centre crop rather than failing the clip.
      note = `reframe encode fallback: ${(error as Error).message.slice(0, 160)}`;
      filterSpec = null;
      cropPlan = null;
      [cutResult] = await cutClips(
        sourcePath,
        [highlight],
        assFilter?.filter,
        null
      );
    }
    tempFiles.push(cutResult.clipPath);

    // The stage uploads here. This writes the same bytes to disk instead:
    // copy-then-unlink rather than rename, because tmpdir is the container
    // overlay and .corpus/ is a bind mount, and rename across devices throws.
    await copyFile(cutResult.clipPath, outPath);
    return { plan: cropPlan, note };
  } finally {
    for (const file of tempFiles) await unlink(file).catch(() => {});
  }
}

async function main() {
  const manifest = await loadManifest();
  const outDir = join(corpusDir(manifest), "rerender");
  await mkdir(outDir, { recursive: true });
  const cfg = loadReframeConfig();

  const clips = await prisma.clip.findMany({
    where: { id: { in: CLIP_IDS } },
    select: {
      id: true,
      jobId: true,
      title: true,
      startTime: true,
      endTime: true,
      subtitles: true,
      storageKey: true,
      cropPlan: true,
    },
  });
  const missing = CLIP_IDS.filter((id) => !clips.some((c) => c.id === id));
  if (missing.length > 0) {
    throw new Error(`clips not in the database: ${missing.join(", ")}`);
  }
  // Keep CLIP_IDS order so two runs print in the same order, but group the work
  // by job so each job's source is downloaded once.
  const ordered = CLIP_IDS.map((id) => clips.find((c) => c.id === id)!);
  const jobIds = [...new Set(ordered.map((c) => c.jobId))];

  console.log(`=== reframe config`);
  console.log(`  engine ${cfg.engine}  motion ${cfg.motion}  stream ${cfg.stream}`);
  console.log(`  ${ordered.length} clips across ${jobIds.length} jobs -> ${outDir}\n`);

  const results: {
    clipId: string;
    title: string;
    ok: boolean;
    note: string;
    before?: Probe;
    after?: Probe;
    oldPlan: CropPlan | null;
    newPlan: CropPlan | null;
  }[] = [];

  for (const [ji, jobId] of jobIds.entries()) {
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        id: true,
        originalFilename: true,
        subtitles: true,
        language: true,
        normalizedArtifactKey: true,
        sourceArtifactKey: true,
        transcriptJson: true,
        highlights: true,
      },
    });
    const jobClips = ordered.filter((c) => c.jobId === jobId);
    // Same precedence as the stage: the normalized artifact when there is one.
    const sourceKey = job.normalizedArtifactKey ?? job.sourceArtifactKey;
    if (!sourceKey) throw new Error(`job ${jobId} has no source artifact`);
    const transcription = asTranscription(job.transcriptJson);
    const highlights = asHighlights(job.highlights);

    console.log(
      `--- job ${ji + 1}/${jobIds.length} ${jobId}  ${jobClips.length} clips  ` +
        `job.subtitles=${job.subtitles}`
    );
    console.log(`    ${job.originalFilename ?? "(no filename)"}`);
    console.log(`    source ${sourceKey}`);
    process.stderr.write(`[job ${ji + 1}/${jobIds.length}] downloading source ...\n`);
    const sourcePath = await downloadVideo(undefined, sourceKey);

    try {
      for (const [ci, clip] of jobClips.entries()) {
        const beforePath = join(outDir, `${clip.id}-before.mp4`);
        const afterPath = join(outDir, `${clip.id}-after.mp4`);
        process.stderr.write(
          `[job ${ji + 1}/${jobIds.length} clip ${ci + 1}/${jobClips.length}] ` +
            `${clip.id} ${(clip.endTime - clip.startTime).toFixed(1)}s\n`
        );
        const oldPlan = (clip.cropPlan as unknown as CropPlan | null) ?? null;
        try {
          // The delivered file, straight from R2 through the same fetch the
          // stage's own source download uses.
          const tmpBefore = await downloadVideo(undefined, clip.storageKey);
          await copyFile(tmpBefore, beforePath);
          await unlink(tmpBefore).catch(() => {});

          // The stage renders a Highlight object, not a Clip row, and the
          // highlight is what carries title/score/kind. Take the job's own
          // highlight whose window is this clip's, so the re-render is driven
          // by the same object the delivered render was.
          const highlight = highlights.find(
            (h) =>
              Math.abs(h.start - clip.startTime) < TIME_EPSILON &&
              Math.abs(h.end - clip.endTime) < TIME_EPSILON
          );
          if (!highlight) {
            throw new Error(
              `no highlight in job ${jobId} matches ${clip.startTime}-${clip.endTime}`
            );
          }

          // What was BURNED, per the Clip row, not what the job asked for. The
          // stage writes this column as `assFilter !== null`, so it already
          // encodes "the job wanted subtitles AND this highlight had cues".
          const subtitlesOn = clip.subtitles;
          const jobWould =
            job.subtitles &&
            segmentsToCues(transcription.segments, highlight.start, highlight.end)
              .length > 0;
          const subsNote =
            jobWould === subtitlesOn
              ? ""
              : ` !! Clip.subtitles=${subtitlesOn} but job.subtitles+cues says ${jobWould}`;

          // Same precedence as stages/render.ts: the highlight's own language
          // wins over the job's, because a source can switch language
          // partway through and the job carries only the dominant one.
          const clipLanguage = highlight.language ?? job.language;

          const { plan, note } = await renderOne(
            sourcePath,
            highlight,
            transcription.segments,
            subtitlesOn,
            clipLanguage,
            afterPath
          );

          const before = await probeFile(beforePath);
          const after = await probeFile(afterPath);
          results.push({
            clipId: clip.id,
            title: clip.title ?? "(untitled)",
            ok: true,
            note: `${note}${subsNote}`.trim(),
            before,
            after,
            oldPlan,
            newPlan: plan,
          });
        } catch (error) {
          results.push({
            clipId: clip.id,
            title: clip.title ?? "(untitled)",
            ok: false,
            note: (error as Error).message.slice(0, 300),
            oldPlan,
            newPlan: null,
          });
        }
      }
    } finally {
      // Before the next job's source lands: these are whole VODs.
      await unlink(sourcePath).catch(() => {});
      process.stderr.write(`[job ${ji + 1}/${jobIds.length}] source deleted\n`);
    }
  }

  console.log(`\n=== crop plan x values, persisted vs today`);
  for (const r of results) {
    console.log(`\n  ${r.clipId}  ${r.title}`);
    if (r.note) console.log(`    note: ${r.note}`);
    if (!r.oldPlan) {
      console.log(`    persisted: NO cropPlan on the row (legacy centre crop)`);
    }
    if (!r.newPlan && r.ok) {
      console.log(`    today    : NO plan - see the note above`);
    }
    if (r.oldPlan && r.newPlan && r.oldPlan.shots.length !== r.newPlan.shots.length) {
      console.log(
        `    spans ${r.oldPlan.shots.length} -> ${r.newPlan.shots.length} ` +
          `(a moved window can stop an adjacent-span merge; rows are paired by time)`
      );
    }
    let moved = 0;
    for (const row of timeline(r.oldPlan, r.newPlan)) {
      const was = row.before ? shotXs(row.before) : "(none)";
      const now = row.after ? shotXs(row.after) : "(none)";
      const flag = was !== now ? " <== MOVED" : "";
      if (was !== now) moved += 1;
      console.log(
        `    ${row.start.toFixed(2).padStart(6)}-${row.end.toFixed(2).padStart(6)}s  ` +
          `was ${was.padEnd(26)} now ${now}${flag}`
      );
    }
    console.log(`    ${moved} span(s) differ`);
  }

  console.log(`\n=== files`);
  let bad = 0;
  for (const r of results) {
    if (!r.ok || !r.before || !r.after) {
      bad += 1;
      console.log(`  FAILED ${r.clipId}: ${r.note}`);
      continue;
    }
    const delta = Math.abs(r.after.durationSec - r.before.durationSec);
    const verdict = delta <= DURATION_TOLERANCE_SEC ? "ok" : "!! MISMATCH";
    if (delta > DURATION_TOLERANCE_SEC) bad += 1;
    console.log(
      `  ${r.clipId}  ` +
        `before ${r.before.durationSec.toFixed(3)}s ${r.before.width}x${r.before.height}  ` +
        `after ${r.after.durationSec.toFixed(3)}s ${r.after.width}x${r.after.height}  ` +
        `delta ${delta.toFixed(3)}s ${verdict}`
    );
    console.log(`    ${join(outDir, `${r.clipId}-before.mp4`)}`);
    console.log(`    ${join(outDir, `${r.clipId}-after.mp4`)}`);
  }

  console.log(
    `\n${results.length - bad}/${results.length} clips comparable. ` +
      `Watch the pairs; the x table above only says which shots to watch for.`
  );
  if (bad > 0) process.exitCode = 1;

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
