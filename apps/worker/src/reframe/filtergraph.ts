import type { CropPlan, FilterSpec, ShotLayout } from "./types";
import { cropWidthFor, evenClamp, tileWidthFor } from "./plan";

type SplitLayout = Extract<ShotLayout, { layout: "split" }>;

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
 * No split shots -> plain -vf chain. Any split shot -> -filter_complex with
 * two time-enabled overlay tiles; the caller must map "[vout]" + audio.
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

  const baseX = piecewiseX(
    plan.shots.map((s) => ({ end: s.end, x: s.layout === "split" ? centerX : s.x }))
  );
  const baseChain = `crop=w=${cropW}:h=ih:x='${baseX}':y=0,scale=1080:1920`;

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
