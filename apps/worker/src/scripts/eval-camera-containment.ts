/**
 * Does a crop window that can move keep the chosen subject in frame better than
 * one that cannot?
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-camera-containment.ts"
 *
 * This is the measurement the whole camera layer exists to produce. Everything
 * else on the branch is machinery; this is the number that decides whether the
 * machinery is worth shipping, INCLUDING when it says no. It exits non-zero when
 * the pass bar is not met, and it tunes nothing to avoid that.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED, AND WHY IT IS NOT "IS THERE A FACE IN THE OUTPUT"
 * ---------------------------------------------------------------------------
 *
 * Running a detector over the delivered frame cannot tell WHICH face it found.
 * A shot that loses the anchored speaker while a bystander stays in shot would
 * score as a success - the failure mode is invisible to exactly the check that
 * looks easiest. So the metric is geometric containment of the anchor the
 * planner itself chose:
 *
 *   1. the captured detector output gives the SELECTED group's bbox at time t
 *   2. the plan gives the crop window at time t:  [x(t), x(t) + cropW)
 *   3. v(t) = overlap(bbox, window) / bbox width
 *   4. v = 1 contained, 0 < v < 1 cut by an edge, v = 0 lost entirely
 *
 * Failure is v(t) < 1.
 *
 * SOURCE PIXELS, before the output scale. The scale is uniform and monotone, so
 * it cannot change containment; testing before it removes an arithmetic step
 * that could only add error. No epsilon is needed on the v = 1 test either: when
 * the bbox is inside the window, `min(maxX, x+cropW) - max(minX, x)` selects the
 * bbox's own two endpoints and the subtraction is the same subtraction as the
 * width, bit for bit.
 *
 * SAMPLED AT THE DETECTOR'S OWN TIMES. At those instants the bbox is a measured
 * value and x(t) is analytic from the trajectory, so no interpolation of the
 * face enters the number. A sample whose time falls in a span with no single
 * window - a split or a stream shot - is EXCLUDED FROM THE DENOMINATOR, not
 * scored as a failure: the metric has nothing to say there, and saying nothing
 * is different from saying "bad".
 *
 * THE SELECTION COMES FROM THE PLANNER. `selectGroupForShot` is called, never
 * re-derived, and never replaced by "every track that happens to have a path".
 * Pooling tracks would score a group the planner never pointed at, which would
 * make the whole exercise a measurement of a different product.
 *
 * BOTH ARMS COME FROM ONE DETECTOR RUN. The captured `<id>.plan.json` is replayed
 * through `buildCropPlan` twice, `motion: false` and `motion: true`, so the only
 * difference between the arms is the planner. The detector is not re-run; if it
 * were, a metric that moved could have moved because the sampler diverged.
 *
 * Read-only: no database, no R2, no writes of any kind, and it does not turn
 * `REFRAME_MOTION` on for anything but its own in-memory second arm.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { resolveCamRect } from "../reframe/cam-rect";
import { loadReframeConfig } from "../reframe/config";
import {
  buildCropPlan,
  buildTargetSamples,
  cropWidthFor,
  selectGroupForShot,
} from "../reframe/plan";
import type {
  CropPlan,
  FaceTrack,
  Keyframe,
  PathSample,
  Shot,
  ShotLayout,
  ShotTracks,
} from "../reframe/types";
import { corpusDir, loadManifest } from "./corpus-fetch";

/** The control item. Its material is one frame held for the whole clip, so a
 *  camera that moves at all there is a camera reacting to detector jitter. */
const CONTROL_ID = "lockedoff-1p";

/** Nothing may regress by more than this many percentage points. */
const MAX_REGRESSION_PP = 2;

/** Only for comparing times and gap lengths, never for comparing v to 1. */
const EPS = 1e-9;

interface Captured {
  shots: Shot[];
  tracks: ShotTracks[];
  plan: CropPlan | null;
  source: { width: number; height: number };
  clip: { start: number; end: number };
}

interface Sample {
  t: number;
  shotIndex: number;
  minX: number;
  maxX: number;
  legacyX: number;
  motionX: number;
  legacyV: number;
  motionV: number;
  group: FaceTrack[];
}

interface Gap {
  seconds: number;
  samples: number;
}

interface ItemResult {
  id: string;
  /** Why an item contributed nothing, when it contributed nothing. */
  note: string | null;
  samples: number;
  excluded: Map<string, number>;
  legacyFails: number;
  motionFails: number;
  legacyGap: Gap;
  motionGap: Gap;
  legacyPartials: number[];
  motionPartials: number[];
  /** First sample that fails under either arm, kept for the worked example. */
  firstFailure: Sample | null;
  /** Non-zero would mean this script's bbox reconstruction disagrees with the
   *  planner's own `buildTargetSamples`, i.e. the metric is not measuring what
   *  the camera was solved against. */
  centreMismatches: number;
}

/** The track's box at `t`: the exact sample if there is one, otherwise the most
 *  recent earlier one, otherwise the earliest. A local copy of the private
 *  `boxAt` in plan.ts - the carry-forward rule has to be the same one
 *  `buildTargetSamples` uses, and every sample's centre is checked against that
 *  function below precisely because this copy could drift from it. */
function boxAt(path: PathSample[], t: number): PathSample {
  let chosen = path[0];
  for (const p of path) {
    if (p.t > t) break;
    chosen = p;
  }
  return chosen;
}

/** The selected group's bounding box at `t`, in source pixels. Null when no
 *  member of the group carries a path at all. */
function groupBoxAt(
  group: FaceTrack[],
  t: number
): { minX: number; maxX: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const track of group) {
    if (!track.path || track.path.length === 0) continue;
    const box = boxAt(track.path, t);
    minX = Math.min(minX, box.x);
    maxX = Math.max(maxX, box.x + box.w);
  }
  return maxX > -Infinity ? { minX, maxX } : null;
}

/** Where the window's left edge sits at `t` under a trajectory: linear between
 *  keyframes, held flat outside them. Mirrors what the filtergraph's ramp
 *  expression evaluates to, which is also what `sliceKeyframes` assumes. */
function xAt(keys: Keyframe[], t: number): number {
  if (t <= keys[0].t) return keys[0].x;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.x;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.x;
      return a.x + ((b.x - a.x) * (t - a.t)) / span;
    }
  }
  return last.x;
}

/** Fraction of the bbox that the window contains. */
function visibleFraction(
  minX: number,
  maxX: number,
  windowX: number,
  cropW: number
): number {
  const width = maxX - minX;
  if (!(width > 0)) return 1;
  const overlap = Math.min(maxX, windowX + cropW) - Math.max(minX, windowX);
  return Math.max(0, Math.min(overlap, width)) / width;
}

/** The plan span covering `t`. Half-open [start, end), except that the final
 *  span keeps its end, so a sample landing exactly on the clip end is not
 *  homeless. */
function spanAt(shots: ShotLayout[], t: number): ShotLayout | null {
  for (const s of shots) {
    if (t >= s.start && t < s.end) return s;
  }
  const last = shots[shots.length - 1];
  return last && Math.abs(t - last.end) < EPS ? last : null;
}

/** The window's left edge for one arm, or null when the span has no single
 *  window to speak of. */
function windowXFor(span: ShotLayout, t: number): number | null {
  if (span.layout === "single") {
    return span.xs && span.xs.length > 0 ? xAt(span.xs, t) : span.x;
  }
  if (span.layout === "center") return span.x;
  return null; // split and stream: two tiles, no single window
}

function bump(counter: Map<string, number>, key: string) {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** Longest run of consecutive FAILING samples inside one shot, as the wall-clock
 *  distance between the run's first and last sample.
 *
 *  Stated exactly because it is easy to over-read: a lone failing sample has a
 *  length of 0 s, since nothing was observed to be broken before it or after it.
 *  The sample count is reported next to the seconds for that reason. Runs never
 *  cross a shot boundary - a different shot is a different anchor and a
 *  different window, so joining them would invent a continuity the plan does not
 *  have. */
function longestGap(samples: Sample[], pick: (s: Sample) => number): Gap {
  let best: Gap = { seconds: 0, samples: 0 };
  let runStart: Sample | null = null;
  let runEnd: Sample | null = null;
  let runCount = 0;
  let runShot = -1;

  const close = () => {
    if (runStart && runEnd) {
      const seconds = runEnd.t - runStart.t;
      if (
        runCount > best.samples ||
        (runCount === best.samples && seconds > best.seconds)
      ) {
        best = { seconds, samples: runCount };
      }
    }
    runStart = null;
    runEnd = null;
    runCount = 0;
  };

  for (const s of samples) {
    const failing = pick(s) < 1;
    if (!failing || s.shotIndex !== runShot) close();
    runShot = s.shotIndex;
    if (!failing) continue;
    if (!runStart) runStart = s;
    runEnd = s;
    runCount += 1;
  }
  close();
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

const pct = (n: number, d: number) => (d === 0 ? NaN : (100 * n) / d);
const fmtPct = (v: number) => (Number.isNaN(v) ? "   -  " : v.toFixed(1).padStart(5) + "%");

async function readCapture(dir: string, id: string): Promise<Captured | null> {
  const raw = await readFile(join(dir, `${id}.plan.json`), "utf-8").catch(
    () => null
  );
  return raw ? (JSON.parse(raw) as Captured) : null;
}

function emptyResult(id: string, note: string): ItemResult {
  return {
    id,
    note,
    samples: 0,
    excluded: new Map(),
    legacyFails: 0,
    motionFails: 0,
    legacyGap: { seconds: 0, samples: 0 },
    motionGap: { seconds: 0, samples: 0 },
    legacyPartials: [],
    motionPartials: [],
    firstFailure: null,
    centreMismatches: 0,
  };
}

async function measure(
  dir: string,
  id: string,
  opts: {
    faceSmallFrac: number;
    faceLargeFrac: number;
    stream: boolean;
    camShare: number;
    camera: ReturnType<typeof loadReframeConfig>["camera"];
  }
): Promise<{ result: ItemResult; detail: string[] }> {
  const detail: string[] = [];
  const cap = await readCapture(dir, id);
  if (!cap) return { result: emptyResult(id, "no capture on disk"), detail };

  const { width, height } = cap.source;
  const cam = resolveCamRect(
    cap.tracks.map((t) => t.camRect),
    width,
    height
  );
  const planOpts = {
    faceSmallFrac: opts.faceSmallFrac,
    faceLargeFrac: opts.faceLargeFrac,
    stream: opts.stream,
    camShare: opts.camShare,
    camera: opts.camera,
  };
  const legacy = buildCropPlan(cap.shots, cap.tracks, width, height, {
    ...planOpts,
    motion: false,
  }, cam);
  const motion = buildCropPlan(cap.shots, cap.tracks, width, height, {
    ...planOpts,
    motion: true,
  }, cam);

  if (!legacy || !motion) {
    return {
      result: emptyResult(id, "planner declined (plan: null, legacy centre crop)"),
      detail,
    };
  }
  // The legacy arm must be the plan that was captured. If it is not, this run's
  // config differs from the baseline's and the two arms are not comparable to
  // anything that shipped.
  const rebuiltMatchesCapture =
    JSON.stringify(legacy) === JSON.stringify(cap.plan);
  // Merging happens before trajectories are attached, so the two arms must agree
  // on span boundaries and layouts exactly; only `xs` may differ. If they do not,
  // every per-sample pairing below is comparing different spans.
  const alignedSpans =
    legacy.shots.length === motion.shots.length &&
    legacy.shots.every(
      (s, i) =>
        s.layout === motion.shots[i].layout &&
        Math.abs(s.start - motion.shots[i].start) < EPS &&
        Math.abs(s.end - motion.shots[i].end) < EPS
    );
  detail.push(
    `    legacy arm == captured plan: ${rebuiltMatchesCapture ? "yes" : "NO"}` +
      `   spans aligned across arms: ${alignedSpans ? "yes" : "NO"}` +
      `   v${legacy.version} -> v${motion.version}`
  );
  if (!rebuiltMatchesCapture || !alignedSpans) {
    return {
      result: emptyResult(
        id,
        !rebuiltMatchesCapture
          ? "legacy rebuild differs from the captured plan - config drift, refusing to score"
          : "arms disagree on span boundaries - refusing to score"
      ),
      detail,
    };
  }

  const cropW = cropWidthFor(height);
  const minFaceWidth = opts.faceSmallFrac * width;
  const byIndex = new Map(cap.tracks.map((s) => [s.shotIndex, s.tracks]));
  const excluded = new Map<string, number>();
  const samples: Sample[] = [];
  let centreMismatches = 0;
  let trajectorySpans = 0;
  let keyframes = 0;
  for (const span of motion.shots) {
    if (span.layout === "single" && span.xs) {
      trajectorySpans += 1;
      keyframes += span.xs.length;
    }
  }

  for (const [i, shot] of cap.shots.entries()) {
    const group = selectGroupForShot(
      byIndex.get(i) ?? [],
      minFaceWidth,
      cropW,
      width
    );
    if (!group) {
      bump(excluded, "shots with no anchorable group");
      continue;
    }
    const targets = buildTargetSamples(group, shot.start, shot.end);
    if (targets.length === 0) {
      bump(excluded, "shots whose group carries no path samples");
      continue;
    }
    const isLast = i === cap.shots.length - 1;
    for (const target of targets) {
      // Shots are contiguous, and buildTargetSamples takes both ends inclusive,
      // so a detection landing exactly on a cut would otherwise be scored twice
      // under two different anchors. The next shot owns it.
      if (!isLast && Math.abs(target.t - shot.end) < EPS) {
        bump(excluded, "samples on a shot boundary (owned by the next shot)");
        continue;
      }
      const box = groupBoxAt(group, target.t);
      if (!box) {
        bump(excluded, "samples with no box for the group");
        continue;
      }
      // The reconstruction above must agree with the planner's own target
      // builder, or this script is measuring a different bbox than the camera
      // was aimed with.
      if (Math.abs((box.minX + box.maxX) / 2 - target.cx) > 1e-6) {
        centreMismatches += 1;
      }
      if (!(box.maxX - box.minX > 0)) {
        bump(excluded, "samples with a zero-width group box");
        continue;
      }
      const legacySpan = spanAt(legacy.shots, target.t);
      const motionSpan = spanAt(motion.shots, target.t);
      if (!legacySpan || !motionSpan) {
        bump(excluded, "samples outside every plan span");
        continue;
      }
      const legacyX = windowXFor(legacySpan, target.t);
      const motionX = windowXFor(motionSpan, target.t);
      if (legacyX === null || motionX === null) {
        bump(excluded, `samples in a ${legacySpan.layout} span (no single window)`);
        continue;
      }
      samples.push({
        t: target.t,
        shotIndex: i,
        minX: box.minX,
        maxX: box.maxX,
        legacyX,
        motionX,
        legacyV: visibleFraction(box.minX, box.maxX, legacyX, cropW),
        motionV: visibleFraction(box.minX, box.maxX, motionX, cropW),
        group,
      });
    }
  }

  samples.sort((a, b) => a.t - b.t || a.shotIndex - b.shotIndex);
  const legacyFails = samples.filter((s) => s.legacyV < 1).length;
  const motionFails = samples.filter((s) => s.motionV < 1).length;
  detail.push(
    `    cropW=${cropW}px of ${width}px  minFace=${minFaceWidth.toFixed(0)}px  ` +
      `spans=${legacy.shots.length}  with trajectory=${trajectorySpans}  keyframes=${keyframes}`
  );

  return {
    result: {
      id,
      note: samples.length === 0 ? "no eligible samples" : null,
      samples: samples.length,
      excluded,
      legacyFails,
      motionFails,
      legacyGap: longestGap(samples, (s) => s.legacyV),
      motionGap: longestGap(samples, (s) => s.motionV),
      legacyPartials: samples.filter((s) => s.legacyV < 1).map((s) => s.legacyV),
      motionPartials: samples.filter((s) => s.motionV < 1).map((s) => s.motionV),
      firstFailure: samples.find((s) => s.legacyV < 1 || s.motionV < 1) ?? null,
      centreMismatches,
    },
    detail,
  };
}

/** One failing sample, spelled out end to end, so the metric has been checked by
 *  hand at least once. A number nobody has ever verified against its own inputs
 *  is a number on trust. */
function workedExample(id: string, s: Sample, cropW: number): string[] {
  const width = s.maxX - s.minX;
  const line = (label: string, x: number, v: number) => {
    const lo = Math.max(s.minX, x);
    const hi = Math.min(s.maxX, x + cropW);
    const overlap = Math.max(0, hi - lo);
    return [
      `    ${label} window   [${x.toFixed(2)}, ${(x + cropW).toFixed(2)})`,
      `      overlap = min(${s.maxX.toFixed(2)}, ${(x + cropW).toFixed(2)}) - max(${s.minX.toFixed(2)}, ${x.toFixed(2)})` +
        ` = ${hi.toFixed(2)} - ${lo.toFixed(2)} = ${overlap.toFixed(2)}`,
      `      v = ${overlap.toFixed(2)} / ${width.toFixed(2)} = ${v.toFixed(4)}` +
        `  ${v < 1 ? (v === 0 ? "LOST" : "cut by an edge") : "contained"}`,
    ].join("\n");
  };
  return [
    `worked example - ${id}, shot ${s.shotIndex}, t = ${s.t.toFixed(3)}s`,
    `    group: ${s.group.length} track(s) ${s.group.map((t) => `#${t.id}`).join(" ")}`,
    ...s.group
      .filter((t) => t.path && t.path.length > 0)
      .map((t) => {
        const b = boxAt(t.path!, s.t);
        return `      #${t.id} box at t=${b.t.toFixed(3)}: x=${b.x.toFixed(2)} w=${b.w.toFixed(2)} -> right edge ${(b.x + b.w).toFixed(2)}`;
      }),
    `    group bbox [${s.minX.toFixed(2)}, ${s.maxX.toFixed(2)}), width ${width.toFixed(2)}px    cropW ${cropW}px`,
    line("legacy", s.legacyX, s.legacyV),
    line("motion", s.motionX, s.motionV),
  ];
}

/** Where the partial-containment values sit, so a softer threshold than v = 1
 *  could later be argued from data instead of picked. */
function distribution(label: string, values: number[]): string[] {
  if (values.length === 0) return [`   ${label.padEnd(7)} no samples below 1`];
  const edges = [0, 0.25, 0.5, 0.75, 1];
  const lost = values.filter((v) => v === 0).length;
  const buckets = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const n = values.filter((v) => (lo === 0 ? v > 0 : v >= lo) && v < hi).length;
    return `${lo === 0 ? "(0" : `[${lo}`},${hi}): ${String(n).padStart(4)}`;
  });
  return [
    `   ${label.padEnd(7)} n=${String(values.length).padStart(4)}  v=0 (lost): ${String(lost).padStart(4)}  ` +
      buckets.join("  "),
    `   ${" ".repeat(7)} min ${Math.min(...values).toFixed(3)}  median ${median(values).toFixed(3)}  max ${Math.max(...values).toFixed(3)}`,
  ];
}

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const dir = corpusDir(manifest);

  console.log("anchor containment: does a window that can move keep the anchor it chose?");
  console.log(
    `  metric: v(t) = overlap(selected group bbox, crop window) / bbox width, ` +
      `source pixels, failure is v < 1`
  );
  console.log(
    `  config: stream=${cfg.stream} faceSmallFrac=${cfg.faceSmallFrac} ` +
      `camera=deadzone ${cfg.camera.deadzoneFrac} settle ${cfg.camera.settleFrac} ` +
      `maxSpeed ${cfg.camera.maxSpeedFrac}/s maxKeyframes ${cfg.camera.maxKeyframes}`
  );
  console.log(
    `  env REFRAME_MOTION is ${cfg.motion ? "ON" : "off"}; both arms are built ` +
      `explicitly here, so it changes nothing about this run.`
  );
  console.log(`  corpus dir ${dir}\n`);

  const results: ItemResult[] = [];
  let example: { id: string; sample: Sample; cropW: number } | null = null;

  for (const item of manifest.items) {
    console.log(`--- ${item.id}`);
    const { result, detail } = await measure(dir, item.id, {
      faceSmallFrac: cfg.faceSmallFrac,
      faceLargeFrac: cfg.faceLargeFrac,
      stream: cfg.stream,
      camShare: cfg.camShare,
      camera: cfg.camera,
    });
    for (const line of detail) console.log(line);
    if (result.note) {
      console.log(`    ${result.note}`);
    }
    if (result.samples > 0) {
      console.log(
        `    samples=${result.samples}  legacy fail ${result.legacyFails} (${pct(result.legacyFails, result.samples).toFixed(1)}%)  ` +
          `motion fail ${result.motionFails} (${pct(result.motionFails, result.samples).toFixed(1)}%)`
      );
      console.log(
        `    longest failure run: legacy ${result.legacyGap.seconds.toFixed(2)}s (${result.legacyGap.samples} samples)  ` +
          `motion ${result.motionGap.seconds.toFixed(2)}s (${result.motionGap.samples} samples)`
      );
    }
    for (const [reason, n] of [...result.excluded].sort((a, b) => b[1] - a[1])) {
      console.log(`    excluded: ${n} ${reason}`);
    }
    if (result.centreMismatches > 0) {
      console.error(
        `    ! ${result.centreMismatches} samples where this script's bbox centre ` +
          `disagrees with buildTargetSamples - the metric is not reading the planner's anchor`
      );
    }
    results.push(result);
    if (!example && result.firstFailure) {
      const cap = await readCapture(dir, item.id);
      if (cap) {
        example = {
          id: item.id,
          sample: result.firstFailure,
          cropW: cropWidthFor(cap.source.height),
        };
      }
    }
  }

  console.log("\n=== per item ===");
  console.log(
    "item           samples  legacy%  motion%   delta   legacy gap    motion gap"
  );
  for (const r of results) {
    if (r.samples === 0) {
      console.log(`${r.id.padEnd(14)} ${"0".padStart(7)}  ${(r.note ?? "no data").padEnd(44)} EXCLUDED`);
      continue;
    }
    const legacyRate = pct(r.legacyFails, r.samples);
    const motionRate = pct(r.motionFails, r.samples);
    const delta = motionRate - legacyRate;
    console.log(
      `${r.id.padEnd(14)} ${String(r.samples).padStart(7)}  ${fmtPct(legacyRate)}  ${fmtPct(motionRate)}  ` +
        `${(delta >= 0 ? "+" : "") + delta.toFixed(1)}pp`.padStart(8) +
        `   ${r.legacyGap.seconds.toFixed(2)}s/${r.legacyGap.samples}`.padEnd(14) +
        `${r.motionGap.seconds.toFixed(2)}s/${r.motionGap.samples}`
    );
  }

  const contributing = results.filter((r) => r.samples > 0);
  const deltas = contributing.map(
    (r) => pct(r.motionFails, r.samples) - pct(r.legacyFails, r.samples)
  );
  const improved = deltas.filter((d) => d < -EPS).length;
  const worsened = deltas.filter((d) => d > EPS).length;
  const unchanged = deltas.length - improved - worsened;
  const pairedMedian = median(deltas);

  console.log("\n=== v below 1, pooled over contributing items ===");
  for (const line of distribution("legacy", contributing.flatMap((r) => r.legacyPartials))) {
    console.log(line);
  }
  for (const line of distribution("motion", contributing.flatMap((r) => r.motionPartials))) {
    console.log(line);
  }

  if (example) {
    console.log("");
    for (const line of workedExample(example.id, example.sample, example.cropW)) {
      console.log(line);
    }
  } else {
    console.log("\nworked example: none - no sample failed under either arm");
  }

  console.log("\n=== summary ===");
  console.log(`items checked                 : ${results.length}`);
  console.log(
    `items that CONTRIBUTED samples: ${contributing.length}` +
      (contributing.length < results.length
        ? `   (excluded: ${results
            .filter((r) => r.samples === 0)
            .map((r) => r.id)
            .join(", ")})`
        : "")
  );
  const pooledSamples = contributing.reduce((n, r) => n + r.samples, 0);
  const pooledLegacy = contributing.reduce((n, r) => n + r.legacyFails, 0);
  const pooledMotion = contributing.reduce((n, r) => n + r.motionFails, 0);
  console.log(
    `pooled samples                : ${pooledSamples}  legacy fail ${pooledLegacy} ` +
      `(${pct(pooledLegacy, pooledSamples).toFixed(1)}%)  motion fail ${pooledMotion} ` +
      `(${pct(pooledMotion, pooledSamples).toFixed(1)}%)`
  );
  console.log(
    `per-item deltas               : ${improved} improved, ${worsened} worse, ${unchanged} unchanged`
  );
  // Stated as a bare count, deliberately without a reading attached. An item the
  // legacy window never lost the anchor on cannot show an improvement, and the
  // majority clause counts it all the same - so how many such items there are is
  // part of what the reader needs, not an excuse for the verdict below.
  console.log(
    `items with legacy failure 0.0%: ${contributing.filter((r) => r.legacyFails === 0).length} of ${contributing.length}`
  );
  console.log(
    `paired median delta           : ${Number.isNaN(pairedMedian) ? "n/a" : (pairedMedian >= 0 ? "+" : "") + pairedMedian.toFixed(2) + "pp"}`
  );

  // --- the pass bar, exactly as agreed, checked one clause at a time.
  const control = results.find((r) => r.id === CONTROL_ID);
  const controlDelta =
    control && control.samples > 0
      ? pct(control.motionFails, control.samples) - pct(control.legacyFails, control.samples)
      : NaN;
  const grown = contributing.filter(
    (r) => r.motionGap.seconds > r.legacyGap.seconds + EPS
  );
  const bigRegressions = contributing.filter(
    (r) =>
      pct(r.motionFails, r.samples) - pct(r.legacyFails, r.samples) >
      MAX_REGRESSION_PP + EPS
  );

  const clauses: Array<[boolean, string]> = [
    [
      contributing.length > 0 && improved > contributing.length / 2 && pairedMedian < 0,
      `failure rate falls on a majority of contributing items with a negative paired median` +
        `  (${improved}/${contributing.length} improved, median ${Number.isNaN(pairedMedian) ? "n/a" : pairedMedian.toFixed(2) + "pp"})`,
    ],
    [
      grown.length === 0,
      `longest failure gap does not grow on any item` +
        (grown.length > 0 ? `  (grew on ${grown.map((r) => r.id).join(", ")})` : ""),
    ],
    [
      bigRegressions.length === 0,
      `no item regresses by more than ${MAX_REGRESSION_PP}pp` +
        (bigRegressions.length > 0
          ? `  (${bigRegressions.map((r) => r.id).join(", ")})`
          : ""),
    ],
    [
      control !== undefined && control.samples > 0 && controlDelta === 0,
      `the locked-off control shows a motion delta of exactly 0` +
        (!control || control.samples === 0
          ? `  (VACUOUS - ${CONTROL_ID} contributed no samples, so the control proved nothing)`
          : `  (${controlDelta.toFixed(2)}pp)`),
    ],
  ];

  console.log("\npass bar");
  for (const [ok, text] of clauses) {
    console.log(`   ${ok ? "PASS" : "FAIL"}  ${text}`);
  }
  const passed = clauses.every(([ok]) => ok);
  console.log("");
  if (contributing.length === 0) {
    console.log(
      "VERDICT: nothing was measured. No item contributed an eligible sample, so " +
        "this run says nothing about whether motion helps."
    );
  } else if (passed) {
    console.log(
      `VERDICT: the bar is MET on ${contributing.length} of ${results.length} corpus items.`
    );
  } else {
    console.log(
      `VERDICT: the bar is NOT met. On this corpus a crop window that can move ` +
        `does not demonstrably keep the chosen anchor in frame better than the ` +
        `static one. ${contributing.length} of ${results.length} items contributed data.`
    );
  }
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
