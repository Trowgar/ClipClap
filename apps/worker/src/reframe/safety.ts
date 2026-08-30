import type { FocalRegionTrack } from "./regions";
import { cropWidthFor, evenClamp, tileWidthFor } from "./geometry";
import {
  interpolateRenderedTrajectory,
  roundLayoutTime,
} from "./render-time";
import type { CropPlan, FaceBox, Keyframe, ShotLayout } from "./types";

export interface SafetyShadowTelemetry {
  status: "not_evaluable" | "pass" | "fail";
  threshold: number;
  minimumCoverage: number | null;
  evaluatedSamples: number;
  rejectedSamples: number;
  unmappedSamples: number;
}

function finiteBox(box: FaceBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.w) &&
    Number.isFinite(box.h) &&
    box.w > 0 &&
    box.h > 0
  );
}

/** Returns the fraction of `region` area covered by `window`. */
export function coverageForBox(region: FaceBox, window: FaceBox): number {
  if (!finiteBox(region) || !finiteBox(window)) return 0;

  const overlapW =
    Math.min(region.x + region.w, window.x + window.w) -
    Math.max(region.x, window.x);
  const overlapH =
    Math.min(region.y + region.h, window.y + window.h) -
    Math.max(region.y, window.y);
  if (!(overlapW > 0) || !(overlapH > 0)) return 0;
  return (overlapW * overlapH) / (region.w * region.h);
}

interface Window extends FaceBox {}

function finiteKeyframes(keys: Keyframe[] | undefined): boolean {
  return (
    keys === undefined ||
    keys.every((key) => Number.isFinite(key.t) && Number.isFinite(key.x))
  );
}

function finiteStreamGeometry(plan: CropPlan): boolean {
  const stream = plan.stream;
  if (!stream) return false;
  return (
    Number.isFinite(stream.camCrop.w) &&
    Number.isFinite(stream.camCrop.h) &&
    Number.isFinite(stream.camCrop.y) &&
    Number.isFinite(stream.contentCrop.w) &&
    Number.isFinite(stream.contentCrop.h) &&
    Number.isFinite(stream.outCamH) &&
    Number.isFinite(stream.outContentH) &&
    stream.camCrop.w > 0 &&
    stream.camCrop.h > 0 &&
    stream.camCrop.y >= 0 &&
    stream.contentCrop.w > 0 &&
    stream.contentCrop.h > 0 &&
    stream.outCamH > 0 &&
    stream.outContentH > 0
  );
}

function finiteShot(shot: ShotLayout): boolean {
  if (
    !Number.isFinite(shot.start) ||
    !Number.isFinite(shot.end) ||
    !(shot.end > shot.start)
  ) {
    return false;
  }
  if (shot.layout === "center") return Number.isFinite(shot.x);
  if (shot.layout === "single") {
    return Number.isFinite(shot.x) && finiteKeyframes(shot.xs);
  }
  if (shot.layout === "split") {
    return Number.isFinite(shot.top.x) && Number.isFinite(shot.bottom.x);
  }
  return Number.isFinite(shot.cam.x) && Number.isFinite(shot.content.x);
}

interface Timeline {
  firstStart: number;
  finalEnd: number;
  hasTrajectory: boolean;
}

function validateTimeline(plan: CropPlan): Timeline | null {
  if (
    !Number.isFinite(plan.source.width) ||
    !Number.isFinite(plan.source.height) ||
    !(plan.source.width > 0) ||
    !(plan.source.height > 0) ||
    plan.shots.length === 0
  ) {
    return null;
  }
  let previousEnd = Number.NEGATIVE_INFINITY;
  let firstStart = 0;
  let finalEnd = 0;
  let hasTrajectory = false;
  for (let index = 0; index < plan.shots.length; index++) {
    const shot = plan.shots[index];
    if (!finiteShot(shot)) return null;
    const start = roundLayoutTime(shot.start);
    const end = roundLayoutTime(shot.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) {
      return null;
    }
    if (index === 0) firstStart = start;
    if (start < previousEnd) return null;
    previousEnd = end;
    finalEnd = end;
    if (shot.layout === "stream" && !finiteStreamGeometry(plan)) return null;
    if (shot.layout === "single" && shot.xs && shot.xs.length > 0) {
      hasTrajectory = true;
    }
  }
  return { firstStart, finalEnd, hasTrajectory };
}

function centerXFor(plan: CropPlan): number {
  const cropWidth = cropWidthFor(plan.source.height);
  return evenClamp(
    (plan.source.width - cropWidth) / 2,
    cropWidth,
    plan.source.width
  );
}

function baseXForShot(shot: ShotLayout, centerX: number): number {
  return shot.layout === "split" || shot.layout === "stream" ? centerX : shot.x;
}

function planKeyframes(plan: CropPlan, centerX: number): Keyframe[] {
  const keys: Keyframe[] = [];
  for (const shot of plan.shots) {
    if (shot.layout === "single" && shot.xs && shot.xs.length > 0) {
      keys.push(...shot.xs);
    } else {
      const x = baseXForShot(shot, centerX);
      keys.push({ t: shot.start, x }, { t: shot.end, x });
    }
  }
  return keys;
}

function baseXAt(plan: CropPlan, timeline: Timeline, t: number): number {
  const centerX = centerXFor(plan);
  if (timeline.hasTrajectory) {
    return interpolateRenderedTrajectory(planKeyframes(plan, centerX), t);
  }

  // This is the numeric equivalent of filtergraph.piecewiseX: each rounded
  // end is a strict switch and the last shot is the total fallback branch.
  for (let index = 0; index < plan.shots.length - 1; index++) {
    if (t < roundLayoutTime(plan.shots[index].end)) {
      return baseXForShot(plan.shots[index], centerX);
    }
  }
  return baseXForShot(plan.shots[plan.shots.length - 1], centerX);
}

function activeCompositesAt(
  plan: CropPlan,
  t: number
): Array<Extract<ShotLayout, { layout: "split" | "stream" }>> {
  return plan.shots.filter((shot) => {
    if (shot.layout !== "split" && shot.layout !== "stream") return false;
    const start = roundLayoutTime(shot.start);
    const end = roundLayoutTime(shot.end);
    return t >= start && t < end;
  }) as Array<Extract<ShotLayout, { layout: "split" | "stream" }>>;
}

function windowsForSample(
  plan: CropPlan,
  timeline: Timeline,
  t: number
): Window[] | null {
  const composites = activeCompositesAt(plan, t);
  if (composites.length > 1) return null;
  if (composites.length === 1) {
    const shot = composites[0];
    if (shot.layout === "split") {
      const width = tileWidthFor(plan.source.height);
      // MAX, never union: a face split across two tiles must not pass because
      // the disjoint visible pieces happen to cover its total bounding box.
      return [
        { x: shot.top.x, y: 0, w: width, h: plan.source.height },
        { x: shot.bottom.x, y: 0, w: width, h: plan.source.height },
      ];
    }
    if (!finiteStreamGeometry(plan)) return null;
    return [
      {
        x: shot.cam.x,
        y: plan.stream!.camCrop.y,
        w: plan.stream!.camCrop.w,
        h: plan.stream!.camCrop.h,
      },
      {
        x: shot.content.x,
        y: 0,
        w: plan.stream!.contentCrop.w,
        h: plan.stream!.contentCrop.h,
      },
    ];
  }

  const x = baseXAt(plan, timeline, t);
  return [{ x, y: 0, w: cropWidthFor(plan.source.height), h: plan.source.height }];
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
  const timeline = validateTimeline(plan);
  const validThreshold = Number.isFinite(threshold);

  for (const focalRegion of regions) {
    if (focalRegion.priority !== "mandatory") continue;
    for (const sample of focalRegion.samples) {
      if (
        !timeline ||
        !validThreshold ||
        !finiteBox(sample.box) ||
        !Number.isFinite(sample.t) ||
        sample.t < timeline.firstStart ||
        sample.t > timeline.finalEnd
      ) {
        unmappedSamples++;
        continue;
      }
      const windows = windowsForSample(plan, timeline, sample.t);
      if (!windows) {
        unmappedSamples++;
        continue;
      }

      const coverage = Math.max(
        ...windows.map((window) => coverageForBox(sample.box, window))
      );
      if (!Number.isFinite(coverage)) {
        unmappedSamples++;
        continue;
      }
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
