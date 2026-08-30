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

const DEFAULT_THRESHOLD = 0.9;
// Numerical-only tolerance: this is far below any product coverage margin.
const COVERAGE_EPSILON = Number.EPSILON * 16;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function finiteBox(value: unknown): value is FaceBox {
  const box = record(value);
  if (!box) return false;
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.w) &&
    Number.isFinite(box.h) &&
    (box.w as number) > 0 &&
    (box.h as number) > 0
  );
}

/** Returns the fraction of `region` area covered by `window`. */
export function coverageForBox(region: FaceBox, window: FaceBox): number {
  if (!finiteBox(region) || !finiteBox(window)) return 0;
  const regionArea = region.w * region.h;
  if (!Number.isFinite(regionArea) || !(regionArea > 0)) return 0;

  const overlapW =
    Math.min(region.x + region.w, window.x + window.w) -
    Math.max(region.x, window.x);
  const overlapH =
    Math.min(region.y + region.h, window.y + window.h) -
    Math.max(region.y, window.y);
  if (
    !Number.isFinite(overlapW) ||
    !Number.isFinite(overlapH) ||
    !(overlapW > 0) ||
    !(overlapH > 0)
  ) {
    return 0;
  }
  const intersectionArea = overlapW * overlapH;
  if (!Number.isFinite(intersectionArea)) return 0;
  const result = intersectionArea / regionArea;
  return Number.isFinite(result) ? result : 0;
}

interface Window extends FaceBox {}

function finiteKeyframes(keys: unknown): keys is Keyframe[] | undefined {
  return (
    keys === undefined ||
    (Array.isArray(keys) &&
      keys.every((key) => {
        const value = record(key);
        return !!value && Number.isFinite(value.t) && Number.isFinite(value.x);
      }))
  );
}

function finiteStreamGeometry(plan: unknown, sourceHeight: number): boolean {
  const planRecord = record(plan);
  const stream = record(planRecord?.stream);
  const camCrop = record(stream?.camCrop);
  const contentCrop = record(stream?.contentCrop);
  if (!stream || !camCrop || !contentCrop) return false;
  return (
    Number.isFinite(camCrop.w) &&
    Number.isFinite(camCrop.h) &&
    Number.isFinite(camCrop.y) &&
    Number.isFinite(contentCrop.w) &&
    Number.isFinite(contentCrop.h) &&
    Number.isFinite(stream.outCamH) &&
    Number.isFinite(stream.outContentH) &&
    (camCrop.w as number) > 0 &&
    (camCrop.h as number) > 0 &&
    (camCrop.y as number) >= 0 &&
    (camCrop.y as number) + (camCrop.h as number) <= sourceHeight &&
    (contentCrop.w as number) > 0 &&
    (contentCrop.h as number) === sourceHeight &&
    (stream.outCamH as number) > 0 &&
    (stream.outContentH as number) > 0 &&
    (stream.outCamH as number) + (stream.outContentH as number) === 1920
  );
}

function finiteShot(value: unknown): value is ShotLayout {
  const shot = record(value);
  if (!shot || typeof shot.layout !== "string") return false;
  const start = shot.start as number;
  const end = shot.end as number;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !(end > start)
  ) {
    return false;
  }
  if (shot.layout === "center") return Number.isFinite(shot.x);
  if (shot.layout === "single") {
    return Number.isFinite(shot.x) && finiteKeyframes(shot.xs);
  }
  if (shot.layout === "split") {
    const top = record(shot.top);
    const bottom = record(shot.bottom);
    return !!top && !!bottom && Number.isFinite(top.x) && Number.isFinite(bottom.x);
  }
  if (shot.layout !== "stream") return false;
  const cam = record(shot.cam);
  const content = record(shot.content);
  return !!cam && !!content && Number.isFinite(cam.x) && Number.isFinite(content.x);
}

interface Timeline {
  firstStart: number;
  finalEnd: number;
  hasTrajectory: boolean;
}

function validateTimeline(value: unknown): Timeline | null {
  const plan = record(value);
  const source = record(plan?.source);
  const shots = plan?.shots;
  const sourceWidth = source?.width;
  const sourceHeight = source?.height;
  if (
    !source ||
    !Array.isArray(shots) ||
    shots.length === 0 ||
    typeof sourceWidth !== "number" ||
    typeof sourceHeight !== "number" ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !(sourceWidth > 0) ||
    !(sourceHeight > 0)
  ) {
    return null;
  }
  const planTyped = value as CropPlan;
  const cropWidth = cropWidthFor(sourceHeight);
  if (!Number.isFinite(cropWidth) || cropWidth <= 0 || cropWidth > sourceWidth) {
    return null;
  }
  let previousEnd = Number.NEGATIVE_INFINITY;
  let firstStart = 0;
  let finalEnd = 0;
  let hasTrajectory = false;
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index];
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
    if (shot.layout === "center" || shot.layout === "single") {
      const x = shot.x;
      if (x < 0 || x + cropWidth > sourceWidth) return null;
      if (
        shot.layout === "single" &&
        shot.xs &&
        shot.xs.some((key) => key.x < 0 || key.x + cropWidth > sourceWidth)
      ) {
        return null;
      }
      if (shot.layout === "single" && shot.xs) {
        let previousTime = shot.start;
        for (const key of shot.xs) {
          if (
            key.t < shot.start ||
            key.t > shot.end ||
            key.t < previousTime
          ) {
            return null;
          }
          previousTime = key.t;
        }
      }
    } else if (shot.layout === "split") {
      const tileWidth = tileWidthFor(sourceHeight);
      if (
        !Number.isFinite(tileWidth) ||
        tileWidth <= 0 ||
        tileWidth > sourceWidth ||
        shot.top.x < 0 ||
        shot.bottom.x < 0 ||
        shot.top.x + tileWidth > sourceWidth ||
        shot.bottom.x + tileWidth > sourceWidth
      ) {
        return null;
      }
    } else if (
      !finiteStreamGeometry(planTyped, sourceHeight)
    ) {
      return null;
    } else {
      const stream = planTyped.stream!;
      if (
        shot.cam.x < 0 ||
        shot.cam.x + stream.camCrop.w > sourceWidth ||
        shot.content.x < 0 ||
        shot.content.x + stream.contentCrop.w > sourceWidth
      ) {
        return null;
      }
    }
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
    if (!finiteStreamGeometry(plan, plan.source.height)) return null;
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
  const validThreshold =
    Number.isFinite(threshold) && threshold >= 0 && threshold <= 1;
  const normalizedThreshold = validThreshold ? threshold : DEFAULT_THRESHOLD;
  const regionList = Array.isArray(regions) ? regions : [];

  for (const rawRegion of regionList) {
    const focalRegion = record(rawRegion);
    if (!focalRegion || focalRegion.priority !== "mandatory") continue;
    if (!Array.isArray(focalRegion.samples)) {
      unmappedSamples++;
      continue;
    }
    for (const rawSample of focalRegion.samples) {
      const sample = record(rawSample);
      if (
        !timeline ||
        !validThreshold ||
        !sample ||
        !finiteBox(sample.box) ||
        !Number.isFinite(sample.t) ||
        (sample.t as number) < timeline.firstStart ||
        (sample.t as number) > timeline.finalEnd
      ) {
        unmappedSamples++;
        continue;
      }
      const windows = windowsForSample(plan, timeline, sample.t as number);
      if (!windows || !windows.every((window) => finiteBox(window))) {
        unmappedSamples++;
        continue;
      }

      const coverage = Math.max(
        ...windows.map((window) => coverageForBox(sample.box as FaceBox, window))
      );
      if (!Number.isFinite(coverage)) {
        unmappedSamples++;
        continue;
      }
      evaluatedSamples++;
      minimumCoverage =
        minimumCoverage === null ? coverage : Math.min(minimumCoverage, coverage);
      if (coverage + COVERAGE_EPSILON < normalizedThreshold) rejectedSamples++;
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
    threshold: normalizedThreshold,
    minimumCoverage,
    evaluatedSamples,
    rejectedSamples,
    unmappedSamples,
  };
}
