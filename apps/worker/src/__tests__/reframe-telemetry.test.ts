import { describe, expect, it } from "vitest";
import { buildReframeCheck, markEncodeFailed } from "../reframe/telemetry";
import type { CropPlan } from "../reframe/types";

const streamPlan: CropPlan = {
  version: 2,
  engine: "faces",
  source: { width: 1280, height: 720 },
  profile: { class: "stream", faceFrac: 0.034, camRectScore: 4.7 },
  stream: {
    camCrop: { w: 336, h: 240, y: 0 },
    contentCrop: { w: 676, h: 720 },
    outCamH: 770,
    outContentH: 1150,
  },
  shots: [
    { start: 0, end: 10, layout: "stream", cam: { x: 32 }, content: { x: 428 } },
  ],
};

const cutRecovery = {
  candidates: 5,
  confirmed: 1,
  rejected: { noTurnover: 3, oneSideEmpty: 1, tooShort: 0, noPath: 0 },
  capHit: 0,
};

const safetyShadow = {
  status: "fail" as const,
  threshold: 0.9,
  minimumCoverage: 0.72,
  evaluatedSamples: 8,
  rejectedSamples: 2,
  unmappedSamples: 1,
};

const safetyPlanner = {
  mode: "active" as const,
  evaluatedShots: 2,
  safeFitShots: 1,
  coverageFallbacks: 1,
  invalidEvidenceFallbacks: 0,
  minimumCoverage: 0.72,
};

describe("buildReframeCheck", () => {
  it("carries the profile and the layout counts", () => {
    expect(
      buildReframeCheck({ plan: streamPlan, shotCount: 1, detectMs: 900 })
    ).toEqual({
      shotCount: 1,
      detectMs: 900,
      layouts: { single: 0, split: 0, center: 0, stream: 1 },
      profile: { class: "stream", faceFrac: 0.034, camRectScore: 4.7 },
    });
  });

  it("records why there is no plan, and omits layouts entirely", () => {
    const check = buildReframeCheck({
      plan: null,
      shotCount: 3,
      detectMs: 120,
      fallbackReason: "timeout",
    });
    expect(check).toEqual({ shotCount: 3, detectMs: 120, fallbackReason: "timeout" });
    expect("layouts" in check).toBe(false);
  });

  it("keeps a v1 plan's counts and omits the absent profile", () => {
    const v1: CropPlan = {
      version: 1,
      engine: "faces",
      source: { width: 1920, height: 1080 },
      shots: [{ start: 0, end: 5, layout: "center", x: 656 }],
    };
    const check = buildReframeCheck({ plan: v1, shotCount: 1, detectMs: 50 });
    expect(check.layouts).toEqual({ single: 0, split: 0, center: 1, stream: 0 });
    expect("profile" in check).toBe(false);
  });

  it("carries the cut-recovery telemetry when it ran, and omits it when it did not", () => {
    const v1: CropPlan = {
      version: 1,
      engine: "faces",
      source: { width: 1920, height: 1080 },
      shots: [{ start: 0, end: 5, layout: "center", x: 656 }],
    };
    expect(
      buildReframeCheck({ plan: v1, shotCount: 1, detectMs: 50, cutRecovery }).cutRecovery
    ).toEqual(cutRecovery);
    expect("cutRecovery" in buildReframeCheck({ plan: v1, shotCount: 1, detectMs: 50 })).toBe(
      false
    );
  });

  it("copies only aggregate safety-shadow telemetry and omits it when absent", () => {
    const check = buildReframeCheck({
      plan: streamPlan,
      shotCount: 1,
      detectMs: 50,
      safetyShadow,
    });
    expect(check.safetyShadow).toEqual(safetyShadow);
    expect(
      "safetyShadow" in
        buildReframeCheck({ plan: streamPlan, shotCount: 1, detectMs: 50 })
    ).toBe(false);

    const keys = new Set<string>();
    const collectKeys = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        collectKeys(child);
      }
    };
    collectKeys(check);
    for (const forbidden of [
      "box",
      "x",
      "y",
      "path",
      "id",
      "userId",
      "storageKey",
      "url",
      "sourcePath",
      "regions",
      "samples",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("copies only aggregate active safety-planner telemetry", () => {
    const check = buildReframeCheck({
      plan: streamPlan,
      shotCount: 1,
      detectMs: 50,
      safetyPlanner,
    });
    expect(check.safetyPlanner).toEqual(safetyPlanner);
    expect(Object.keys(check.safetyPlanner!)).toEqual([
      "mode",
      "evaluatedShots",
      "safeFitShots",
      "coverageFallbacks",
      "invalidEvidenceFallbacks",
      "minimumCoverage",
    ]);
  });

  it("marks a check as an encode failure without inventing layouts", () => {
    const check = buildReframeCheck({ plan: streamPlan, shotCount: 1, detectMs: 900 });
    expect(markEncodeFailed(check)).toEqual({
      shotCount: 1,
      detectMs: 900,
      profile: { class: "stream", faceFrac: 0.034, camRectScore: 4.7 },
      fallbackReason: "encode_failed",
    });
    const withCutRecovery = buildReframeCheck({
      plan: streamPlan,
      shotCount: 1,
      detectMs: 900,
      cutRecovery,
    });
    expect(markEncodeFailed(withCutRecovery).cutRecovery).toEqual(cutRecovery);

    const withSafetyShadow = buildReframeCheck({
      plan: streamPlan,
      shotCount: 1,
      detectMs: 900,
      fallbackReason: "encode_failed",
      safetyShadow,
    });
    expect(markEncodeFailed(withSafetyShadow)).toEqual({
      shotCount: 1,
      detectMs: 900,
      profile: streamPlan.profile,
      fallbackReason: "encode_failed",
      safetyShadow,
    });

    const withSafetyPlanner = buildReframeCheck({
      plan: streamPlan,
      shotCount: 1,
      detectMs: 900,
      safetyPlanner,
    });
    expect(markEncodeFailed(withSafetyPlanner)).toEqual({
      shotCount: 1,
      detectMs: 900,
      profile: streamPlan.profile,
      fallbackReason: "encode_failed",
      safetyPlanner,
    });
  });
});
