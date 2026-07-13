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
});
