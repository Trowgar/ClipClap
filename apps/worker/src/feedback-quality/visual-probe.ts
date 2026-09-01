import type { CropPlan, ShotLayout } from "../reframe/types";
import { cropWidthFor, tileWidthFor } from "../reframe/plan";
import type { VisualBox, VisualSample } from "./promote";

export type VisualProbeExec = (file: string, args: readonly string[], options?: Readonly<Record<string, unknown>>) => Promise<{ stdout: string; stderr: string }>;

export type VisualProbeInput = Readonly<{
  referencePath: string;
  highlightStart: number;
  cropPlan: CropPlan | null;
  assPath?: string;
  cues?: readonly unknown[];
  samples: readonly VisualSample[];
  exec: VisualProbeExec;
}>;

export type VisualProbeResult = Readonly<{
  approvedMomentRetained: number;
  approvedWindowOverlap: number;
  contentMatch: number;
  subtitleOverlap: number;
  requiredTextClipped: number;
  requiredSubjectClipped: number;
  focalFailures: number;
  visualMeasured: true;
}>;

type PixelBox = { x: number; y: number; w: number; h: number };
const OUT_W = 1080;
const OUT_H = 1920;
const EPSILON = 1e-6;

function finiteBox(value: VisualBox): void {
  if (![value.x, value.y, value.w, value.h].every(Number.isFinite) || value.x < 0 || value.y < 0 || value.w <= 0 || value.h <= 0 || value.x + value.w > 1 + EPSILON || value.y + value.h > 1 + EPSILON) throw new Error("invalid visual annotation");
}

function area(value: PixelBox): number { return Math.max(0, value.w) * Math.max(0, value.h); }
function overlap(a: PixelBox, b: PixelBox): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

function cropX(layout: ShotLayout, timestamp: number, center: number): number {
  if (layout.layout === "single") {
    const keyframes = layout.xs;
    if (!keyframes?.length) return layout.x;
    if (timestamp <= keyframes[0].t) return keyframes[0].x;
    for (let i = 1; i < keyframes.length; i += 1) {
      if (timestamp <= keyframes[i].t) {
        const previous = keyframes[i - 1];
        const fraction = (timestamp - previous.t) / Math.max(EPSILON, keyframes[i].t - previous.t);
        return previous.x + (keyframes[i].x - previous.x) * fraction;
      }
    }
    return keyframes[keyframes.length - 1].x;
  }
  if (layout.layout === "center") return layout.x;
  if (layout.layout === "split") return center;
  if (layout.layout === "stream") return center;
  return center;
}

function sourceToCrop(box: VisualBox, source: { width: number; height: number }, x: number, y: number, width: number, height: number, outY = 0, outHeight = OUT_H): PixelBox {
  const sourceBox: PixelBox = { x: box.x * source.width, y: box.y * source.height, w: box.w * source.width, h: box.h * source.height };
  return { x: (sourceBox.x - x) * OUT_W / width, y: outY + (sourceBox.y - y) * outHeight / height, w: sourceBox.w * OUT_W / width, h: sourceBox.h * outHeight / height };
}

function sourceToContain(box: VisualBox, source: { width: number; height: number }): PixelBox {
  const scale = Math.min(OUT_W / source.width, OUT_H / source.height);
  const renderedWidth = source.width * scale;
  const renderedHeight = source.height * scale;
  return { x: box.x * renderedWidth + (OUT_W - renderedWidth) / 2, y: box.y * renderedHeight + (OUT_H - renderedHeight) / 2, w: box.w * renderedWidth, h: box.h * renderedHeight };
}

function mapsFor(plan: CropPlan | null, timestamp: number): Array<{ map: (box: VisualBox) => PixelBox }> {
  if (!plan) return [{ map: (box) => sourceToCrop(box, { width: OUT_W, height: OUT_H }, 0, 0, OUT_W, OUT_H) }];
  if (!plan.source || !Number.isFinite(plan.source.width) || !Number.isFinite(plan.source.height) || plan.source.width <= 0 || plan.source.height <= 0) throw new Error("invalid visual crop plan");
  const source = plan.source;
  const shot = plan.shots.find((candidate) => timestamp >= candidate.start && timestamp < candidate.end) ?? plan.shots[plan.shots.length - 1];
  if (!shot) throw new Error("visual crop plan has no shot");
  const center = Math.max(0, (source.width - cropWidthFor(source.height)) / 2);
  if (shot.layout === "safe-fit") return [{ map: (box) => sourceToContain(box, source) }];
  if (shot.layout === "split") {
    const tile = tileWidthFor(source.height);
    return [
      { map: (box) => sourceToCrop(box, source, shot.top.x, 0, tile, source.height, 0, OUT_H / 2) },
      { map: (box) => sourceToCrop(box, source, shot.bottom.x, 0, tile, source.height, OUT_H / 2, OUT_H / 2) },
    ];
  }
  if (shot.layout === "stream" && plan.stream) {
    const geometry = plan.stream;
    return [
      { map: (box) => sourceToCrop(box, source, shot.cam.x, geometry.camCrop.y, geometry.camCrop.w, geometry.camCrop.h, 0, geometry.outCamH) },
      { map: (box) => sourceToCrop(box, source, shot.content.x, 0, geometry.contentCrop.w, source.height, geometry.outCamH, geometry.outContentH) },
    ];
  }
  const width = cropWidthFor(source.height);
  return [{ map: (box) => sourceToCrop(box, source, cropX(shot, timestamp, center), 0, width, source.height) }];
}

function annotatedVisibility(box: VisualBox, maps: ReturnType<typeof mapsFor>, source: CropPlan["source"] | null): number {
  if (!source) return 1;
  return Math.max(...maps.map(({ map }) => {
    const mapped = map(box);
    return overlap(mapped, { x: 0, y: 0, w: OUT_W, h: OUT_H }) / Math.max(EPSILON, area(mapped));
  }));
}

function parseBbox(output: string): PixelBox | null {
  const match = output.match(/x1\s*[:=]\s*(-?\d+).*?x2\s*[:=]\s*(-?\d+).*?y1\s*[:=]\s*(-?\d+).*?y2\s*[:=]\s*(-?\d+)/s);
  if (!match) return null;
  const [x1, x2, y1, y2] = match.slice(1).map(Number);
  if (![x1, x2, y1, y2].every(Number.isFinite) || x2 < x1 || y2 < y1 || x1 < 0 || y1 < 0 || x2 >= OUT_W || y2 >= OUT_H) throw new Error("visual subtitle bbox invalid");
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

async function assertFrame(exec: VisualProbeExec, path: string, timestamp: number): Promise<void> {
  let result: { stdout: string; stderr: string };
  try {
    result = await exec("ffprobe", ["-show_entries", "stream=width,height,nb_read_frames", "-v", "error", "-ss", String(timestamp), "-i", path, "-select_streams", "v:0", "-read_intervals", "0%+0.05", "-count_frames", "-of", "json"]);
  } catch { throw new Error("visual probe frame unavailable"); }
  let parsed: { streams?: Array<{ width?: number; height?: number; nb_read_frames?: string }> };
  try { parsed = JSON.parse(result.stdout) as typeof parsed; } catch { throw new Error("visual probe frame parse failed"); }
  const stream = parsed.streams?.[0];
  if (stream?.width !== OUT_W || stream.height !== OUT_H || Number(stream.nb_read_frames ?? 0) < 1) throw new Error("visual probe frame geometry failed");
}

type FrameComparison = Readonly<{ similarity: number; difference: PixelBox | null }>;

function parseSimilarity(output: string): number {
  const match = output.match(/SSIM\s+Y\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("visual comparison unavailable");
  return value;
}

async function compareFrames(exec: VisualProbeExec, actualPath: string, referencePath: string, timestamp: number): Promise<FrameComparison> {
  let result: { stdout: string; stderr: string };
  try {
    result = await exec("ffmpeg", ["-nostdin", "-v", "info", "-ss", String(timestamp), "-i", actualPath, "-ss", String(timestamp), "-i", referencePath, "-filter_complex", "[0:v][1:v]blend=all_mode=difference,bbox,ssim=stats_file=-", "-frames:v", "1", "-f", "null", "-"]);
  } catch { throw new Error("visual comparison unavailable"); }
  const output = `${result.stdout}\n${result.stderr}`;
  return { similarity: parseSimilarity(output), difference: parseBbox(output) };
}

/** Measures the frozen visual contract against actual sampled output. No
 * annotation, frame, geometry, or ASS probe failure is converted into zero. */
export async function measureVisualReplay(path: string, input: VisualProbeInput): Promise<VisualProbeResult> {
  if (!input.samples.length) throw new Error("visual annotation unavailable");
  if (!Number.isFinite(input.highlightStart) || input.highlightStart < 0 || !input.referencePath) throw new Error("visual reference unavailable");
  if (!input.cropPlan && input.samples.some((sample) => sample.requiredSubjectBoxes.length > 0 || sample.requiredTextBoxes.length > 0 || sample.protectedExistingCaptionBoxes.length > 0)) throw new Error("visual crop plan unavailable");
  let subtitleOverlap = 0;
  let requiredTextClipped = 0;
  let requiredSubjectClipped = 0;
  let contentMismatch = 0;
  let sampledSimilarity = 1;
  for (const sample of input.samples) {
    if (!Number.isFinite(sample.timestamp) || sample.timestamp < 0) throw new Error("invalid visual annotation");
    const relativeTimestamp = sample.timestamp - input.highlightStart;
    if (relativeTimestamp < 0) throw new Error("visual sample outside highlight");
    for (const box of [...sample.requiredSubjectBoxes, ...sample.requiredTextBoxes, ...sample.protectedExistingCaptionBoxes]) finiteBox(box);
    await assertFrame(input.exec, path, relativeTimestamp);
    await assertFrame(input.exec, input.referencePath, relativeTimestamp);
    const comparison = await compareFrames(input.exec, path, input.referencePath, relativeTimestamp);
    sampledSimilarity = Math.min(sampledSimilarity, comparison.similarity);
    const cues = input.cues ?? [];
    const activeCue = cues.some((cue) => {
      if (!cue || typeof cue !== "object") return false;
      const item = cue as { start?: unknown; end?: unknown };
      return typeof item.start === "number" && typeof item.end === "number" && relativeTimestamp >= item.start && relativeTimestamp < item.end;
    });
    if (activeCue && !comparison.difference) throw new Error("visual subtitle pixels unavailable");
    if (!activeCue && comparison.similarity < 0.98) contentMismatch += 1;
    const maps = mapsFor(input.cropPlan, relativeTimestamp);
    const subjectFailures = sample.requiredSubjectBoxes.filter((box) => annotatedVisibility(box, maps, input.cropPlan?.source ?? null) < 0.9).length;
    const textFailures = sample.requiredTextBoxes.filter((box) => annotatedVisibility(box, maps, input.cropPlan?.source ?? null) < 0.9).length;
    requiredSubjectClipped += subjectFailures;
    requiredTextClipped += textFailures;
    if (activeCue && !input.assPath) throw new Error("visual subtitle annotation unavailable");
    if (activeCue && comparison.difference) {
      const protectedBoxes = [...sample.protectedExistingCaptionBoxes, ...sample.requiredTextBoxes].flatMap((box) => maps.map(({ map }) => map(box)));
      subtitleOverlap += protectedBoxes.some((box) => overlap(comparison.difference!, box) > 0) ? 1 : 0;
    }
  }
  const contentMatch = contentMismatch === 0 ? 1 : 0;
  return { subtitleOverlap, requiredTextClipped, requiredSubjectClipped, focalFailures: requiredSubjectClipped, approvedMomentRetained: contentMatch, approvedWindowOverlap: sampledSimilarity, contentMatch, visualMeasured: true };
}
