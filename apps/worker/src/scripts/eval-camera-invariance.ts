/**
 * Check 1 of the Layer 0 measurement plan: with `REFRAME_MOTION` off, nothing
 * changed.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-camera-invariance.ts"
 *
 * This is the script that tries to FALSIFY the single load-bearing claim of the
 * camera branch. It is a verification tool, not a feature.
 *
 * Three levels of evidence, weakest first:
 *
 *   Level 1 - the crop plans already persisted in Postgres. Needs no video, no
 *             corpus and no network, so it is the level that can run on every
 *             change, and the only one that guards REAL production data: those
 *             rows are re-compiled on every retrim and every re-render, so a
 *             regression here is a regression users would see.
 *   Level 2 - replay of the detector output captured by corpus-baseline.ts.
 *             Proves the PLANNER is unchanged, which level 1 cannot see because
 *             a stored plan is an output of the planner, not an input to it.
 *   Level 3 - full renders, compared to the pre-change baseline by md5. The
 *             only level that speaks about pixels rather than about strings.
 *
 * **Levels 2 and 3 need the corpus, and the corpus does not exist yet** - the
 * manifest at assets/reframe/corpus.json has empty `url` fields awaiting a
 * human. They therefore SKIP, loudly and by name, and the summary states which
 * levels actually ran. Three green lines where two of them checked nothing is
 * worse than no script at all, so the summary never prints "ok" for a level
 * that had nothing to look at.
 *
 * Read-only against both the database and R2: it opens no job, writes no row,
 * uploads nothing. Level 3 writes one scratch mp4 per corpus item under the
 * corpus dir, which is gitignored and outside R2.
 */
import { prisma } from "@clipclap/shared";
import { execFile } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { Prisma } from "@prisma/client";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { buildFiltergraph } from "../reframe/filtergraph";
import { buildCropPlan } from "../reframe/plan";
import { resolveCamRect } from "../reframe/cam-rect";
import { corpusDir, corpusPath, loadManifest } from "./corpus-fetch";
import { loadReframeConfig } from "../reframe/config";
import type {
  CropPlan,
  FilterSpec,
  Shot,
  ShotLayout,
  ShotTracks,
} from "../reframe/types";

const execFileAsync = promisify(execFile);

function md5(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("md5");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/** Key-sorted JSON, so that two structurally equal plans compare equal whatever
 *  order their keys were built in. Level 2 compares a freshly built object
 *  against one that has been through a file, and insertion order is not part of
 *  the claim being tested. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : v
  );
}

// ---------------------------------------------------------------------------
// The frozen legacy compiler.
//
// Everything from here to `legacyFiltergraph`'s closing brace is a VERBATIM
// transcription of `apps/worker/src/reframe/filtergraph.ts` and the three
// geometry helpers as they stand on `main`, i.e. before this branch existed.
// It is deliberately a copy and not an import:
//
//   - importing `buildFiltergraph` and comparing it to itself proves nothing;
//   - importing the geometry helpers would let a changed crop width move both
//     sides of the comparison together, which is exactly the failure mode this
//     check exists to catch.
//
// It is frozen. Nothing here may be refactored in sympathy with the module it
// mirrors - the moment it tracks the live code, it stops being an oracle. If a
// future change to the compiler is INTENDED to change what stored plans render
// to, that change belongs in a plan of its own and this copy stays as it is so
// the diff is visible.
// ---------------------------------------------------------------------------

const legacyCropWidthFor = (sourceHeight: number) =>
  2 * Math.round((sourceHeight * 9) / 16 / 2);

const legacyTileWidthFor = (sourceHeight: number) =>
  2 * Math.round((sourceHeight * 9) / 8 / 2);

function legacyEvenClamp(x: number, cropW: number, sourceWidth: number): number {
  const clamped = Math.min(Math.max(0, x), sourceWidth - cropW);
  return 2 * Math.round(clamped / 2);
}

const legacyFmt = (n: number) => n.toFixed(2);

function legacyPiecewiseX(segments: Array<{ end: number; x: number }>): string {
  if (segments.length === 0) throw new Error("piecewiseX: empty");
  let expr = String(segments[segments.length - 1].x);
  for (let i = segments.length - 2; i >= 0; i--) {
    expr = `if(lt(t,${legacyFmt(segments[i].end)}),${segments[i].x},${expr})`;
  }
  return expr;
}

type SplitLayout = Extract<ShotLayout, { layout: "split" }>;
type StreamLayout = Extract<ShotLayout, { layout: "stream" }>;

function legacyFiltergraph(plan: CropPlan, assSnippet?: string): FilterSpec {
  const cropW = legacyCropWidthFor(plan.source.height);
  const tileW = legacyTileWidthFor(plan.source.height);
  const centerX = legacyEvenClamp(
    (plan.source.width - cropW) / 2,
    cropW,
    plan.source.width
  );
  const splits = plan.shots.filter((s): s is SplitLayout => s.layout === "split");

  const baseX = legacyPiecewiseX(
    plan.shots.map((s) => ({
      end: s.end,
      x: s.layout === "split" || s.layout === "stream" ? centerX : s.x,
    }))
  );
  const baseChain = `crop=w=${cropW}:h=ih:x='${baseX}':y=0,scale=1080:1920`;

  const streams = plan.shots.filter(
    (s): s is StreamLayout => s.layout === "stream"
  );
  if (streams.length > 0) {
    const geom = plan.stream;
    if (geom) {
      let lastCam = streams[0].cam.x;
      let lastContent = streams[0].content.x;
      const camSegs: Array<{ end: number; x: number }> = [];
      const contentSegs: Array<{ end: number; x: number }> = [];
      for (const s of plan.shots) {
        if (s.layout === "stream") {
          lastCam = s.cam.x;
          lastContent = s.content.x;
        }
        camSegs.push({ end: s.end, x: lastCam });
        contentSegs.push({ end: s.end, x: lastContent });
      }
      const enable = streams
        .map((s) => `gte(t,${legacyFmt(s.start)})*lt(t,${legacyFmt(s.end)})`)
        .join("+");
      const chains = [
        `[0:v]split=3[b0][c0][m0]`,
        `[b0]${baseChain}[base]`,
        `[c0]crop=w=${geom.camCrop.w}:h=${geom.camCrop.h}:x='${legacyPiecewiseX(camSegs)}':y=${geom.camCrop.y},scale=1080:${geom.outCamH},setsar=1[cam]`,
        `[m0]crop=w=${geom.contentCrop.w}:h=ih:x='${legacyPiecewiseX(contentSegs)}':y=0,scale=1080:${geom.outContentH},setsar=1[cont]`,
        `[base][cam]overlay=x=0:y=0:enable='${enable}'[o1]`,
        assSnippet
          ? `[o1][cont]overlay=x=0:y=${geom.outCamH}:enable='${enable}'[o2]`
          : `[o1][cont]overlay=x=0:y=${geom.outCamH}:enable='${enable}'[vout]`,
      ];
      if (assSnippet) chains.push(`[o2]${assSnippet}[vout]`);
      return { kind: "complex", graph: chains.join(";") };
    }
    // The live compiler console.warn()s here before falling through. The warning
    // is not part of the rendered output, so this copy stays silent rather than
    // doubling every line of it.
  }

  if (splits.length === 0) {
    const ass = assSnippet ? `,${assSnippet}` : "";
    return { kind: "vf", graph: `${baseChain}${ass}` };
  }

  let lastTop = splits[0].top.x;
  let lastBottom = splits[0].bottom.x;
  const topSegs: Array<{ end: number; x: number }> = [];
  const botSegs: Array<{ end: number; x: number }> = [];
  for (const s of plan.shots) {
    if (s.layout === "split") {
      lastTop = s.top.x;
      lastBottom = s.bottom.x;
    }
    topSegs.push({ end: s.end, x: lastTop });
    botSegs.push({ end: s.end, x: lastBottom });
  }
  const enable = splits
    .map((s) => `gte(t,${legacyFmt(s.start)})*lt(t,${legacyFmt(s.end)})`)
    .join("+");

  const chains = [
    `[0:v]split=3[b0][t0][m0]`,
    `[b0]${baseChain}[base]`,
    `[t0]crop=w=${tileW}:h=ih:x='${legacyPiecewiseX(topSegs)}':y=0,scale=1080:960[top]`,
    `[m0]crop=w=${tileW}:h=ih:x='${legacyPiecewiseX(botSegs)}':y=0,scale=1080:960[bottom]`,
    `[base][top]overlay=x=0:y=0:enable='${enable}'[o1]`,
    assSnippet
      ? `[o1][bottom]overlay=x=0:y=960:enable='${enable}'[o2]`
      : `[o1][bottom]overlay=x=0:y=960:enable='${enable}'[vout]`,
  ];
  if (assSnippet) chains.push(`[o2]${assSnippet}[vout]`);
  return { kind: "complex", graph: chains.join(";") };
}

/** A compile attempt, including the failure. A malformed stored plan that threw
 *  before this branch must still throw the same way after it - "both refuse it
 *  identically" is invariance too, and swallowing the throw would silently
 *  excuse whichever plans are hardest to compile. */
function attempt(fn: () => FilterSpec): { spec?: FilterSpec; error?: string } {
  try {
    return { spec: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Stands in for the burned-subtitle chain. Level 1 compiles every stored plan
 *  twice, once bare and once with this, because the real render path always
 *  passes an ass snippet and it lands on a DIFFERENT branch of the compiler
 *  (`,ass` on the vf path, an extra `[o2]` link on the complex one). A check
 *  that only ever compiled bare plans would be blind to half the code it is
 *  guarding. The exact text does not matter, only that it is non-empty and
 *  identical on both sides. */
const ASS_PROBE = "ass='/probe.ass'";

async function level1(): Promise<{ checked: number; bad: number }> {
  // 84 rows today, not the 96 the plan document quotes: 96 is every Clip row
  // holding a plan, 12 of which are soft-deleted and will never be compiled
  // again. Live rows only, so the number this prints is the number of plans a
  // regression could actually reach.
  const clips = await prisma.clip.findMany({
    where: {
      deletedAt: null,
      // Prisma needs DbNull rather than null to filter a nullable Json column.
      // `not: null` compiles under tsx and fails tsc; that has bitten this repo
      // before, so it is spelled out rather than inferred.
      cropPlan: { not: Prisma.DbNull },
    },
    select: { id: true, cropPlan: true },
  });

  let ramps = 0;
  let drifted = 0;
  /** Of `drifted`, how many are explained entirely by the setsar insertion. */
  let driftedSetsarOnly = 0;
  let threw = 0;
  const shown: string[] = [];
  const note = (line: string) => {
    if (shown.length < 20) shown.push(line);
  };

  for (const clip of clips) {
    const plan = clip.cropPlan as unknown as CropPlan;

    // Assertion A - the ramp form was not selected.
    //
    // A stored plan predates `xs` and cannot carry one, so `hasTrajectory` must
    // be false for it and the base crop must compile through `piecewiseX`.
    // `clip(` appears in the output of `rampX` and nowhere else in this
    // compiler, so its presence is proof the new branch was taken.
    const live = attempt(() => buildFiltergraph(plan));
    const liveAss = attempt(() => buildFiltergraph(plan, ASS_PROBE));
    if (live.spec?.graph.includes("clip(") || liveAss.spec?.graph.includes("clip(")) {
      ramps += 1;
      note(`  ! ${clip.id}: stored plan compiled through the ramp form`);
    }

    // Assertion B - the compiled graph is what it was BEFORE this branch.
    //
    // The old code cannot be re-run, but it can be re-stated: `legacyFiltergraph`
    // above is a frozen transcription of the compiler as it stands on `main`,
    // carrying its own copies of the geometry helpers so that no shared function
    // can move both sides at once. Every stored plan is compiled through both and
    // the two results must be byte-identical, kind included, with and without a
    // subtitle snippet.
    //
    // This is strictly stronger than assertion A: A only rules out the one new
    // branch, B pins every character of the output - crop width, tile width,
    // centre x, the two-decimal time format, the order of the chains and the
    // labels between them. A rename of `[vout]`, a third decimal in `fmt`, an
    // off-by-two in `evenClamp` all fail B and pass A.
    //
    // What it does NOT prove, stated because an over-read check is worse than a
    // missing one:
    //   - that the transcription is faithful. It was copied from
    //     `git show main:apps/worker/src/reframe/filtergraph.ts`, but a
    //     mis-transcription that happened to match the live code would pass. The
    //     falsification test recorded in the task log covers the reverse
    //     direction only.
    //   - that identical graph strings render identical pixels. That is ffmpeg's
    //     determinism, and it is level 3 that measures it.
    //   - anything about plans that do not exist yet. A v3 plan is SUPPOSED to
    //     compile differently; this level speaks only about the 96 rows that
    //     were written before the branch.
    //   - anything about the planner, the trim path (`sliceCropPlan`) or the
    //     orchestrator. Level 2 owns the planner; nothing here owns the rest.
    for (const [label, a, b] of [
      ["bare", live, attempt(() => legacyFiltergraph(plan))],
      ["with subtitles", liveAss, attempt(() => legacyFiltergraph(plan, ASS_PROBE))],
    ] as const) {
      if (a.error || b.error) {
        if (a.error !== b.error) {
          drifted += 1;
          note(
            `  ! ${clip.id} (${label}): live ${a.error ?? "compiled"} / legacy ${b.error ?? "compiled"}`
          );
        } else {
          threw += 1;
        }
        continue;
      }
      if (a.spec!.kind !== b.spec!.kind || a.spec!.graph !== b.spec!.graph) {
        drifted += 1;
        // Classify the difference, because only 20 lines are ever printed and
        // "276 differences" with seven examples is a claim, not a measurement.
        // A difference explained entirely by inserting `,setsar=1` after each
        // scale is the 2026-08-08 geometry change (engine-notes §7h) showing
        // itself exactly as this file's freeze rule intends; anything else is a
        // second, unexplained change hiding inside that count. The tally below
        // is what separates them, and it covers every row rather than the
        // sample.
        const explained =
          a.spec!.kind === b.spec!.kind &&
          b.spec!.graph.replace(
            /scale=1080:(\d+)(?!,setsar)/g,
            "scale=1080:$1,setsar=1"
          ) === a.spec!.graph;
        if (explained) driftedSetsarOnly += 1;
        note(`  ! ${clip.id} (${label}): compiled graph differs from the legacy compiler`);
        note(`      legacy: ${b.spec!.graph.slice(0, 160)}`);
        note(`      live  : ${a.spec!.graph.slice(0, 160)}`);
      }
    }
  }

  console.log("1. persisted plans - the level that needs no video");
  console.log(`   stored plans compiled         : ${clips.length}`);
  console.log(`   selected the ramp form        : ${ramps}  (must be 0)`);
  console.log(`   differ from the legacy compiler: ${drifted}  (must be 0)`);
  if (drifted > 0) {
    console.log(
      `     of those, explained by ,setsar=1 : ${driftedSetsarOnly}` +
        (driftedSetsarOnly === drifted
          ? "  (ALL of them - the 2026-08-08 geometry change, engine-notes 7h)"
          : `  <- ${drifted - driftedSetsarOnly} are NOT, and those are unexplained`)
    );
  }
  if (threw > 0) {
    console.log(`   rejected identically by both  : ${threw}  (not a difference)`);
  }
  for (const line of shown) console.error(line);
  return { checked: clips.length, bad: ramps + drifted };
}

interface Captured {
  shots: Shot[];
  tracks: ShotTracks[];
  plan: CropPlan | null;
  source: { width: number; height: number };
  clip: { start: number; end: number };
}

async function readCapture(dir: string, id: string): Promise<Captured | null> {
  const raw = await readFile(join(dir, `${id}.plan.json`), "utf-8").catch(
    () => null
  );
  return raw ? (JSON.parse(raw) as Captured) : null;
}

async function main() {
  const cfg = loadReframeConfig();
  if (cfg.motion) {
    console.error(
      "REFRAME_MOTION is on. This check only means anything with the flag OFF - " +
        "with it on, a plan is SUPPOSED to differ, and every level below would " +
        "report a difference that is not a regression."
    );
    process.exit(1);
  }

  const manifest = await loadManifest();
  const dir = corpusDir(manifest);
  const awaitingUrl = manifest.items.filter((i) => !i.url).length;

  const one = await level1();
  console.log("");

  // --- Level 2: replay the captured detector output through the planner.
  let level2Ran = 0;
  let level2Bad = 0;
  let captures = 0;
  console.log("2. replay of captured detector output - the planner is unchanged");
  for (const item of manifest.items) {
    const cap = await readCapture(dir, item.id);
    if (!cap) continue;
    captures += 1;
    if (!cap.plan) continue;
    level2Ran += 1;
    // The same cam resolution the capture ran with, recomputed from the captured
    // per-shot rects rather than passed as null: a stream source planned with
    // `cam: null` would differ for a reason that has nothing to do with motion,
    // and a false failure here would train the reader to ignore this level.
    const cam = resolveCamRect(
      cap.tracks.map((t) => t.camRect),
      cap.source.width,
      cap.source.height
    );
    const replayed = buildCropPlan(
      cap.shots,
      cap.tracks,
      cap.source.width,
      cap.source.height,
      {
        faceSmallFrac: cfg.faceSmallFrac,
        faceLargeFrac: cfg.faceLargeFrac,
        stream: cfg.stream,
        camShare: cfg.camShare,
        motion: cfg.motion,
        camera: cfg.camera,
      },
      cam
    );
    if (canonical(replayed) !== canonical(cap.plan)) {
      level2Bad += 1;
      console.error(`  ! ${item.id}: replayed plan differs from the captured one`);
    }
  }
  if (captures === 0) {
    console.log(`   SKIPPED - no <id>.plan.json under ${dir}`);
    console.log(
      `   corpus-baseline.ts has not run, and it cannot: ${awaitingUrl} of ` +
        `${manifest.items.length} manifest items still have an empty url ` +
        `awaiting a human (apps/worker/assets/reframe/corpus.json).`
    );
  } else {
    console.log(`   captures found                : ${captures}`);
    console.log(`   plans replayed                : ${level2Ran}`);
    console.log(`   differ from the captured plan : ${level2Bad}  (must be 0)`);
  }
  console.log("");

  // --- Level 3: re-render with the flag off and compare to the baseline.
  let level3Ran = 0;
  let level3Bad = 0;
  let baselines = 0;
  console.log("3. full renders against the pre-change baseline");
  for (const item of manifest.items) {
    const baseline = join(dir, `${item.id}.base1.mp4`);
    const baseHash = await md5(baseline).catch(() => null);
    const cap = await readCapture(dir, item.id);
    if (!baseHash || !cap) continue;
    baselines += 1;
    if (!cap.plan) continue;
    level3Ran += 1;
    const spec = buildFiltergraph(cap.plan);
    // Scratch output beside the baseline, inside the gitignored corpus dir.
    // Overwritten on every run and never uploaded anywhere.
    const out = join(dir, `${item.id}.flagoff.mp4`);
    const filterArgs =
      spec.kind === "vf"
        ? ["-vf", spec.graph]
        : ["-filter_complex", spec.graph, "-map", "[vout]", "-map", "0:a?"];
    // Byte-for-byte the encode corpus-baseline.ts used. Any difference in the
    // encoder arguments changes the md5 on its own and would report a
    // regression that is entirely this script's fault.
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-ss", String(cap.clip.start),
        "-t", String(cap.clip.end - cap.clip.start),
        "-i", corpusPath(manifest, item.id),
        ...filterArgs,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart", out, "-y",
      ],
      { maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    if ((await md5(out)) !== baseHash) {
      level3Bad += 1;
      console.error(`  ! ${item.id}: render differs from the baseline`);
    }
  }
  if (baselines === 0) {
    console.log(`   SKIPPED - no <id>.base1.mp4 under ${dir}`);
    console.log(
      "   The baseline renders are produced by corpus-baseline.ts from the " +
        "materialised corpus, and there is no way to re-derive them after the " +
        "fact. Until a human fills in the manifest urls, this level has nothing " +
        "to compare against."
    );
  } else {
    console.log(`   baselines found               : ${baselines}`);
    console.log(`   renders compared              : ${level3Ran}`);
    console.log(`   differ from the baseline      : ${level3Bad}  (must be 0)`);
  }
  console.log("");

  // The summary exists to stop a skipped level reading as a passed one.
  const verdict = (ran: boolean, bad: number, what: string) =>
    !ran ? `SKIPPED - ${what}` : bad === 0 ? `ok     - ${what}` : `FAILED - ${what}`;
  console.log("summary");
  console.log(
    `   level 1  ${verdict(true, one.bad, `${one.checked} persisted plans, ${one.bad} differences`)}`
  );
  console.log(
    `   level 2  ${verdict(captures > 0, level2Bad, captures > 0 ? `${level2Ran} plans replayed, ${level2Bad} differences` : "no captured detector output")}`
  );
  console.log(
    `   level 3  ${verdict(baselines > 0, level3Bad, baselines > 0 ? `${level3Ran} renders compared, ${level3Bad} differences` : "no baseline renders")}`
  );
  const ranCount = 1 + (captures > 0 ? 1 : 0) + (baselines > 0 ? 1 : 0);
  const anyFailed = one.bad + level2Bad + level3Bad > 0;
  console.log("");
  // The claim is CONDITIONAL on the levels having passed, not merely on their
  // having run. §7e recorded this sentence as an overclaim once already; after
  // the 2026-08-08 geometry change it would have printed "evidenced at every
  // level, up to and including pixels" directly beneath the word FAILED, which
  // is how a reader ends up quoting a green summary from a red run.
  console.log(
    anyFailed
      ? `${ranCount} of 3 levels actually ran, and at least one FAILED above - nothing here is evidence of invariance until that is explained.`
      : `${ranCount} of 3 levels actually ran. "flag off changes nothing" is evidenced ` +
          (ranCount === 3
            ? "at every level, up to and including pixels."
            : ranCount === 1
              ? "for the compiled graph of already-stored plans ONLY. The planner and the rendered pixels are unmeasured."
              : "in part; the levels marked SKIPPED above measured nothing.")
  );

  await prisma.$disconnect();
  const bad = one.bad + level2Bad + level3Bad;
  if (bad > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
