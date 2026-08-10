/**
 * Output geometry guard: every clip must be 1080x1920 with SQUARE pixels.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-clip-geometry.ts"
 *
 * Exits non-zero when anything does not match, so it can be run as a check
 * rather than read as a report.
 *
 * WHY THIS EXISTS
 * ---------------
 *
 * The owner reported a clip looking "not 9:16". Probing the delivered files
 * showed `SAR 1216:1215`, so `DAR 76:135` rather than `9:16`. The cause is
 * arithmetic, not a bug in any one branch: a 9:16 slice of a 1080-tall frame is
 * 607.5px wide, `cropWidthFor` rounds that to an even 608, and the crop is then
 * scaled to exactly 1080x1920. `scale` PRESERVES display aspect - it does not
 * stretch to fill - so it absorbs the 0.08% discrepancy by tagging the output
 * with a non-square SAR instead.
 *
 * 0.08% is under one pixel across the frame and cannot be seen as a stretch.
 * That is precisely why it needs a guard rather than an eye: it is invisible
 * locally, it is wrong in the file, and every downstream platform reads the tag.
 * A player honouring SAR displays the raster as 1080.9x1920, and re-encoders
 * that normalise to square pixels will resample the whole frame to do it.
 *
 * WHAT IS CHECKED, AND ON WHAT
 * ----------------------------
 *
 * Two populations, because neither alone is sufficient:
 *
 * 1. **Delivered clips.** Real product output, read straight from R2 with a
 *    ranged ffprobe - no re-encode, so what is measured is exactly what users
 *    received. This is the ground truth, and it is the only place a defect
 *    introduced outside the filtergraph (the encoder, the container, a later
 *    trim) can show up at all.
 * 2. **Every filter path, synthesised.** The corpus exercises the layouts it
 *    happens to contain. `split`, `stream` and the legacy centre crop may not
 *    appear in it at all, and an unexercised path is not a passing path - it is
 *    an unmeasured one. So each construction is compiled by the REAL
 *    `buildFiltergraph` (or `buildCutArgs` for the legacy fallback), rendered
 *    over one lavfi frame, and probed. A synthetic source is legitimate here
 *    because geometry does not depend on content.
 *
 * The plans handed to `buildFiltergraph` below are written out by hand rather
 * than taken from a real clip: a real plan carries whichever layout that clip
 * used, and the point is to force each branch deliberately.
 *
 * WHAT A FAILURE HERE DOES NOT TELL YOU
 * -------------------------------------
 *
 * Which branch is responsible, when a clip's plan holds more than one layout.
 * A `single` plan is unambiguous; a plan with split shots composites tiles onto
 * a base and the final tag comes from the base. The synthetic section exists to
 * make that attributable.
 *
 * Read-only: no database writes, no R2 writes, no delivered file touched.
 */
import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { getPresignedDownloadUrl, prisma } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { buildCutArgs } from "../processors/cut";
import { buildFiltergraph } from "../reframe/filtergraph";
import type { CropPlan, FilterSpec } from "../reframe/types";

const execFileAsync = promisify(execFile);

/** The target every clip must meet. 9:16 at 1080 wide, square pixels. */
const TARGET_W = 1080;
const TARGET_H = 1920;

/** Delivered clips are sampled from this date forward - the corpus the rest of
 *  the reframe measurements use. Older clips predate several render changes and
 *  a failure on one would say nothing about today's code. */
const SINCE = new Date("2026-08-06T00:00:00Z");

interface Geometry {
  width: number;
  height: number;
  /** ffprobe prints "N/A" when the stream carries no SAR tag at all, which is
   *  NOT the same as 1:1 and must not be silently normalised to it: an untagged
   *  stream is interpreted as square by most players and as unknown by some. */
  sar: string;
  dar: string;
}

async function probeGeometry(path: string): Promise<Geometry> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,sample_aspect_ratio,display_aspect_ratio",
      "-of", "default=nw=1:nk=1",
      path,
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  const [width, height, sar, dar] = stdout.trim().split("\n").map((s) => s.trim());
  return { width: Number(width), height: Number(height), sar, dar };
}

/** SAR is acceptable when it is square. "1:1" and "N/A" are reported apart, so
 *  an untagged stream can never be mistaken for a deliberately square one. */
function squarePixels(sar: string): boolean {
  return sar === "1:1";
}

function verdict(g: Geometry): string[] {
  const bad: string[] = [];
  if (g.width !== TARGET_W || g.height !== TARGET_H) {
    bad.push(`size ${g.width}x${g.height} != ${TARGET_W}x${TARGET_H}`);
  }
  if (!squarePixels(g.sar)) bad.push(`SAR ${g.sar} != 1:1`);
  if (g.dar !== "9:16") bad.push(`DAR ${g.dar} != 9:16`);
  return bad;
}

/** A plan holding exactly one layout, so a synthetic failure is attributable to
 *  one branch of `buildFiltergraph` rather than to a composite. */
function planFor(layout: "center" | "single" | "split" | "stream"): CropPlan {
  const base = {
    version: 1 as const,
    engine: "faces" as const,
    source: { width: 1920, height: 1080 },
  };
  switch (layout) {
    case "center":
      return { ...base, shots: [{ start: 0, end: 5, layout: "center", x: 656 }] };
    case "single":
      return { ...base, shots: [{ start: 0, end: 5, layout: "single", x: 600 }] };
    case "split":
      return {
        ...base,
        shots: [
          { start: 0, end: 5, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
        ],
      };
    case "stream":
      return {
        ...base,
        // Geometry shaped like a real stream plan: a webcam band over content.
        stream: {
          camCrop: { w: 1080, h: 608, y: 0 },
          contentCrop: { w: 1080, h: 1080 },
          outCamH: 608,
          outContentH: 1312,
        },
        shots: [
          {
            start: 0,
            end: 5,
            layout: "stream",
            cam: { x: 0 },
            content: { x: 420 },
          },
        ],
      };
  }
}

/**
 * Renders one frame of a synthetic 1920x1080 source through a filter spec.
 *
 * `testsrc2` rather than a real file: geometry is independent of content, and a
 * generated source cannot go missing or change under the test. The pixel format
 * is forced to yuv420p because that is what the product encodes and because
 * chroma subsampling is what makes odd dimensions illegal in the first place.
 */
async function renderThrough(
  spec: FilterSpec,
  outPath: string
): Promise<void> {
  const filterArgs =
    spec.kind === "vf"
      ? ["-vf", spec.graph]
      : ["-filter_complex", spec.graph, "-map", "[vout]"];
  await execFileAsync(
    "ffmpeg",
    [
      "-nostdin", "-v", "error",
      "-f", "lavfi",
      "-i", "testsrc2=size=1920x1080:rate=25:duration=1",
      ...filterArgs,
      "-frames:v", "1",
      "-pix_fmt", "yuv420p",
      outPath, "-y",
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
}

/**
 * The legacy centre crop, taken from `buildCutArgs` rather than retyped.
 *
 * That path is the `REFRAME_ENGINE=off` behaviour and the failure fallback, so
 * it renders real clips whenever detection fails - and it builds its own filter
 * string that `buildFiltergraph` never sees. Copying `crop=ih*9/16:ih,...` here
 * would test this file's opinion of the fallback instead of the fallback.
 */
function legacyFilterFromCutArgs(): string {
  const args = buildCutArgs("in.mp4", 0, 1, "out.mp4");
  const i = args.indexOf("-vf");
  if (i < 0 || !args[i + 1]) {
    throw new Error("buildCutArgs no longer emits -vf; this probe is stale");
  }
  return args[i + 1];
}

async function main() {
  let failures = 0;

  console.log("=== synthetic: every filter path, one frame each");
  const workDir = await mkdtemp(join(tmpdir(), "clipclap-geom-"));
  try {
    const cases: Array<{ name: string; spec: FilterSpec }> = [
      { name: "legacy centre crop (cut.ts fallback)", spec: { kind: "vf", graph: legacyFilterFromCutArgs() } },
      { name: "reframe center", spec: buildFiltergraph(planFor("center")) },
      { name: "reframe single", spec: buildFiltergraph(planFor("single")) },
      { name: "reframe split", spec: buildFiltergraph(planFor("split")) },
      { name: "reframe stream", spec: buildFiltergraph(planFor("stream")) },
    ];
    for (const c of cases) {
      const out = join(workDir, `${c.name.replace(/\W+/g, "-")}.mp4`);
      try {
        await renderThrough(c.spec, out);
        const g = await probeGeometry(out);
        const bad = verdict(g);
        if (bad.length > 0) failures += 1;
        console.log(
          `  ${bad.length === 0 ? "ok  " : "BAD "} ${c.name.padEnd(38)} ` +
            `${g.width}x${g.height} SAR ${g.sar} DAR ${g.dar}` +
            (bad.length > 0 ? `   <- ${bad.join(", ")}` : "")
        );
      } catch (error) {
        failures += 1;
        console.log(`  ERR  ${c.name.padEnd(38)} ${(error as Error).message.slice(0, 160)}`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log("\n=== delivered clips, read from R2 without re-encoding");
  const clips = await prisma.clip.findMany({
    where: {
      deletedAt: null,
      job: { createdAt: { gte: SINCE } },
    },
    select: { id: true, title: true, storageKey: true, cropPlan: true },
    orderBy: { createdAt: "asc" },
  });

  const byLayout = new Map<string, { n: number; bad: number }>();
  let probed = 0;
  let unreadable = 0;
  const badClips: string[] = [];

  for (const clip of clips) {
    // Which branches this clip's plan actually used, so a failure can be
    // attributed instead of merely counted.
    const plan = clip.cropPlan as CropPlan | null;
    const layouts = plan?.shots
      ? [...new Set(plan.shots.map((s) => s.layout))].sort().join("+")
      : "(no plan - legacy crop)";
    try {
      const url = await getPresignedDownloadUrl(clip.storageKey, 3600);
      const g = await probeGeometry(url);
      probed += 1;
      const bad = verdict(g);
      const row = byLayout.get(layouts) ?? { n: 0, bad: 0 };
      row.n += 1;
      if (bad.length > 0) {
        row.bad += 1;
        badClips.push(
          `${clip.id} ${g.width}x${g.height} SAR ${g.sar} DAR ${g.dar}  ${layouts}  ${bad.join(", ")}`
        );
      }
      byLayout.set(layouts, row);
    } catch (error) {
      unreadable += 1;
      console.log(`  ! ${clip.id}: ${(error as Error).message.slice(0, 120)}`);
    }
  }

  console.log(`  probed ${probed} of ${clips.length} clips (unreadable ${unreadable})`);
  console.log("\n  by the layouts the clip's plan used:");
  for (const [layouts, row] of [...byLayout].sort()) {
    console.log(
      `    ${row.bad === 0 ? "ok  " : "BAD "} ${String(row.n).padStart(3)} clips  ` +
        `${row.bad} wrong   ${layouts}`
    );
  }
  if (badClips.length > 0) {
    failures += badClips.length;
    console.log(`\n  every wrong clip (${badClips.length}):`);
    // Distinct geometries first: 40 identical rows say one thing, and two
    // different wrong values say something else entirely.
    const distinct = new Map<string, number>();
    for (const b of badClips) {
      const key = b.split("  ")[0].split(" ").slice(1).join(" ");
      distinct.set(key, (distinct.get(key) ?? 0) + 1);
    }
    for (const [geom, n] of distinct) console.log(`    ${String(n).padStart(3)}x  ${geom}`);
  }

  console.log(
    failures === 0
      ? "\nPASS - every path and every delivered clip is 1080x1920 with square pixels."
      : `\nFAIL - ${failures} geometry mismatches. Target is ${TARGET_W}x${TARGET_H}, SAR 1:1, DAR 9:16.`
  );

  await prisma.$disconnect();
  if (failures > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
