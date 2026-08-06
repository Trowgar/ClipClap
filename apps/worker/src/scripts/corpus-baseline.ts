/**
 * Captures what the reframe engine does TODAY, before any Layer 0 change, on
 * every corpus fixture that exists on disk.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/corpus-baseline.ts"
 *
 * This is the irreversible step of the motion work. Once the crop window is
 * allowed to move, "what did the static window do on this frame" cannot be
 * recovered by argument, only by re-running a build that no longer exists. So
 * it is written to disk first, from the code that ships, and every later task
 * compares against these files rather than against a memory of them.
 *
 * Three artifacts per item, all in `.corpus/` beside the mp4 (gitignored - the
 * script is committed, the outputs never are):
 *
 *   <id>.plan.json  shots, RAW tracks, plan, source dimensions, clip window
 *   <id>.base1.mp4  the render
 *   <id>.base2.mp4  the SAME render, again
 *
 * WHY THE TRACKS ARE STORED RAW, PATH ARRAYS AND ALL. The plan is lossy about
 * faces: it keeps one x per shot and throws the detections away. The containment
 * metric ("was the face inside the window at time t") needs the per-sample
 * `path` boxes, and YuNet over 60s of 1080p is minutes of wall clock per item.
 * Storing the detector output means every later measurement replays this file
 * instead of re-detecting - and, more importantly, replays the SAME detections,
 * so a metric that moves has moved because the planner changed and not because
 * the detector sampled differently.
 *
 * WHY THE RENDER HAPPENS TWICE. A synthetic 5-second probe showed two identical
 * ffmpeg encodes producing the same full-file md5 with no `-bitexact` flags -
 * but that probe had no subtitle burn and no real decode behind it, so it is
 * evidence about a toy, not about this corpus. If base1 and base2 differ here,
 * a full-file hash is not a usable invariant for the later comparisons and the
 * fallback is a decoded `streamhash` plus a byte comparison of the filtergraph
 * string. The run reports which case holds rather than assuming one.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import { readFile, stat, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { loadReframeConfig } from "../reframe/config";
import { detectShots } from "../reframe/shots";
import { detectFaces } from "../reframe/faces";
import { resolveCamRect } from "../reframe/cam-rect";
import { buildCropPlan } from "../reframe/plan";
import { buildFiltergraph } from "../reframe/filtergraph";
import type { CropPlan, Shot, ShotTracks } from "../reframe/types";
import { corpusDir, corpusPath, loadManifest } from "./corpus-fetch";

const execFileAsync = promisify(execFile);

/**
 * The clip window, identical on every item and stated once here.
 *
 * The fixtures are 90 seconds; the window is 60. The 30-second margin is not
 * waste - `-ss`/`-to` seeking into a file that ends exactly at the window would
 * make the tail of every render depend on how the last GOP was cut by yt-dlp,
 * which is a property of the fetch and not of the engine. A window strictly
 * inside the material removes that from the comparison.
 *
 * 60 seconds is also longer than any real clip this product emits, so a shot
 * count measured here is an upper bound on what production sees.
 */
const CLIP_START_SEC = 0;
const CLIP_LEN_SEC = 60;
const CLIP_END_SEC = CLIP_START_SEC + CLIP_LEN_SEC;

/**
 * Per-detector wall-clock budget, well above the production `maxDetectSec` of
 * 30. Production is right to give up early - a user is waiting. This script has
 * nobody waiting, and a timeout here would record a `plan: null` baseline that
 * is an artifact of the budget rather than of the engine, poisoning every later
 * comparison in the direction that looks like success. stream-cam is 1080p60,
 * i.e. twice the frames of everything else, and is what this number is sized
 * for.
 */
const DETECT_TIMEOUT_MS = 300_000;
/** ffprobe reads a header. If that takes 30s the file is broken, not slow. */
const PROBE_TIMEOUT_MS = 30_000;
/** Two full 60s x264 encodes per item, one at a time. */
const RENDER_TIMEOUT_MS = 600_000;

interface BaselineFile {
  shots: Shot[];
  tracks: ShotTracks[];
  plan: CropPlan | null;
  source: { width: number; height: number };
  clip: { start: number; end: number };
}

/**
 * Local copy of the private `probeDimensions` in reframe/index.ts. Not an
 * accident and not a candidate for extraction: this script must not change any
 * file the baseline is a baseline OF. Exporting a helper out of index.ts would
 * touch the module under measurement on the same commit that measures it.
 */
async function probeDimensions(
  path: string
): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      path,
    ],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

const md5 = (buffer: Buffer) => createHash("md5").update(buffer).digest("hex");

async function fileMd5(path: string): Promise<string> {
  return md5(await readFile(path));
}

/**
 * md5 of the DECODED video frames, ignoring container bytes entirely. Only
 * computed when the full-file hashes disagree, because when they agree this is
 * guaranteed to agree too and a full 1080p decode is not free.
 */
async function decodedStreamHash(path: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin", "-v", "error",
      "-i", path,
      "-map", "0:v",
      "-f", "streamhash", "-hash", "md5",
      "-",
    ],
    { timeout: RENDER_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  return stdout.trim();
}

/**
 * The encode. Mirrors `buildCutArgs`: input seeking with `-ss`/`-to` before
 * `-i`, so output timestamps rebase to ~0 and the plan's clip-relative shot
 * boundaries and `enable` windows line up with what the filtergraph expects.
 * No subtitle snippet - the baseline is the crop geometry, and a burned caption
 * would make every later diff a diff of two things at once.
 */
function renderArgs(
  sourcePath: string,
  plan: CropPlan,
  outPath: string
): string[] {
  const spec = buildFiltergraph(plan);
  const head = [
    "-nostdin", "-v", "error",
    "-ss", String(CLIP_START_SEC),
    "-to", String(CLIP_END_SEC),
    "-i", sourcePath,
  ];
  const filter =
    spec.kind === "complex"
      ? ["-filter_complex", spec.graph, "-map", "[vout]", "-map", "0:a?"]
      : ["-vf", spec.graph];
  return [
    ...head,
    ...filter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outPath,
    "-y",
  ];
}

/** "single x3, split x1" - the layout mix, in the order the planner emitted. */
function layoutMix(plan: CropPlan): string {
  const counts = new Map<string, number>();
  for (const shot of plan.shots) {
    counts.set(shot.layout, (counts.get(shot.layout) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k} x${n}`).join(", ");
}

interface Row {
  id: string;
  source: string;
  shots: number;
  planShots: string;
  layouts: string;
  renders: string;
  elapsed: string;
}

async function main() {
  const cfg = loadReframeConfig();
  // THE GUARD THAT MATTERS. A baseline captured with the motion flag on is
  // indistinguishable from one captured without it - same file names, same
  // shape, plausible numbers - and it would silently make every later
  // comparison read "no change". There is no way to detect that after the fact,
  // so it is refused up front rather than warned about.
  if (cfg.motion) {
    console.error(
      "REFRAME_MOTION is on. The baseline must be the legacy static-window path;\n" +
        "capturing it with trajectories enabled would poison every later comparison\n" +
        "in a way nothing downstream can detect. Unset REFRAME_MOTION and re-run."
    );
    process.exit(1);
  }

  const manifest = await loadManifest();
  const dir = corpusDir(manifest);
  const rows: Row[] = [];
  const missing: string[] = [];
  const noPlan: string[] = [];
  const mismatched: string[] = [];
  let rendered = 0;

  console.log(
    `clip window [${CLIP_START_SEC}, ${CLIP_END_SEC}) s, motion=${cfg.motion}, ` +
      `stream=${cfg.stream}, sampleFps=${cfg.sampleFps}, faceMinScore=${cfg.faceMinScore}`
  );
  console.log(`corpus dir ${dir}\n`);

  for (const item of manifest.items) {
    const src = corpusPath(manifest, item.id);
    const exists = await stat(src).catch(() => null);
    if (!exists || exists.size === 0) {
      console.log(`skip ${item.id}: not on disk`);
      missing.push(item.id);
      continue;
    }

    const startedAt = Date.now();
    console.log(`--- ${item.id}`);
    const { width, height } = await probeDimensions(src);

    const shotsAt = Date.now();
    const shots = await detectShots(
      src, CLIP_START_SEC, CLIP_END_SEC, cfg, DETECT_TIMEOUT_MS
    );
    const shotsMs = Date.now() - shotsAt;

    const facesAt = Date.now();
    const tracks = await detectFaces(
      src, CLIP_START_SEC, CLIP_END_SEC, shots, width, height, cfg,
      DETECT_TIMEOUT_MS
    );
    const facesMs = Date.now() - facesAt;

    // Exactly the call order computeCropPlan uses, with the config's own values
    // and `motion: false` said out loud rather than inherited - PlanOptions
    // makes the field required precisely so a baseline cannot acquire
    // trajectories by omission.
    const cam = resolveCamRect(tracks.map((t) => t.camRect), width, height);
    const plan = buildCropPlan(shots, tracks, width, height, {
      faceSmallFrac: cfg.faceSmallFrac,
      faceLargeFrac: cfg.faceLargeFrac,
      stream: cfg.stream,
      camShare: cfg.camShare,
      motion: false,
      camera: cfg.camera,
    }, cam);

    const payload: BaselineFile = {
      shots,
      tracks,
      plan,
      source: { width, height },
      clip: { start: CLIP_START_SEC, end: CLIP_END_SEC },
    };
    await writeFile(
      join(dir, `${item.id}.plan.json`),
      JSON.stringify(payload, null, 2),
      "utf-8"
    );

    const pathSamples = tracks.reduce(
      (n, s) => n + s.tracks.reduce((m, t) => m + (t.path?.length ?? 0), 0),
      0
    );
    console.log(
      `    ${width}x${height}  shots=${shots.length} (${shotsMs} ms)  ` +
        `tracks=${tracks.reduce((n, s) => n + s.tracks.length, 0)} ` +
        `pathSamples=${pathSamples} (${facesMs} ms)  camRect=${cam.rect ? "yes" : cam.reason}`
    );

    // A null plan is a real, recordable outcome - the legacy centre-crop path -
    // not a failure of this script. It is written to the json as plan:null so a
    // later run can tell "the planner declined" from "the item was never
    // measured", and there is nothing to render because production would render
    // the untouched centre crop.
    if (!plan) {
      console.log("    plan: null - legacy centre-crop path, no renders");
      noPlan.push(item.id);
      rows.push({
        id: item.id,
        source: `${width}x${height}`,
        shots: shots.length,
        planShots: "-",
        layouts: "plan: null (legacy centre crop)",
        renders: "-",
        elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      });
      continue;
    }

    const spec = buildFiltergraph(plan);
    const out1 = join(dir, `${item.id}.base1.mp4`);
    const out2 = join(dir, `${item.id}.base2.mp4`);
    for (const out of [out1, out2]) {
      await execFileAsync("ffmpeg", renderArgs(src, plan, out), {
        timeout: RENDER_TIMEOUT_MS,
        maxBuffer: CHILD_MAX_BUFFER_BYTES,
      });
    }
    const [h1, h2] = await Promise.all([fileMd5(out1), fileMd5(out2)]);
    const identical = h1 === h2;
    if (!identical) mismatched.push(item.id);
    rendered += 1;

    let renders = identical ? `md5 match ${h1.slice(0, 12)}` : "MD5 DIFFER";
    if (!identical) {
      // The documented fallback, computed only where it is needed.
      const [s1, s2] = await Promise.all([
        decodedStreamHash(out1),
        decodedStreamHash(out2),
      ]);
      renders += s1 === s2 ? ", streamhash match" : ", STREAMHASH DIFFER";
      console.log(`    md5 ${h1} vs ${h2}`);
      console.log(`    streamhash ${s1} vs ${s2}`);
    }

    console.log(
      `    ${spec.kind}  plan.shots=${plan.shots.length}  ${layoutMix(plan)}  ` +
        `graph=${spec.graph.length}B md5:${md5(Buffer.from(spec.graph, "utf-8")).slice(0, 12)}`
    );
    console.log(`    renders: ${renders}`);

    rows.push({
      id: item.id,
      source: `${width}x${height}`,
      shots: shots.length,
      planShots: String(plan.shots.length),
      layouts: layoutMix(plan),
      renders,
      elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    });
  }

  console.log("\n=== baseline ===");
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(14)} ${r.source.padEnd(10)} shots=${String(r.shots).padEnd(3)} ` +
        `plan=${r.planShots.padEnd(3)} ${r.layouts.padEnd(34)} ${r.renders.padEnd(30)} ${r.elapsed}`
    );
  }
  console.log(
    `\n${rows.length} measured, ${missing.length} not on disk, ` +
      `${noPlan.length} with plan:null, ${rendered} rendered twice`
  );
  if (rendered === 0) {
    console.log("determinism: no renders happened, nothing to conclude");
  } else if (mismatched.length === 0) {
    console.log(
      `determinism: full-file md5 IS a usable invariant - ${rendered}/${rendered} ` +
        "items hashed identically across two encodes"
    );
  } else {
    console.log(
      `determinism: full-file md5 is NOT usable - ${mismatched.length}/${rendered} ` +
        `items differed (${mismatched.join(", ")}). Later comparisons must use ` +
        "decoded streamhash plus the filtergraph string."
    );
  }
  // A missing fixture is a real gap in the baseline, so it must not exit 0 and
  // let a caller believe the corpus was fully captured.
  if (missing.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
