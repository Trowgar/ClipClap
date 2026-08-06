/**
 * Is the motion itself sane, and is the expression practical?
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-camera-safety.ts"
 *
 * The containment eval (eval-camera-containment.ts) asks whether a moving crop
 * window keeps the anchor in frame BETTER. It found the change harmless but not
 * beneficial on this corpus. This script asks the other half of the question,
 * the one a "no benefit" verdict does not answer: if the trajectory ever does
 * ship, does it stay inside the physical limits the design claims for it, and
 * does the filtergraph it compiles to stay inside the limits of the machine
 * that has to run it.
 *
 * ---------------------------------------------------------------------------
 * TWO CLASSES OF CHECK, AND WHY THEY ARE NOT MIXED
 * ---------------------------------------------------------------------------
 *
 * HARD INVARIANTS are properties with an external referent - the solver's own
 * speed cap, its own keyframe cap, the kernel's MAX_ARG_STRLEN, the frame's
 * width. Each one is a statement that can be checked against something outside
 * this script's opinion, and a violation is a merge blocker: the process exits
 * non-zero.
 *
 * PROVISIONAL REVIEW ALERTS - time-in-motion share and reversal rate - have no
 * such referent. Nobody has watched enough moving-camera renders to know what
 * "too busy" is, and the two numbers here (25% and 4/min) were picked to start
 * an argument, not to end one. They NEVER fail the build. Printing them beside
 * the invariants without that distinction would be the whole failure mode this
 * comment exists to prevent: a threshold with no evidence behind it acquires
 * authority purely by sitting next to ones that have some.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ITEM WITH NO TRAJECTORY MEANS
 * ---------------------------------------------------------------------------
 *
 * Most of this corpus produces no trajectory at all - the camera legitimately
 * never moves on a locked-off shot, a centre-crop plan has no `single` span to
 * move, and a stream plan has two tiles instead of one window. Such an item is
 * reported as EMITTED NOTHING and is excluded from every alert statistic. It is
 * NOT a passing item: a summary reading "0 alerts across 7 items" when 4 of them
 * emitted no motion would be describing silence as evidence. The count of items
 * that actually emitted a trajectory is printed separately from the count of
 * items checked, everywhere both could be confused.
 *
 * Built from the captured `<id>.plan.json` detector run, exactly as the
 * containment eval is; the detector is not re-run. Read-only, and it does not
 * turn REFRAME_MOTION on for anything but its own in-memory plan.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { resolveCamRect } from "../reframe/cam-rect";
import { loadReframeConfig } from "../reframe/config";
import { buildCropPlan, cropWidthFor } from "../reframe/plan";
import { buildFiltergraph } from "../reframe/filtergraph";
import type { CropPlan, Keyframe, Shot, ShotTracks } from "../reframe/types";
import { corpusDir, loadManifest } from "./corpus-fetch";

/**
 * Kernel MAX_ARG_STRLEN. The filtergraph is passed as ONE argv element, so this
 * is a hard wall and not a guideline: measured, 125781 characters pass and
 * 132181 raises `OSError: Argument list too long` before ffmpeg starts.
 */
const ARGV_CEILING = 131072;

/**
 * The budget is 50% of that ceiling, stated out loud because it is a choice and
 * not a measurement. Half leaves room for the rest of the graph to grow - the
 * ass snippet, a second overlay pair - without a future change silently
 * spending the last of a margin nobody was watching.
 */
const GRAPH_BUDGET_FRAC = 0.5;
const GRAPH_BUDGET = Math.floor(ARGV_CEILING * GRAPH_BUDGET_FRAC);

/** Solver contract: a trajectory is emitted with at least a start and an end,
 *  and never truncated past the cap - `solveCamera` returns null instead. */
const MIN_KEYFRAMES = 2;
const MAX_KEYFRAMES = 200;

/** PROVISIONAL. No corpus support. Do not tune to make a run look better. */
const ALERT_MOTION_SHARE = 0.25;
const ALERT_REVERSALS_PER_MIN = 4;

/** Comparing times and speeds, never used to soften an invariant. */
const EPS = 1e-9;

interface Captured {
  shots: Shot[];
  tracks: ShotTracks[];
  plan: CropPlan | null;
  source: { width: number; height: number };
  clip: { start: number; end: number };
}

interface SpanMetrics {
  spanIndex: number;
  start: number;
  end: number;
  keys: Keyframe[];
  /** Largest |dx/dt| between consecutive keyframes, px/s. */
  peakSpeed: number;
  /** Clip time of the peak, for the reader who wants to go look at it. */
  peakAt: number;
  /** Seconds spent on a segment whose x actually changes. */
  movingSec: number;
  /** Sign changes between consecutive MOVING segments. Counted within a span
   *  only: a new span is a new shot with its own separately solved camera, so a
   *  sign change across a seam is not a reversal of anything continuous. */
  reversals: number;
}

interface Check {
  name: string;
  /** null = vacuous: there was nothing of this kind to check. Vacuous is not
   *  pass, and is never counted as one. */
  ok: boolean | null;
  detail: string;
}

interface ItemResult {
  id: string;
  /** Why an item produced no metrics, when it produced none. */
  note: string | null;
  /** True only when at least one span carries `xs`. */
  emitted: boolean;
  singleSpans: number;
  trajectorySpans: number;
  spans: SpanMetrics[];
  cropW: number;
  speedCap: number;
  graphChars: number;
  graphKind: string;
  /** False means this run's planner config differs from the captured one, so
   *  the numbers describe a plan that does not ship. Reported, not blocking:
   *  the containment eval owns that gate. */
  legacyMatchesCapture: boolean | null;
  checks: Check[];
  /** Aggregates over trajectory-bearing spans only. NaN when there are none. */
  trajectorySec: number;
  movingSec: number;
  reversals: number;
  peakSpeed: number;
  keyframeTotal: number;
  keyframeMax: number;
}

async function readCapture(dir: string, id: string): Promise<Captured | null> {
  const raw = await readFile(join(dir, `${id}.plan.json`), "utf-8").catch(
    () => null
  );
  return raw ? (JSON.parse(raw) as Captured) : null;
}

/** Per-span motion metrics, straight off the emitted keyframes - the same array
 *  the filtergraph compiles, not the solver's intermediate state. */
function spanMetrics(
  spanIndex: number,
  start: number,
  end: number,
  keys: Keyframe[]
): SpanMetrics {
  let peakSpeed = 0;
  let peakAt = start;
  let movingSec = 0;
  let reversals = 0;
  let lastSign = 0;

  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    const dt = b.t - a.t;
    const dx = b.x - a.x;
    if (dx === 0) continue;
    movingSec += Math.max(dt, 0);
    // dt <= 0 is a separate invariant failure (times must strictly increase);
    // guarding here keeps the speed from becoming Infinity and swallowing the
    // more specific message.
    if (dt > 0) {
      const speed = Math.abs(dx) / dt;
      if (speed > peakSpeed) {
        peakSpeed = speed;
        peakAt = a.t;
      }
    }
    const sign = Math.sign(dx);
    if (lastSign !== 0 && sign !== lastSign) reversals += 1;
    lastSign = sign;
  }

  return { spanIndex, start, end, keys, peakSpeed, peakAt, movingSec, reversals };
}

function fmtSpeed(v: number): string {
  return v.toFixed(1);
}

function pct(n: number, d: number): number {
  return d === 0 ? NaN : (100 * n) / d;
}

function fmtPct(v: number): string {
  return Number.isNaN(v) ? "  -  " : `${v.toFixed(1)}%`;
}

async function measure(dir: string, id: string, cfg: ReturnType<typeof loadReframeConfig>): Promise<ItemResult> {
  const base: ItemResult = {
    id,
    note: null,
    emitted: false,
    singleSpans: 0,
    trajectorySpans: 0,
    spans: [],
    cropW: 0,
    speedCap: 0,
    graphChars: 0,
    graphKind: "-",
    legacyMatchesCapture: null,
    checks: [],
    trajectorySec: 0,
    movingSec: 0,
    reversals: 0,
    peakSpeed: 0,
    keyframeTotal: 0,
    keyframeMax: 0,
  };

  const cap = await readCapture(dir, id);
  if (!cap) return { ...base, note: "no capture on disk" };

  const { width, height } = cap.source;
  const camRect = resolveCamRect(
    cap.tracks.map((t) => t.camRect),
    width,
    height
  );
  const planOpts = {
    faceSmallFrac: cfg.faceSmallFrac,
    faceLargeFrac: cfg.faceLargeFrac,
    stream: cfg.stream,
    camShare: cfg.camShare,
    camera: cfg.camera,
  };
  const plan = buildCropPlan(
    cap.shots,
    cap.tracks,
    width,
    height,
    { ...planOpts, motion: true },
    camRect
  );
  if (!plan) {
    return { ...base, note: "planner declined (plan: null, legacy centre crop)" };
  }
  const legacy = buildCropPlan(
    cap.shots,
    cap.tracks,
    width,
    height,
    { ...planOpts, motion: false },
    camRect
  );
  const legacyMatchesCapture =
    legacy !== null && JSON.stringify(legacy) === JSON.stringify(cap.plan);

  const cropW = cropWidthFor(height);
  const speedCap = cfg.camera.maxSpeedFrac * cropW;
  const maxX = width - cropW;

  const singles = plan.shots.filter((s) => s.layout === "single");
  const spans: SpanMetrics[] = [];
  const shapeFails: string[] = [];
  const boundsFails: string[] = [];
  let trajectorySpans = 0;

  for (const [i, shot] of plan.shots.entries()) {
    if (shot.layout !== "single" || !shot.xs) continue;
    trajectorySpans += 1;
    const keys = shot.xs;

    // Shape: phrased on the EMITTED plan. The solver's own cap is a separate
    // statement about the solver; this one is about what a renderer receives.
    if (keys.length < MIN_KEYFRAMES || keys.length > MAX_KEYFRAMES) {
      shapeFails.push(
        `span ${i} [${shot.start.toFixed(2)},${shot.end.toFixed(2)}] has ${keys.length} keyframes, ` +
          `outside [${MIN_KEYFRAMES}, ${MAX_KEYFRAMES}]`
      );
    }

    for (const [j, k] of keys.entries()) {
      if (!Number.isInteger(k.x)) {
        boundsFails.push(`span ${i} key ${j}: x=${k.x} is not an integer`);
      }
      if (k.x < 0 || k.x > maxX) {
        boundsFails.push(
          `span ${i} key ${j}: x=${k.x} outside [0, ${maxX}] (sourceWidth ${width} - cropW ${cropW})`
        );
      }
      if (j > 0 && !(k.t > keys[j - 1].t)) {
        boundsFails.push(
          `span ${i} key ${j}: t=${k.t} does not exceed the previous t=${keys[j - 1].t}`
        );
      }
    }

    spans.push(spanMetrics(i, shot.start, shot.end, keys));
  }

  const spec = buildFiltergraph(plan);
  const graphChars = spec.graph.length;

  const speedFails = spans
    .filter((s) => s.peakSpeed > speedCap + EPS)
    .map(
      (s) =>
        `span ${s.spanIndex} peaks at ${fmtSpeed(s.peakSpeed)} px/s at t=${s.peakAt.toFixed(2)}, ` +
        `cap ${fmtSpeed(speedCap)} px/s`
    );

  const emitted = trajectorySpans > 0;
  const vacuous = "no trajectory emitted - nothing to check";

  const checks: Check[] = [
    {
      name: `peak |dx/dt| <= maxSpeedFrac*cropW (${fmtSpeed(speedCap)} px/s)`,
      ok: emitted ? speedFails.length === 0 : null,
      detail: emitted
        ? speedFails.length === 0
          ? `peak ${fmtSpeed(Math.max(0, ...spans.map((s) => s.peakSpeed)))} px/s ` +
            `= ${fmtPct(pct(Math.max(0, ...spans.map((s) => s.peakSpeed)), speedCap))} of cap`
          : speedFails.join("; ")
        : vacuous,
    },
    {
      name: `every emitted xs holds ${MIN_KEYFRAMES}..${MAX_KEYFRAMES} keyframes`,
      ok: emitted ? shapeFails.length === 0 : null,
      detail: emitted
        ? shapeFails.length === 0
          ? `${trajectorySpans} trajector${trajectorySpans === 1 ? "y" : "ies"}, ` +
            `sizes ${spans.map((s) => s.keys.length).join("/")}`
          : shapeFails.join("; ")
        : vacuous,
    },
    {
      name: `filtergraph < ${GRAPH_BUDGET} chars (${(GRAPH_BUDGET_FRAC * 100).toFixed(0)}% of the ${ARGV_CEILING} ARGV ceiling)`,
      // Checked on every plan, motion or not: a graph too long to exec is fatal
      // whichever expression form produced it. The detail says which form this
      // number came from, so a short legacy graph is not read as evidence about
      // the ramp form.
      ok: graphChars < GRAPH_BUDGET,
      detail:
        `${graphChars} chars (${pct(graphChars, ARGV_CEILING).toFixed(2)}% of the ceiling), ` +
        `${spec.kind} graph, ${emitted ? "ramp form" : "legacy piecewise form - says nothing about the ramp"}`,
    },
    {
      name: `every keyframe x integer in [0, ${maxX}], t strictly increasing`,
      ok: emitted ? boundsFails.length === 0 : null,
      detail: emitted
        ? boundsFails.length === 0
          ? `${spans.reduce((n, s) => n + s.keys.length, 0)} keyframes, ` +
            `x range [${Math.min(...spans.flatMap((s) => s.keys.map((k) => k.x)))}, ` +
            `${Math.max(...spans.flatMap((s) => s.keys.map((k) => k.x)))}]`
          : boundsFails.join("; ")
        : vacuous,
    },
  ];

  const trajectorySec = spans.reduce((n, s) => n + (s.end - s.start), 0);
  return {
    id,
    note: emitted ? null : "emitted no trajectory on any span",
    emitted,
    singleSpans: singles.length,
    trajectorySpans,
    spans,
    cropW,
    speedCap,
    graphChars,
    graphKind: spec.kind,
    legacyMatchesCapture,
    checks,
    trajectorySec,
    movingSec: spans.reduce((n, s) => n + s.movingSec, 0),
    reversals: spans.reduce((n, s) => n + s.reversals, 0),
    peakSpeed: Math.max(0, ...spans.map((s) => s.peakSpeed)),
    keyframeTotal: spans.reduce((n, s) => n + s.keys.length, 0),
    keyframeMax: Math.max(0, ...spans.map((s) => s.keys.length)),
  };
}

/** Provisional alerts for one item. Empty for an item that emitted nothing -
 *  there is no denominator there, and inventing one would report calm. */
function alertsFor(r: ItemResult): string[] {
  if (!r.emitted) return [];
  const out: string[] = [];
  const share = r.trajectorySec > 0 ? r.movingSec / r.trajectorySec : NaN;
  const perMin = r.trajectorySec > 0 ? r.reversals / (r.trajectorySec / 60) : NaN;
  if (share > ALERT_MOTION_SHARE) {
    out.push(
      `time in motion ${fmtPct(share * 100)} > ${fmtPct(ALERT_MOTION_SHARE * 100)}`
    );
  }
  if (perMin > ALERT_REVERSALS_PER_MIN) {
    out.push(
      `reversals ${perMin.toFixed(1)}/min > ${ALERT_REVERSALS_PER_MIN.toFixed(1)}/min`
    );
  }
  return out;
}

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const dir = corpusDir(manifest);

  console.log(
    "camera safety: is the motion physically sane, and is the expression practical?"
  );
  console.log(
    `  hard invariants BLOCK (exit non-zero). Provisional alerts DO NOT - they have ` +
      `no corpus support and exist to open a conversation.`
  );
  console.log(
    `  config: stream=${cfg.stream} camera=deadzone ${cfg.camera.deadzoneFrac} ` +
      `settle ${cfg.camera.settleFrac} maxSpeed ${cfg.camera.maxSpeedFrac}/s ` +
      `maxKeyframes ${cfg.camera.maxKeyframes}`
  );
  console.log(
    `  ARGV ceiling ${ARGV_CEILING} chars (kernel MAX_ARG_STRLEN, the graph is one argv element); ` +
      `budget ${(GRAPH_BUDGET_FRAC * 100).toFixed(0)}% = ${GRAPH_BUDGET}`
  );
  console.log(
    `  provisional: time in motion > ${(ALERT_MOTION_SHARE * 100).toFixed(0)}%, ` +
      `reversals > ${ALERT_REVERSALS_PER_MIN}/min. Denominator for both is the summed ` +
      `duration of the spans that CARRY a trajectory - the strictest available.`
  );
  console.log(
    `  env REFRAME_MOTION is ${cfg.motion ? "ON" : "off"}; the motion plan is built ` +
      `explicitly here, so it changes nothing about this run.`
  );
  console.log(`  corpus dir ${dir}\n`);

  const results: ItemResult[] = [];
  for (const item of manifest.items) {
    const r = await measure(dir, item.id, cfg);
    results.push(r);

    console.log(`--- ${r.id}`);
    if (r.note && r.spans.length === 0 && r.cropW === 0) {
      console.log(`    ${r.note}`);
      continue;
    }
    console.log(
      `    cropW ${r.cropW}  speed cap ${fmtSpeed(r.speedCap)} px/s  ` +
        `single spans ${r.singleSpans}  spans with a trajectory ${r.trajectorySpans}  ` +
        `legacy arm == captured plan: ${r.legacyMatchesCapture ? "yes" : "NO"}`
    );
    if (!r.emitted) {
      console.log(
        `    EMITTED NOTHING - contributes nothing to the alert statistics, and is ` +
          `not a clean pass`
      );
    } else {
      console.log(
        `    keyframes ${r.keyframeTotal} total, ${r.keyframeMax} in the largest span`
      );
      console.log(
        `    peak |dx/dt| ${fmtSpeed(r.peakSpeed)} px/s = ` +
          `${fmtPct(pct(r.peakSpeed, r.speedCap))} of the ${fmtSpeed(r.speedCap)} px/s cap`
      );
      console.log(
        `    time in motion ${r.movingSec.toFixed(2)}s of ${r.trajectorySec.toFixed(2)}s = ` +
          `${fmtPct(pct(r.movingSec, r.trajectorySec))}   ` +
          `reversals ${r.reversals} = ` +
          `${(r.trajectorySec > 0 ? r.reversals / (r.trajectorySec / 60) : NaN).toFixed(1)}/min`
      );
      for (const s of r.spans) {
        console.log(
          `      span ${s.spanIndex} [${s.start.toFixed(2)},${s.end.toFixed(2)}] ` +
            `keys ${String(s.keys.length).padStart(3)}  peak ${fmtSpeed(s.peakSpeed).padStart(6)} px/s  ` +
            `moving ${s.movingSec.toFixed(2)}s  reversals ${s.reversals}  ` +
            `x ${s.keys[0].x} -> ${s.keys[s.keys.length - 1].x}`
        );
      }
    }
    console.log(
      `    filtergraph ${r.graphChars} chars (${pct(r.graphChars, ARGV_CEILING).toFixed(2)}% of ceiling, ` +
        `${pct(r.graphChars, GRAPH_BUDGET).toFixed(2)}% of budget), ${r.graphKind}`
    );
    for (const c of r.checks) {
      const tag = c.ok === null ? "VACUOUS" : c.ok ? "PASS   " : "FAIL   ";
      console.log(`    ${tag} ${c.name}`);
      console.log(`            ${c.detail}`);
    }
    const alerts = alertsFor(r);
    if (!r.emitted) {
      console.log(`    provisional alerts: n/a - no trajectory to describe`);
    } else if (alerts.length === 0) {
      console.log(`    provisional alerts: none`);
    } else {
      for (const a of alerts) console.log(`    ALERT (provisional, non-blocking) ${a}`);
    }
    console.log("");
  }

  const emitting = results.filter((r) => r.emitted);

  console.log("=== per item ===");
  console.log(
    "item           traj/single  keyfr  peak px/s   %cap  motion%  rev/min  expr chars"
  );
  for (const r of results) {
    if (!r.emitted) {
      console.log(
        `${r.id.padEnd(14)} ${`${r.trajectorySpans}/${r.singleSpans}`.padStart(11)}  ` +
          `${"-".padStart(5)}  ${"-".padStart(9)}  ${"-".padStart(5)}  ${"-".padStart(7)}  ` +
          `${"-".padStart(7)}  ${String(r.graphChars).padStart(10)}   (no trajectory)`
      );
      continue;
    }
    const perMin = r.trajectorySec > 0 ? r.reversals / (r.trajectorySec / 60) : NaN;
    console.log(
      `${r.id.padEnd(14)} ${`${r.trajectorySpans}/${r.singleSpans}`.padStart(11)}  ` +
        `${String(r.keyframeTotal).padStart(5)}  ${fmtSpeed(r.peakSpeed).padStart(9)}  ` +
        `${pct(r.peakSpeed, r.speedCap).toFixed(0).padStart(4)}%  ` +
        `${fmtPct(pct(r.movingSec, r.trajectorySec)).padStart(7)}  ` +
        `${perMin.toFixed(1).padStart(7)}  ${String(r.graphChars).padStart(10)}`
    );
  }

  const failed = results.flatMap((r) =>
    r.checks.filter((c) => c.ok === false).map((c) => `${r.id}: ${c.name} - ${c.detail}`)
  );
  const passedChecks = results.reduce(
    (n, r) => n + r.checks.filter((c) => c.ok === true).length,
    0
  );
  const vacuousChecks = results.reduce(
    (n, r) => n + r.checks.filter((c) => c.ok === null).length,
    0
  );
  const alerts = results.flatMap((r) => alertsFor(r).map((a) => `${r.id}: ${a}`));

  console.log("\n=== summary ===");
  console.log(`items checked                    : ${results.length}`);
  console.log(
    `items that EMITTED a trajectory  : ${emitting.length}` +
      (emitting.length < results.length
        ? `   (emitted nothing: ${results
            .filter((r) => !r.emitted)
            .map((r) => r.id)
            .join(", ")})`
        : "")
  );
  console.log(
    `spans with a trajectory          : ${results.reduce((n, r) => n + r.trajectorySpans, 0)} ` +
      `of ${results.reduce((n, r) => n + r.singleSpans, 0)} single spans, ` +
      `${results.reduce((n, r) => n + r.spans.length, 0)} scored`
  );
  console.log(
    `hard invariant checks            : ${passedChecks} pass, ${failed.length} FAIL, ` +
      `${vacuousChecks} vacuous (nothing of that kind existed to check)`
  );
  const drifted = results.filter((r) => r.legacyMatchesCapture === false);
  console.log(
    `legacy arm == captured plan      : ${results.length - drifted.length} of ${results.length}` +
      (drifted.length > 0 ? `   (drift on ${drifted.map((r) => r.id).join(", ")})` : "")
  );
  if (emitting.length > 0) {
    const pooledSec = emitting.reduce((n, r) => n + r.trajectorySec, 0);
    const pooledMoving = emitting.reduce((n, r) => n + r.movingSec, 0);
    const pooledRev = emitting.reduce((n, r) => n + r.reversals, 0);
    console.log(
      `pooled over EMITTING items only  : ${pooledSec.toFixed(2)}s of trajectory, ` +
        `${pooledMoving.toFixed(2)}s in motion (${fmtPct(pct(pooledMoving, pooledSec))}), ` +
        `${pooledRev} reversals (${(pooledRev / (pooledSec / 60)).toFixed(1)}/min), ` +
        `peak ${fmtSpeed(Math.max(...emitting.map((r) => r.peakSpeed)))} px/s`
    );
    console.log(
      `longest filtergraph              : ${Math.max(...results.map((r) => r.graphChars))} chars ` +
        `of the ${GRAPH_BUDGET} budget`
    );
  }

  console.log(
    `\nprovisional alerts (NON-BLOCKING): ${alerts.length}` +
      (emitting.length === 0
        ? "  - and that zero is empty: no item emitted a trajectory, so nothing could have alerted"
        : `  over the ${emitting.length} emitting item(s)`)
  );
  for (const a of alerts) console.log(`   ${a}`);

  console.log("");
  if (failed.length > 0) {
    console.log("HARD INVARIANT VIOLATIONS - this is a merge blocker:");
    for (const f of failed) console.log(`   FAIL  ${f}`);
    console.log(
      `\nVERDICT: ${failed.length} hard invariant violation(s). The motion layer must not ship as is.`
    );
    process.exitCode = 1;
    return;
  }
  if (emitting.length === 0) {
    console.log(
      "VERDICT: no hard invariant was violated, but no item emitted a trajectory " +
        "either - the motion invariants were vacuous on every item and this run " +
        "says nothing about whether a moving camera is safe."
    );
    return;
  }
  console.log(
    `VERDICT: no hard invariant violated. ${emitting.length} of ${results.length} items ` +
      `emitted a trajectory; the motion invariants are real on those ${emitting.length} and ` +
      `vacuous on the other ${results.length - emitting.length}.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
