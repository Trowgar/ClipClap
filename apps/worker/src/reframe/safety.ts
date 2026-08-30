import type { FocalRegionTrack } from "./regions";
import { cropWidthFor, tileWidthFor } from "./geometry";
import type { CropPlan, FaceBox, Keyframe, ShotLayout } from "./types";

export interface SafetyShadowTelemetry {
  status: "not_evaluable" | "pass" | "fail";
  threshold: number;
  minimumCoverage: number | null;
  evaluatedSamples: number;
  rejectedSamples: number;
  unmappedSamples: number;
}

/** Returns the fraction of `region` area covered by `window`. */
export function coverageForBox(region: FaceBox, window: FaceBox): number {
  if (!(region.w > 0) || !(region.h > 0)) return 0;

  const overlapW = Math.min(region.x + region.w, window.x + window.w) -
    Math.max(region.x, window.x);
  const overlapH = Math.min(region.y + region.h, window.y + window.h) -
    Math.max(region.y, window.y);
  if (!(overlapW > 0) || !(overlapH > 0)) return 0;
  return (overlapW * overlapH) / (region.w * region.h);
}

interface Window extends FaceBox {}

/** Same flat clipped-ramp expression used by filtergraph.rampX, evaluated at t. */
function trajectoryX(keys: Keyframe[], t: number): number {
  if (keys.length === 0) return 0;
  let x = keys[0].x;
  for (let i = 1; i < keys.length; i++) {
    const previous = keys[i - 1];
    const current = keys[i];
    const delta = current.x - previous.x;
    const duration = Math.max(current.t - previous.t, 0.001);
    const progress = Math.min(1, Math.max(0, (t - previous.t) / duration));
    x += delta * progress;
  }
  return x;
}

function shotIndexAt(shots: ShotLayout[], t: number): number {
  const last = shots.length - 1;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    if (t >= shot.start && (t < shot.end || (i === last && t <= shot.end))) {
      return i;
    }
  }
  return -1;
}

function windowsAt(
  plan: CropPlan,
  shot: ShotLayout,
  t: number
): Window[] | null {
  const height = plan.source.height;
  if (shot.layout === "center") {
    return [{ x: shot.x, y: 0, w: cropWidthFor(height), h: height }];
  }
  if (shot.layout === "single") {
    const x = shot.xs && shot.xs.length > 0
      ? trajectoryX(shot.xs, t)
      : shot.x;
    return [{ x, y: 0, w: cropWidthFor(height), h: height }];
  }
  if (shot.layout === "split") {
    const width = tileWidthFor(height);
    return [
      { x: shot.top.x, y: 0, w: width, h: height },
      { x: shot.bottom.x, y: 0, w: width, h: height },
    ];
  }
  if (!plan.stream) return null;
  return [
    {
      x: shot.cam.x,
      y: plan.stream.camCrop.y,
      w: plan.stream.camCrop.w,
      h: plan.stream.camCrop.h,
    },
    {
      x: shot.content.x,
      y: 0,
      w: plan.stream.contentCrop.w,
      h: plan.stream.contentCrop.h,
    },
  ];
}

export function evaluatePlanCoverage(
  plan: CropPlan,
  regions: FocalRegionTrack[],
  threshold = 0.9
): SafetyShadowTelemetry {
  let evaluatedSamples = 0;
  let rejectedSamples = 0;
  let unmappedSamples = 0;
  let minimumCoverage: number | null = null;

  for (const focalRegion of regions) {
    if (focalRegion.priority !== "mandatory") continue;
    for (const sample of focalRegion.samples) {
      const shotIndex = shotIndexAt(plan.shots, sample.t);
      if (shotIndex < 0) {
        unmappedSamples++;
        continue;
      }
      const windows = windowsAt(plan, plan.shots[shotIndex], sample.t);
      if (!windows) {
        unmappedSamples++;
        continue;
      }

      const coverage = Math.max(
        ...windows.map((window) => coverageForBox(sample.box, window))
      );
      evaluatedSamples++;
      minimumCoverage =
        minimumCoverage === null ? coverage : Math.min(minimumCoverage, coverage);
      if (coverage < threshold) rejectedSamples++;
    }
  }

  const status =
    evaluatedSamples === 0 || unmappedSamples > 0
      ? "not_evaluable"
      : rejectedSamples > 0
        ? "fail"
        : "pass";
  return {
    status,
    threshold,
    minimumCoverage,
    evaluatedSamples,
    rejectedSamples,
    unmappedSamples,
  };
}
