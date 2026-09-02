import { describe, expect, it } from "vitest";
import { loadAnalyzeConfig } from "../analyze-v2/config";

describe("loadAnalyzeConfig", () => {
  it("returns spec defaults when env is empty", () => {
    const cfg = loadAnalyzeConfig({});
    expect(cfg.engine).toBe("legacy");
    expect(cfg.scanModel).toBe("gpt-4o-mini");
    expect(cfg.criticModel).toBe("gpt-5.6-luna");
    expect(cfg.scoreThreshold).toBe(0.6);
    expect(cfg.weakFallbackMinScore).toBe(0.35);
    expect(cfg.softCap).toBe(12);
    expect(cfg.hardMinSec).toBe(6);
    expect(cfg.targetMinSec).toBe(8);
    expect(cfg.maxSec).toBe(90);
    expect(cfg.criticBatchSize).toBe(6);
    expect(cfg.v2Pct).toBe(0);
    expect(cfg.visualRecallMode).toBe("off");
    expect(cfg.visualRecallMaxCandidates).toBe(15);
    expect(cfg.visualRecallClusterSec).toBe(12);
    expect(cfg.visualRecallPreSec).toBe(8);
    expect(cfg.visualRecallPostSec).toBe(18);
    expect(cfg.visualRecallMaxNodeDistanceSec).toBe(20);
  });

  it("accepts only the closed visual recall rollout modes", () => {
    expect(loadAnalyzeConfig({ ANALYZE_VISUAL_RECALL_V1: "off" }).visualRecallMode).toBe("off");
    expect(loadAnalyzeConfig({ ANALYZE_VISUAL_RECALL_V1: "shadow" }).visualRecallMode).toBe("shadow");
    expect(loadAnalyzeConfig({ ANALYZE_VISUAL_RECALL_V1: "on" }).visualRecallMode).toBe("on");
    expect(loadAnalyzeConfig({ ANALYZE_VISUAL_RECALL_V1: "yes" }).visualRecallMode).toBe("off");
    expect(loadAnalyzeConfig({ ANALYZE_VISUAL_RECALL_V1: "ON" }).visualRecallMode).toBe("off");
  });

  it("uses positive bounded visual recall overrides and defaults invalid values", () => {
    expect(loadAnalyzeConfig({
      VISUAL_RECALL_MAX_CANDIDATES: "4",
      VISUAL_RECALL_CLUSTER_SEC: "7.5",
      VISUAL_RECALL_PRE_SEC: "3",
      VISUAL_RECALL_POST_SEC: "10",
      VISUAL_RECALL_MAX_NODE_DISTANCE_SEC: "15",
    })).toMatchObject({
      visualRecallMaxCandidates: 4,
      visualRecallClusterSec: 7.5,
      visualRecallPreSec: 3,
      visualRecallPostSec: 10,
      visualRecallMaxNodeDistanceSec: 15,
    });
    for (const value of ["0", "-1", "NaN", "Infinity", ""]) {
      expect(loadAnalyzeConfig({ VISUAL_RECALL_MAX_CANDIDATES: value }).visualRecallMaxCandidates).toBe(15);
      expect(loadAnalyzeConfig({ VISUAL_RECALL_CLUSTER_SEC: value }).visualRecallClusterSec).toBe(12);
    }
  });

  it("defaults the post-boundary hook gate to off without limits", () => {
    const cfg = loadAnalyzeConfig({});
    expect(cfg.postBoundaryHookGateMode).toBe("off");
    expect(cfg.postBoundaryHookMaxDelaySec).toBeUndefined();
    expect(cfg.postBoundaryHookMaxPreHookGapSec).toBeUndefined();
  });

  it("accepts exact safe-end audit off or shadow modes only", () => {
    expect(loadAnalyzeConfig({}).safeEndAuditMode).toBe("off");
    expect(loadAnalyzeConfig({ SAFE_END_AUDIT: "  " }).safeEndAuditMode).toBe("off");
    expect(loadAnalyzeConfig({ SAFE_END_AUDIT: "off" }).safeEndAuditMode).toBe("off");
    expect(loadAnalyzeConfig({ SAFE_END_AUDIT: "shadow" }).safeEndAuditMode).toBe("shadow");
    for (const value of ["enforce", "Shadow", "1"]) {
      expect(() => loadAnalyzeConfig({ SAFE_END_AUDIT: value })).toThrow();
    }
  });

  it("accepts limits only for shadow and enforce gate modes", () => {
    expect(() => loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "shadow" })).toThrow();
    expect(() =>
      loadAnalyzeConfig({
        POST_BOUNDARY_HOOK_GATE: "enforce",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "NaN",
        POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "1",
      }),
    ).toThrow();
    expect(() =>
      loadAnalyzeConfig({
        POST_BOUNDARY_HOOK_GATE: "observe",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
      }),
    ).toThrow();
    expect(
      loadAnalyzeConfig({
        POST_BOUNDARY_HOOK_GATE: "shadow",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
        POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "0",
      }),
    ).toMatchObject({
      postBoundaryHookGateMode: "shadow",
      postBoundaryHookMaxDelaySec: 1,
      postBoundaryHookMaxPreHookGapSec: 0,
    });
  });

  it("rejects every invalid post-boundary hook gate mode and numeric limit", () => {
    expect(() => loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "enabled" })).toThrow();

    for (const value of ["", " ", "-1", "Infinity", "-Infinity", "not-a-number"]) {
      for (const invalidLimit of ["POST_BOUNDARY_HOOK_MAX_DELAY_SEC", "POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC"] as const) {
        expect(() =>
          loadAnalyzeConfig({
            POST_BOUNDARY_HOOK_GATE: "enforce",
            POST_BOUNDARY_HOOK_MAX_DELAY_SEC:
              invalidLimit === "POST_BOUNDARY_HOOK_MAX_DELAY_SEC" ? value : "0",
            POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC:
              invalidLimit === "POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC" ? value : "0",
          }),
        ).toThrow();
      }
    }
  });

  it("reads overrides and clamps garbage numbers to defaults", () => {
    const cfg = loadAnalyzeConfig({
      ANALYZE_ENGINE: "recall-critic",
      CLIP_SCORE_THRESHOLD: "0.7",
      CLIP_SOFT_CAP: "not-a-number",
    });
    expect(cfg.engine).toBe("recall-critic");
    expect(cfg.scoreThreshold).toBe(0.7);
    expect(cfg.softCap).toBe(12);
  });

  it("treats blank env values as absent", () => {
    const cfg = loadAnalyzeConfig({ CLIP_SOFT_CAP: "", CLIP_MAX_SEC: "  " });
    expect(cfg.softCap).toBe(12);
    expect(cfg.maxSec).toBe(90);
  });

  it("clamps v2Pct to the 0..100 range", () => {
    expect(loadAnalyzeConfig({ ANALYZE_V2_PCT: "150" }).v2Pct).toBe(100);
    expect(loadAnalyzeConfig({ ANALYZE_V2_PCT: "-5" }).v2Pct).toBe(0);
  });

  it("defaults the finalizer on, at the critic's model and chain", () => {
    const cfg = loadAnalyzeConfig({});
    expect(cfg.finalizerEnabled).toBe(true);
    expect(cfg.finalizerModel).toBe(cfg.criticModel);
    expect(cfg.finalizerHeadroom).toBe(4);
    expect(cfg.hookDedupSimilarity).toBe(0.8);
  });

  it("follows OPENAI_CRITIC_MODEL unless the finalizer is pinned separately", () => {
    expect(loadAnalyzeConfig({ OPENAI_CRITIC_MODEL: "gpt-6" }).finalizerModel).toBe(
      "gpt-6",
    );
    expect(
      loadAnalyzeConfig({
        OPENAI_CRITIC_MODEL: "gpt-6",
        OPENAI_FINALIZER_MODEL: "gpt-5-mini",
      }).finalizerModel,
    ).toBe("gpt-5-mini");
  });

  it("kills the finalizer only on the exact 'off' switch", () => {
    expect(loadAnalyzeConfig({ ANALYZE_FINALIZER: "off" }).finalizerEnabled).toBe(
      false,
    );
    expect(loadAnalyzeConfig({ ANALYZE_FINALIZER: "on" }).finalizerEnabled).toBe(
      true,
    );
    // a typo must not silently disable the stage
    expect(loadAnalyzeConfig({ ANALYZE_FINALIZER: "0" }).finalizerEnabled).toBe(
      true,
    );
  });

  it("arms the standalone filter only for the exact literal on", () => {
    expect(loadAnalyzeConfig({}).standaloneFilterEnabled).toBe(false);
    expect(
      loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "on" }).standaloneFilterEnabled,
    ).toBe(true);
    expect(
      loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "true" }).standaloneFilterEnabled,
    ).toBe(false);
    expect(
      loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "1" }).standaloneFilterEnabled,
    ).toBe(false);
    expect(
      loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "ON" }).standaloneFilterEnabled,
    ).toBe(false);
  });

  it("falls back to legacy for unknown engines and accepts shadow", () => {
    expect(loadAnalyzeConfig({ ANALYZE_ENGINE: "garbage" }).engine).toBe(
      "legacy",
    );
    expect(loadAnalyzeConfig({ ANALYZE_ENGINE: "shadow" }).engine).toBe(
      "shadow",
    );
  });

  it("defaults the scan window budget to 'speech' and switches on the exact literal 'source' only", () => {
    // spec 2026-08-11 "Scan recall remedy": today's behavior (word-bearing
    // spans only) stays the default, and only an exact "source" moves it -
    // the same discipline as every other stage switch in this file (a stray
    // truthy value must not silently double the scanner's candidate pool).
    expect(loadAnalyzeConfig({}).scanWindowBudget).toBe("speech");
    expect(loadAnalyzeConfig({ SCAN_WINDOW_BUDGET: "source" }).scanWindowBudget).toBe(
      "source",
    );
    expect(loadAnalyzeConfig({ SCAN_WINDOW_BUDGET: "garbage" }).scanWindowBudget).toBe(
      "speech",
    );
    expect(loadAnalyzeConfig({ SCAN_WINDOW_BUDGET: "SOURCE" }).scanWindowBudget).toBe(
      "speech",
    );
  });

  it("defaults scanPasses to 1 and accepts a positive integer override", () => {
    // spec 2026-08-11 "Scan recall remedy", Phase B: default 1 is today's
    // behavior byte for byte - the whole harness relies on every fixture
    // exercising this default.
    expect(loadAnalyzeConfig({}).scanPasses).toBe(1);
    expect(loadAnalyzeConfig({ SCAN_PASSES: "2" }).scanPasses).toBe(2);
    expect(loadAnalyzeConfig({ SCAN_PASSES: "5" }).scanPasses).toBe(5);
  });

  it("falls back scanPasses to 1 on garbage, zero, negative and fractional values", () => {
    expect(loadAnalyzeConfig({ SCAN_PASSES: "garbage" }).scanPasses).toBe(1);
    expect(loadAnalyzeConfig({ SCAN_PASSES: "0" }).scanPasses).toBe(1);
    expect(loadAnalyzeConfig({ SCAN_PASSES: "-1" }).scanPasses).toBe(1);
    expect(loadAnalyzeConfig({ SCAN_PASSES: "-3" }).scanPasses).toBe(1);
    expect(loadAnalyzeConfig({ SCAN_PASSES: "1.5" }).scanPasses).toBe(1);
    expect(loadAnalyzeConfig({ SCAN_PASSES: "" }).scanPasses).toBe(1);
    expect(loadAnalyzeConfig({ SCAN_PASSES: "  " }).scanPasses).toBe(1);
  });
});
