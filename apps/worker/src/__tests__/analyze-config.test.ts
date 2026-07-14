import { describe, expect, it } from "vitest";
import { loadAnalyzeConfig } from "../analyze-v2/config";

describe("loadAnalyzeConfig", () => {
  it("returns spec defaults when env is empty", () => {
    const cfg = loadAnalyzeConfig({});
    expect(cfg.engine).toBe("legacy");
    expect(cfg.scanModel).toBe("gpt-4o-mini");
    expect(cfg.criticModel).toBe("gpt-5.1");
    expect(cfg.scoreThreshold).toBe(0.6);
    expect(cfg.weakFallbackMinScore).toBe(0.35);
    expect(cfg.softCap).toBe(12);
    expect(cfg.hardMinSec).toBe(6);
    expect(cfg.targetMinSec).toBe(8);
    expect(cfg.maxSec).toBe(90);
    expect(cfg.criticBatchSize).toBe(6);
    expect(cfg.v2Pct).toBe(0);
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

  it("falls back to legacy for unknown engines and accepts shadow", () => {
    expect(loadAnalyzeConfig({ ANALYZE_ENGINE: "garbage" }).engine).toBe(
      "legacy",
    );
    expect(loadAnalyzeConfig({ ANALYZE_ENGINE: "shadow" }).engine).toBe(
      "shadow",
    );
  });
});
