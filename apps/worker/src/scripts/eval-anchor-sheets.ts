/**
 * Frame strips for the four cases that decide the small-face anchoring change.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-anchor-sheets.ts"
 *
 * `eval-blind-centre.ts` answers "how much delivered clip time is framed on
 * nothing". It cannot answer "is the window now on a PERSON" - a window that
 * moved off the table and onto a wall scores identically. That question has
 * only ever been answerable by looking, so this writes the pictures:
 * `.corpus/sheets/<case>.png`, six frames rendered THROUGH the real
 * filtergraph, left to right across the clip.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR CASES, AND WHY EACH ONE
 * ---------------------------------------------------------------------------
 *
 *   two-shot     the defect that started this. Two men at 5.2% and 5.5% of
 *                frame width at opposite ends of a podcast table, with the
 *                window centred on the table between them.
 *   vlog-arctic  the worst case FOR the rule. Three figures spread across 53%
 *                of frame width, all under the guard, so `bestFaceGroup` must
 *                pick a subset - and may pick the wrong person.
 *   booster-cs2  the worst case AGAINST the rule. A 3.1% webcam face on a
 *                `stream_no_rect` clip - exactly what the guard exists for. The
 *                design claims the `normal_face` condition makes this
 *                unreachable. This renders it rather than trusting that.
 *   sitcom-multi a second real source, for breadth, and the only one that is
 *                not 1080p.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RENDERS, AND WHY IT IS NOT SIX SINGLE-FRAME GRABS
 * ---------------------------------------------------------------------------
 *
 * The plan's `enable` windows and its piecewise x(t) are functions of the
 * CLIP-RELATIVE timestamp. Input seeking (`-ss` before `-i`) rebases output
 * timestamps to ~0, so grabbing one frame at t=40 with its own `-ss` activates
 * the FIRST shot's geometry, whatever the frame's real time - that is the trap
 * `eval-reframe.ts` documents and works around by only claiming to show tile
 * geometry. Here the range is decoded ONCE, in order, with `-ss start -to end`
 * as input options exactly as `detectShots` and `detectFaces` do it, so the
 * filtergraph sees t running 0..duration and every shot's window activates when
 * it should. `fps=6/duration` then thins that to six evenly spaced frames.
 *
 * So the strip shows the DELIVERED crop, with the right shot's geometry on each
 * frame. It is not a picture of the source with a rectangle drawn on it.
 *
 * ---------------------------------------------------------------------------
 * NO LABELS ARE BURNED IN
 * ---------------------------------------------------------------------------
 *
 * `drawtext` has no font configured in this image and fails the whole graph.
 * The per-case geometry - source size, profile class, and every shot's layout -
 * is printed to stdout instead, and the reader pairs it with the strip.
 *
 * Read-only: no database writes, no R2 writes, no job touched. `motion: false`
 * is passed explicitly - the camera layer is a different change and must not be
 * smuggled into these pictures.
 */
import { execFile } from "child_process";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import { getPresignedDownloadUrl, prisma } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { resolveCamRect } from "../reframe/cam-rect";
import { DEFAULT_CAMERA } from "../reframe/camera";
import { loadReframeConfig } from "../reframe/config";
import { detectFaces } from "../reframe/faces";
import { buildFiltergraph } from "../reframe/filtergraph";
import { buildCropPlan } from "../reframe/plan";
import { detectShots } from "../reframe/shots";
import type { ShotTracks } from "../reframe/types";
import { corpusDir, corpusPath, loadManifest, type CorpusManifest } from "./corpus-fetch";

const execFileAsync = promisify(execFile);

/** The corpus window `corpus-baseline.ts` uses. Same window on purpose: the
 *  90-second fixtures have a 30-second margin so the tail of a render does not
 *  depend on how yt-dlp cut the last GOP, and a strip taken over a different
 *  window could not be laid beside those baselines. */
const CORPUS_START_SEC = 0;
const CORPUS_END_SEC = 60;

/** Six frames, 270x480 each. Wide enough to see who is in frame, narrow enough
 *  that the whole strip fits on a screen at 1:1. */
const FRAMES = 6;
const TILE_W = 270;
const TILE_H = 480;

/** Generous, for the same reason `corpus-baseline.ts` is generous: nobody is
 *  waiting on this, and a detector timeout would record a `plan: null` - i.e. a
 *  legacy centre crop - as if it were the engine's answer. */
const SHOTS_TIMEOUT_MS = 300_000;
const FACES_TIMEOUT_MS = 300_000;
const RENDER_TIMEOUT_MS = 900_000;

interface CaseSpec {
  id: string;
  why: string;
  /** A corpus fixture on disk, or a real delivered clip found by title. */
  source: { kind: "corpus"; item: string } | { kind: "clip"; titleContains: string };
}

const CASES: CaseSpec[] = [
  {
    id: "two-shot",
    why: "the defect: two men at 5.2%/5.5%, window on the table between them",
    source: { kind: "clip", titleContains: "надежда на быструю смерть" },
  },
  {
    id: "vlog-arctic",
    why: "worst case FOR the rule: three figures across 53% of frame width",
    source: { kind: "corpus", item: "vlog-arctic" },
  },
  {
    id: "booster-cs2",
    why: "worst case AGAINST the rule: 3.1% webcam face, stream_no_rect",
    source: { kind: "clip", titleContains: "Обычный вопрос обернулся" },
  },
  {
    id: "sitcom-multi",
    why: "a second real source, for breadth; the only non-1080p one",
    source: { kind: "corpus", item: "sitcom-multi" },
  },
];

/**
 * Source dimensions.
 *
 * `-read_intervals` so that ffprobe seeks to the clip instead of demuxing a
 * two-hour remote file from byte zero. Harmless on a local fixture.
 */
async function probe(
  path: string,
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
      path,
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

async function resolveSource(
  spec: CaseSpec,
  manifest: CorpusManifest
): Promise<{ path: string; start: number; end: number; label: string }> {
  if (spec.source.kind === "corpus") {
    return {
      path: corpusPath(manifest, spec.source.item),
      start: CORPUS_START_SEC,
      end: CORPUS_END_SEC,
      label: `${spec.source.item}.mp4`,
    };
  }
  const clip = await prisma.clip.findFirst({
    where: { title: { contains: spec.source.titleContains } },
    select: {
      id: true,
      title: true,
      startTime: true,
      endTime: true,
      job: { select: { normalizedArtifactKey: true } },
    },
  });
  if (!clip?.job?.normalizedArtifactKey) {
    throw new Error(`no clip / no artifact for ${JSON.stringify(spec.source.titleContains)}`);
  }
  return {
    path: await getPresignedDownloadUrl(clip.job.normalizedArtifactKey, 7200),
    start: clip.startTime,
    end: clip.endTime,
    label: `${clip.id} ${clip.title}`,
  };
}

/** One line per shot, in plan order. Every layout prints every x it carries -
 *  a `split` whose two tiles sit 6px apart and a `single` are the same word
 *  otherwise, and the strip alone cannot always tell them apart. */
function describeShot(s: import("../reframe/types").ShotLayout): string {
  const span = `${s.start.toFixed(2)}-${s.end.toFixed(2)}s`.padEnd(18);
  switch (s.layout) {
    case "center":
      return `${span}center  x=${s.x}`;
    case "single":
      return `${span}single  x=${s.x}${s.xs ? `  xs=${s.xs.length}kf` : ""}`;
    case "split":
      return `${span}split   top.x=${s.top.x} bottom.x=${s.bottom.x}`;
    case "stream":
      return `${span}stream  cam.x=${s.cam.x} content.x=${s.content.x}`;
  }
}

async function renderSheet(
  path: string,
  start: number,
  end: number,
  spec: ReturnType<typeof buildFiltergraph>,
  outPng: string
): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "clipclap-sheet-"));
  try {
    // Every plan's base chain ends in `scale=1080:1920`, so in principle the
    // four cases already share an output size. The scale+pad is here anyway:
    // it costs nothing, it survives a future graph that does not, and `hstack`
    // / `tile` refuse mismatched inputs outright rather than adapting - which
    // would fail on the 640x352 sitcom, the one source that is not 1080p.
    // `setsar=1` twice for the same reason it appears in the stream branch: a
    // scale derives SAR from the crop aspect, and a non-square SAR reaching
    // `tile` assembles the strip from differently-shaped pixels.
    const post =
      `setsar=1,fps=${(FRAMES / (end - start)).toFixed(6)},` +
      `scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,` +
      `pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const args = [
      "-nostdin", "-v", "error",
      // Input options, exactly as detectShots/detectFaces use them: the range
      // is decoded once, in order, and the filtergraph sees clip-relative t.
      "-ss", String(start),
      "-to", String(end),
      "-i", path,
    ];
    if (spec.kind === "vf") {
      args.push("-vf", `${spec.graph},${post}`);
    } else {
      args.push(
        "-filter_complex", `${spec.graph};[vout]${post}[sheet]`,
        "-map", "[sheet]"
      );
    }
    args.push("-frames:v", String(FRAMES), join(workDir, "f%02d.png"), "-y");
    await execFileAsync("ffmpeg", args, {
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: CHILD_MAX_BUFFER_BYTES,
    });
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-v", "error",
        "-pattern_type", "glob", "-i", join(workDir, "f*.png"),
        "-filter_complex", `tile=${FRAMES}x1`,
        "-frames:v", "1", outPng, "-y",
      ],
      { timeout: RENDER_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const outDir = join(corpusDir(manifest), "sheets");
  await mkdir(outDir, { recursive: true });

  for (const spec of CASES) {
    console.log(`\n=== ${spec.id} - ${spec.why}`);
    try {
      const { path, start, end, label } = await resolveSource(spec, manifest);
      const { width: W, height: H } = await probe(path, start);
      console.log(`  source        : ${label}`);
      console.log(`  range         : ${start.toFixed(2)}-${end.toFixed(2)}s (${(end - start).toFixed(2)}s)`);
      console.log(`  dimensions    : ${W}x${H}`);

      const shots = await detectShots(path, start, end, cfg, SHOTS_TIMEOUT_MS);
      const tracks: ShotTracks[] = await detectFaces(
        path, start, end, shots, W, H, cfg, FACES_TIMEOUT_MS
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
          // Explicit: the camera layer is a different change, and a strip that
          // silently had it on would not be evidence about this one.
          motion: false,
          camera: DEFAULT_CAMERA,
        },
        cam
      );
      console.log(
        `  camRect       : ${cam.rect ? `${cam.rect.w}x${cam.rect.h}+${cam.rect.x}+${cam.rect.y} score=${cam.rect.score.toFixed(2)}` : `none (${cam.reason})`}`
      );
      if (!plan) {
        console.log("  profile       : NO PLAN - legacy centre crop for the whole clip");
        continue;
      }
      const p = plan.profile;
      console.log(
        `  profile       : class=${p?.class ?? "unknown"} faceFrac=${((p?.faceFrac ?? 0) * 100).toFixed(1)}%` +
          `${p?.reason ? ` reason=${p.reason}` : ""}`
      );
      // The widest surviving face per shot, printed beside the layout it got:
      // "class=normal_face" is a clip-level fact and says nothing about whether
      // THIS shot's window had a face over the guard to point at.
      console.log(`  shots (${plan.shots.length})`);
      for (const s of plan.shots) console.log(`    ${describeShot(s)}`);

      const outPng = join(outDir, `${spec.id}.png`);
      await renderSheet(path, start, end, buildFiltergraph(plan), outPng);
      console.log(`  wrote         : ${outPng}`);
    } catch (error) {
      console.log(`  ! FAILED: ${(error as Error).message.slice(0, 200)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
