import type {
  CropPlan,
  FilterSpec,
  Keyframe,
  MusicDirectionOpts,
  ShotLayout,
} from "./types";
import { cropWidthFor, evenClamp, tileWidthFor } from "./plan";
import {
  formatLayoutTime,
  formatRampTime,
  MIN_RENDER_RAMP_DT,
  roundRampTime,
} from "./render-time";

type SplitLayout = Extract<ShotLayout, { layout: "split" }>;
type StreamLayout = Extract<ShotLayout, { layout: "stream" }>;

function baseXForShot(shot: ShotLayout, centerX: number): number {
  switch (shot.layout) {
    case "center":
    case "single":
      return shot.x;
    case "split":
    case "stream":
      return centerX;
    case "safe-fit":
      throw new Error("safe-fit_not_supported");
  }
}

/** Piecewise-constant x(t) over consecutive windows; the last x is the else
 *  branch, so the expression is total for every t. x values are integers. */
export function piecewiseX(segments: Array<{ end: number; x: number }>): string {
  if (segments.length === 0) throw new Error("piecewiseX: empty");
  let expr = String(segments[segments.length - 1].x);
  for (let i = segments.length - 2; i >= 0; i--) {
    expr = `if(lt(t,${formatLayoutTime(segments[i].end)}),${segments[i].x},${expr})`;
  }
  return expr;
}

/** A step takes this long. Sub-frame at any frame rate this product encodes, so
 *  it is a step in every rendered frame, while giving the ramp a non-zero
 *  denominator. */
/**
 * `rampX`'s own formatter, three decimals, used for BOTH halves of a term -
 * the offset `t-a.t` and the duration `dt`.
 *
 * It exists because `formatLayoutTime` is two decimals, which rendered the
 * minimum step as "0.00"
 * and made the constant inert: an instantaneous step compiled to a literal
 * `clip((t-4.50)/0.00,0,1)`. Measured on ffmpeg 8.0.1, that did NOT crash -
 * av_expr's clip() maps -inf to 0, +inf to 1 and NaN to 0, so t below the step
 * gave -inf -> 0, t above gave +inf -> 1, and t exactly on it gave 0/0 = NaN
 * -> 0, i.e. a clean step that landed one frame late. Correct output resting
 * entirely on undocumented clip(NaN) handling is not a guarantee, so the
 * denominator is now genuinely non-zero.
 *
 * `formatLayoutTime` is deliberately NOT changed. It formats the times inside `piecewiseX`,
 * whose output must stay byte-identical to what ships today - 96 crop plans are
 * already persisted in Postgres and must keep rendering the same frames. Only
 * `rampX` output is new, so only `rampX` is free to be more precise.
 *
 * One formatter for both halves on purpose: fixing the denominator and leaving
 * the numerator at two decimals is the obvious next mistake.
 */
/**
 * x(t) as a FLAT SUM of clipped ramps: `x0 + d1*clip((t-t0)/dt0,0,1) + ...`.
 *
 * Nesting depth 1 regardless of how many keyframes there are, which is the
 * whole reason this exists. `piecewiseX` nests one `if()` per segment and
 * ffmpeg's av_expr parser fails at 99 of them - measured, and the origin of
 * MAX_PLAN_SHOTS. Measured limits for this form: 3000 terms parse and cost
 * 1.16x encode time, and the real ceiling is the kernel's MAX_ARG_STRLEN of
 * 131072 characters, because the graph is passed as one argv element. Hence the
 * 200-keyframe cap in camera.ts, which lands at about 6 KB.
 *
 * A flat run costs nothing: equal consecutive x values emit no term.
 */
export function rampX(keys: Keyframe[]): string {
  if (keys.length === 0) throw new Error("rampX: empty");
  const terms: string[] = [String(keys[0].x)];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    const delta = b.x - a.x;
    if (delta === 0) continue;
    const dt = roundRampTime(Math.max(b.t - a.t, MIN_RENDER_RAMP_DT));
    terms.push(
      `${delta >= 0 ? "+" : "-"}${Math.abs(delta)}*clip((t-${formatRampTime(a.t)})/${formatRampTime(dt)},0,1)`
    );
  }
  return terms.join("");
}

/**
 * The whole clip's window trajectory, in order.
 *
 * Split and stream shots contribute the centre: the tiles cover the frame while
 * they are enabled, so the base crop under them is never visible - the same
 * reasoning `buildFiltergraph` already applies to `baseX`.
 */
export function planKeyframes(plan: CropPlan, centerX: number): Keyframe[] {
  const keys: Keyframe[] = [];
  for (const shot of plan.shots) {
    if (shot.layout === "single" && shot.xs && shot.xs.length > 0) {
      keys.push(...shot.xs);
      continue;
    }
    const x = baseXForShot(shot, centerX);
    keys.push({ t: shot.start, x }, { t: shot.end, x });
  }
  return keys;
}

/** Even-snaps `n` DOWN (never up) - used for the R1/R3 music-only geometry
 *  below, where a snap-up could push a bar or a punch-in crop back over the
 *  bound it was just computed to respect. */
function snapEvenDown(n: number): number {
  return 2 * Math.floor(n / 2);
}

/**
 * R3 v1.1 (spec 2026-08-23-music-shorts): a shot punches only when its
 * saliency mass occupies UNDER this fraction of the frame's width. Owner
 * diagnosis on the Believer corpus render: v1's odd/even alternation
 * tightened MV close-ups that already fill the frame (a face filling the
 * height at t=3) on top of the R1 letterbox-bar zoom, making them worse - a
 * close-up's edge energy spreads across most of the frame width, so a high
 * `spreadFrac` IS the close-up signal. A wide/empty scene (a silhouette
 * against starfield) concentrates its energy in a narrow column cluster - low
 * `spreadFrac` - and the 1.08x tightening helps there.
 *
 * n=1 Believer calibration: 0.55 sits between that clip's measured close-up
 * spread and its wide-shot spread. Corpus renders decide whether it needs to
 * move once more music-video shapes exist.
 */
export const SPREAD_PUNCH_MAX = 0.55;

/**
 * R1 (spec 2026-08-23-music-shorts): re-centres one planned `x` on a NEW crop
 * width, music-bar jobs only. The planner computed every `x` against the
 * FULL-height crop width (`cropW0`); cutting a constant letterbox bar shrinks
 * the crop's height and therefore its 9:16-matching width (`cropW`), so the
 * old `x` would no longer sit where the plan intended, or could even hang
 * part-way off the frame. Faces were detected on the full frame, so the
 * horizontal CENTRE `x + cropW0/2` is still exactly right - only the window's
 * width changed - so the fix is to re-centre on that same point and reclamp
 * into the narrower frame, not to re-run any face logic.
 */
function remapXForBars(
  x: number,
  cropW0: number,
  cropW: number,
  sourceWidth: number
): number {
  if (cropW === cropW0) return x;
  return evenClamp(x + (cropW0 - cropW) / 2, cropW, sourceWidth);
}

/** Applies `remapXForBars` to a shot's own x-bearing field(s). Split/stream
 *  tiles are left untouched: their tile geometry is a separate crop entirely
 *  (`tileW`/`stream` geometry, not `cropW`), and R1 is scoped to the base
 *  chain only - the base crop is never even visible while a tile is enabled
 *  (see the "Tiled layouts" comment below), so there is nothing for a bar
 *  crop to fix there. Never mutates `shot`. */
function remapShotForBars(
  shot: ShotLayout,
  cropW0: number,
  cropW: number,
  sourceWidth: number
): ShotLayout {
  if (shot.layout === "single") {
    return {
      ...shot,
      x: remapXForBars(shot.x, cropW0, cropW, sourceWidth),
      ...(shot.xs
        ? {
            xs: shot.xs.map((k) => ({
              t: k.t,
              x: remapXForBars(k.x, cropW0, cropW, sourceWidth),
            })),
          }
        : {}),
    };
  }
  if (shot.layout === "center") {
    return { ...shot, x: remapXForBars(shot.x, cropW0, cropW, sourceWidth) };
  }
  return shot;
}

/**
 * Compiles a CropPlan (+ optional ass snippet) into a single-pass filter.
 * No tiled shots -> plain -vf chain. Any stream shot (webcam over content) or
 * split shot (two faces) -> -filter_complex with two time-enabled overlay
 * tiles; the caller must map "[vout]" + audio. A plan holding both is not
 * emitted by the planner (spec §9.6); stream wins if one ever appears.
 *
 * `musicDirection` (spec 2026-08-23-music-shorts) is undefined on every path
 * except a music-shorts job's render, so every branch below that reads it is
 * a MUSIC-ONLY addition: with it absent, `hasBars`/`punchEligible` are both
 * false and every computation collapses to exactly what this function already
 * emitted, byte for byte.
 */
export function buildFiltergraph(
  plan: CropPlan,
  assSnippet?: string,
  musicDirection?: MusicDirectionOpts
): FilterSpec {
  if (plan.shots.some((shot) => shot.layout === "safe-fit")) {
    throw new Error("safe-fit_not_supported");
  }
  const cropW0 = cropWidthFor(plan.source.height);
  // R1: a constant letterbox bar (0/0 is the common case - most sources have
  // none) shrinks the crop height and recomputes the 9:16 width from it.
  const hasBars =
    !!musicDirection &&
    (musicDirection.topBar > 0 || musicDirection.bottomBar > 0);
  const croppedH = hasBars
    ? plan.source.height - musicDirection!.topBar - musicDirection!.bottomBar
    : plan.source.height;
  const cropW = hasBars ? cropWidthFor(croppedH) : cropW0;
  // A NEW plan object with only the x-bearing fields re-centred (see
  // `remapShotForBars`) - `plan` itself is never mutated, which matters
  // because `render.ts` persists this SAME object to `Clip.cropPlan`
  // afterwards (see the "never mutates the plan" test in this file's suite).
  const workingPlan: CropPlan = hasBars
    ? {
        ...plan,
        shots: plan.shots.map((s) => remapShotForBars(s, cropW0, cropW, plan.source.width)),
      }
    : plan;

  const tileW = tileWidthFor(plan.source.height);
  const centerX = evenClamp(
    (workingPlan.source.width - cropW) / 2,
    cropW,
    workingPlan.source.width
  );
  // Type-guard filter: plain .filter() would not narrow ShotLayout, and the
  // tile-geometry reads below need the split variant.
  const splits = workingPlan.shots.filter(
    (s): s is SplitLayout => s.layout === "split"
  );
  const streams = workingPlan.shots.filter(
    (s): s is StreamLayout => s.layout === "stream"
  );

  // Tiled layouts cover the whole frame while they are enabled, so the base
  // crop under them is never visible - centre it and keep the expression total.
  // The ramp form is used ONLY when a trajectory is actually present. A plan
  // without one compiles through the piecewise form it always used, so a clip
  // where the camera never moves is byte-identical to legacy whatever the flag
  // says - which is what makes the rollback story testable rather than
  // promised.
  const hasTrajectory = workingPlan.shots.some(
    (s) => s.layout === "single" && s.xs && s.xs.length > 0
  );
  const baseX = hasTrajectory
    ? rampX(planKeyframes(workingPlan, centerX))
    : piecewiseX(
        workingPlan.shots.map((s) => ({
          end: s.end,
          x: baseXForShot(s, centerX),
        }))
      );
  // R1: h/y stay the legacy "ih"/"0" tokens off the music path (byte-identical
  // string), and become the bar-cut numbers on it. `h0` is the same height as
  // a NUMBER either way - needed below for the R3 punch-in geometry, which has
  // to know the base crop's actual pixel height regardless of which token this
  // string carries.
  const h0 = hasBars ? croppedH : plan.source.height;
  const baseCropOnly = `crop=w=${cropW}:h=${hasBars ? croppedH : "ih"}:x='${baseX}':y=${hasBars ? musicDirection!.topBar : 0}`;
  // setsar=1 is not decoration and it is not only for the tiled layouts. A 9:16
  // slice of a 1080-tall frame is 607.5px, `cropWidthFor` rounds it to an even
  // 608, and `scale` PRESERVES display aspect rather than stretching - so
  // scaling 608x1080 to exactly 1080x1920 leaves ffmpeg to absorb the 0.08% by
  // tagging the output SAR 1216:1215. All 62 delivered clips carried that tag
  // (engine-notes §7h). This base chain is also what tags the FINAL file under
  // both composite layouts, so the tiles declaring square pixels was never
  // enough on its own.
  const baseChain = `${baseCropOnly},scale=1080:1920,setsar=1`;

  // R3 (spec 2026-08-23-music-shorts): a discrete per-shot punch-in - a
  // montage-energy device synced to the MV's own (beat-)cuts. Deliberately
  // NOT a continuous zoom: the repo's camera-motion knobs (camera.ts) are
  // measured-provisional and this must not touch them, so the choice is
  // built the same way the split/stream tiles already switch between two
  // fixed states - two parallel crop branches, chosen per shot by a
  // time-gated `overlay`, never a time-varying crop width/height (ffmpeg's
  // `crop` filter only re-evaluates `x`/`y` per frame, not `w`/`h` - a
  // discrete width change needs a real branch, not an expression). Scoped to
  // the plain single/center path: split and stream shots don't reach here
  // for a music job (task M4 forces stream off, and a duet split is out of
  // scope for v1), and a plan with only one shot has no "alternation" to
  // speak of.
  //
  // v1.1: WHICH shots punch changed from odd/even alternation to
  // SPREAD-GATED (see `SPREAD_PUNCH_MAX`) - a shot punches only when its
  // saliency says its subject mass is narrow, never a shot with no saliency
  // at all (an older sidecar, or a shot with no sampled frames) and never a
  // shot spread across most of the frame (a close-up). `spreadFrac` lives on
  // `workingPlan.shots` (plan.ts, MUSIC-ONLY), never on `split`/`stream`
  // shots, so the type guard doubles as the layout filter.
  const punchIndices = workingPlan.shots
    .map((s, i) =>
      (s.layout === "center" || s.layout === "single") &&
      s.spreadFrac !== undefined &&
      s.spreadFrac < SPREAD_PUNCH_MAX
        ? i
        : null
    )
    .filter((i): i is number => i !== null);

  const punchEligible =
    !!musicDirection?.punchIn &&
    workingPlan.shots.length > 1 &&
    splits.length === 0 &&
    streams.length === 0 &&
    punchIndices.length > 0;

  if (punchEligible) {
    const PUNCH_FACTOR = 1.08;
    const punchW = Math.min(cropW, snapEvenDown(cropW / PUNCH_FACTOR));
    const punchH = Math.min(h0, snapEvenDown(h0 / PUNCH_FACTOR));
    const punchX = Math.max(0, snapEvenDown((cropW - punchW) / 2));
    const punchY = Math.max(0, snapEvenDown((h0 - punchH) / 2));
    const punchIndexSet = new Set(punchIndices);
    const punchEnable = workingPlan.shots
      .map((s, i) =>
        punchIndexSet.has(i)
          ? `gte(t,${formatLayoutTime(s.start)})*lt(t,${formatLayoutTime(s.end)})`
          : null
      )
      .filter((e): e is string => e !== null)
      .join("+");
    const chains = [
      `[0:v]split=2[b0][p0]`,
      `[b0]${baseChain}[wide]`,
      // Same base crop as [wide] (same tracked x, same bar-cut h/y), then one
      // more constant, NON-time-varying crop tightened by PUNCH_FACTOR and
      // centred in the (now fixed-size) intermediate frame - "before the
      // common scale", per spec. setsar=1 for the same reason as every other
      // scale in this file: this branch's own scale would otherwise tag a
      // slightly different SAR than [wide]'s, and the two must match to
      // overlay cleanly.
      `[p0]${baseCropOnly},crop=w=${punchW}:h=${punchH}:x=${punchX}:y=${punchY},scale=1080:1920,setsar=1[punch]`,
      assSnippet
        ? `[wide][punch]overlay=x=0:y=0:enable='${punchEnable}'[o1]`
        : `[wide][punch]overlay=x=0:y=0:enable='${punchEnable}'[vout]`,
    ];
    if (assSnippet) chains.push(`[o1]${assSnippet}[vout]`);
    return { kind: "complex", graph: chains.join(";") };
  }

  if (streams.length > 0) {
    // plan.stream is optional on the type while a stream shot can exist, so the
    // pairing is checked ONCE here instead of with ! assertions through the tile
    // maths. Nothing below may mutate `plan` or `geom`: on the clips path this
    // same object is persisted to Clip.cropPlan afterwards.
    const geom = plan.stream;
    if (!geom) {
      console.warn(
        "[reframe] stream shots without stream geometry - falling back to base crop"
      );
    } else {
      // Outside stream windows the overlays are disabled, so the tile x values
      // there are irrelevant - carry the nearest stream geometry forward so the
      // expressions stay total for every t.
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
        .map(
          (s) =>
            `gte(t,${formatLayoutTime(s.start)})*lt(t,${formatLayoutTime(s.end)})`
        )
        .join("+");
      // setsar=1 after each scale: without it `scale` derives each tile's SAR
      // from its own crop aspect, so the stacked frame is assembled from three
      // different pixel aspects (and ffmpeg 8.x segfaulted here during design).
      const chains = [
        `[0:v]split=3[b0][c0][m0]`,
        `[b0]${baseChain}[base]`,
        `[c0]crop=w=${geom.camCrop.w}:h=${geom.camCrop.h}:x='${piecewiseX(camSegs)}':y=${geom.camCrop.y},scale=1080:${geom.outCamH},setsar=1[cam]`,
        `[m0]crop=w=${geom.contentCrop.w}:h=ih:x='${piecewiseX(contentSegs)}':y=0,scale=1080:${geom.outContentH},setsar=1[cont]`,
        `[base][cam]overlay=x=0:y=0:enable='${enable}'[o1]`,
        assSnippet
          ? `[o1][cont]overlay=x=0:y=${geom.outCamH}:enable='${enable}'[o2]`
          : `[o1][cont]overlay=x=0:y=${geom.outCamH}:enable='${enable}'[vout]`,
      ];
      if (assSnippet) chains.push(`[o2]${assSnippet}[vout]`);
      return { kind: "complex", graph: chains.join(";") };
    }
  }

  if (splits.length === 0) {
    const ass = assSnippet ? `,${assSnippet}` : "";
    return { kind: "vf", graph: `${baseChain}${ass}` };
  }

  // Outside split windows the overlays are disabled, so tile x values there
  // are irrelevant - carry the nearest split geometry to keep expressions total.
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
  // Half-open [start,end) matches piecewiseX's lt(t,end) switch; between() is
  // inclusive at end, which flashes the overlay one frame past the seam.
  const enable = splits
    .map(
      (s) =>
        `gte(t,${formatLayoutTime(s.start)})*lt(t,${formatLayoutTime(s.end)})`
    )
    .join("+");

  const chains = [
    `[0:v]split=3[b0][t0][m0]`,
    `[b0]${baseChain}[base]`,
    // setsar=1 for the same reason as the base and the stream tiles:
    // crop=1216 scaled to 1080x960 is the identical 1216:1215 fraction, and
    // overlay inputs must agree on pixel aspect before they meet.
    `[t0]crop=w=${tileW}:h=ih:x='${piecewiseX(topSegs)}':y=0,scale=1080:960,setsar=1[top]`,
    `[m0]crop=w=${tileW}:h=ih:x='${piecewiseX(botSegs)}':y=0,scale=1080:960,setsar=1[bottom]`,
    `[base][top]overlay=x=0:y=0:enable='${enable}'[o1]`,
    assSnippet
      ? `[o1][bottom]overlay=x=0:y=960:enable='${enable}'[o2]`
      : `[o1][bottom]overlay=x=0:y=960:enable='${enable}'[vout]`,
  ];
  if (assSnippet) chains.push(`[o2]${assSnippet}[vout]`);
  return { kind: "complex", graph: chains.join(";") };
}
