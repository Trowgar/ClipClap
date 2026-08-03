import type { CropPlan, FilterSpec, ShotLayout } from "./types";
import { cropWidthFor, evenClamp, tileWidthFor } from "./plan";

type SplitLayout = Extract<ShotLayout, { layout: "split" }>;
type StreamLayout = Extract<ShotLayout, { layout: "stream" }>;

const fmt = (n: number) => n.toFixed(2);

/** Piecewise-constant x(t) over consecutive windows; the last x is the else
 *  branch, so the expression is total for every t. x values are integers. */
export function piecewiseX(segments: Array<{ end: number; x: number }>): string {
  if (segments.length === 0) throw new Error("piecewiseX: empty");
  let expr = String(segments[segments.length - 1].x);
  for (let i = segments.length - 2; i >= 0; i--) {
    expr = `if(lt(t,${fmt(segments[i].end)}),${segments[i].x},${expr})`;
  }
  return expr;
}

/**
 * Compiles a CropPlan (+ optional ass snippet) into a single-pass filter.
 * No tiled shots -> plain -vf chain. Any stream shot (webcam over content) or
 * split shot (two faces) -> -filter_complex with two time-enabled overlay
 * tiles; the caller must map "[vout]" + audio. A plan holding both is not
 * emitted by the planner (spec §9.6); stream wins if one ever appears.
 */
export function buildFiltergraph(plan: CropPlan, assSnippet?: string): FilterSpec {
  const cropW = cropWidthFor(plan.source.height);
  const tileW = tileWidthFor(plan.source.height);
  const centerX = evenClamp(
    (plan.source.width - cropW) / 2,
    cropW,
    plan.source.width
  );
  // Type-guard filter: plain .filter() would not narrow ShotLayout, and the
  // tile-geometry reads below need the split variant.
  const splits = plan.shots.filter(
    (s): s is SplitLayout => s.layout === "split"
  );

  // Tiled layouts cover the whole frame while they are enabled, so the base
  // crop under them is never visible - centre it and keep the expression total.
  const baseX = piecewiseX(
    plan.shots.map((s) => ({
      end: s.end,
      x: s.layout === "split" || s.layout === "stream" ? centerX : s.x,
    }))
  );
  const baseChain = `crop=w=${cropW}:h=ih:x='${baseX}':y=0,scale=1080:1920`;

  // Must stay BELOW baseChain: the branch reads it, and `const` is not hoisted
  // in a usable state - declared beside `splits` this would throw
  // "Cannot access 'baseChain' before initialization" at render time, past
  // every test that only inspects the returned string.
  const streams = plan.shots.filter(
    (s): s is StreamLayout => s.layout === "stream"
  );
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
        .map((s) => `gte(t,${fmt(s.start)})*lt(t,${fmt(s.end)})`)
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
    .map((s) => `gte(t,${fmt(s.start)})*lt(t,${fmt(s.end)})`)
    .join("+");

  const chains = [
    `[0:v]split=3[b0][t0][m0]`,
    `[b0]${baseChain}[base]`,
    `[t0]crop=w=${tileW}:h=ih:x='${piecewiseX(topSegs)}':y=0,scale=1080:960[top]`,
    `[m0]crop=w=${tileW}:h=ih:x='${piecewiseX(botSegs)}':y=0,scale=1080:960[bottom]`,
    `[base][top]overlay=x=0:y=0:enable='${enable}'[o1]`,
    assSnippet
      ? `[o1][bottom]overlay=x=0:y=960:enable='${enable}'[o2]`
      : `[o1][bottom]overlay=x=0:y=960:enable='${enable}'[vout]`,
  ];
  if (assSnippet) chains.push(`[o2]${assSnippet}[vout]`);
  return { kind: "complex", graph: chains.join(";") };
}
