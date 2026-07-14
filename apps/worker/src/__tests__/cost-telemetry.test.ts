import { describe, expect, it } from "vitest";
import { buildJobCostTelemetry } from "../cost-telemetry";

describe("buildJobCostTelemetry", () => {
  it("estimates per-job costs and timing fields from source duration and measured timings", () => {
    const telemetry = buildJobCostTelemetry({
      sourceDurationSec: 3600,
      processingStartedAt: new Date("2026-05-09T10:00:00Z"),
      processingEndedAt: new Date("2026-05-09T10:12:30Z"),
      transcribeMs: 90_000,
      analyzeMs: 8_000,
      renderMs: 420_000,
      clipsGenerated: 4,
      transcriptionModel: "whisper-1",
    });

    expect(telemetry).toEqual({
      processingStartedAt: new Date("2026-05-09T10:00:00Z"),
      processingEndedAt: new Date("2026-05-09T10:12:30Z"),
      processingMs: 750_000,
      transcribeMs: 90_000,
      analyzeMs: 8_000,
      renderMs: 420_000,
      clipsGenerated: 4,
      estimatedTranscriptionCostUsd: 0.36,
      estimatedAnalysisCostUsd: 0.003,
      estimatedComputeCostUsd: 0.36,
      estimatedTotalCostUsd: 0.723,
    });
  });

  it("uses the lower transcription rate for gpt-4o-mini-transcribe", () => {
    const telemetry = buildJobCostTelemetry({
      sourceDurationSec: 600,
      processingStartedAt: new Date("2026-05-09T10:00:00Z"),
      processingEndedAt: new Date("2026-05-09T10:01:00Z"),
      transcribeMs: 10_000,
      analyzeMs: 2_000,
      renderMs: 20_000,
      clipsGenerated: 1,
      transcriptionModel: "gpt-4o-mini-transcribe",
    });

    expect(telemetry.estimatedTranscriptionCostUsd).toBe(0.03);
    expect(telemetry.estimatedTotalCostUsd).toBe(0.091);
  });

  it("uses real token usage for analysis cost when tokens are present", () => {
    const telemetry = buildJobCostTelemetry({
      sourceDurationSec: 3600,
      processingStartedAt: new Date("2026-07-14T10:00:00Z"),
      processingEndedAt: new Date("2026-07-14T10:10:00Z"),
      transcribeMs: 90_000,
      analyzeMs: 20_000,
      renderMs: 420_000,
      clipsGenerated: 8,
      transcriptionModel: "whisper-1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      criticModel: "gpt-5.1",
    });
    // 46000/1M * 1.25 + 11500/1M * 10.0 = 0.0575 + 0.115 = 0.1725 -> rounded 0.173
    expect(telemetry.estimatedAnalysisCostUsd).toBe(0.173);
  });

  it("falls back to the flat per-minute estimate without token data", () => {
    const telemetry = buildJobCostTelemetry({
      sourceDurationSec: 3600,
      processingStartedAt: new Date("2026-07-14T10:00:00Z"),
      processingEndedAt: new Date("2026-07-14T10:10:00Z"),
      transcribeMs: 90_000,
      analyzeMs: 8_000,
      renderMs: 420_000,
      clipsGenerated: 4,
      transcriptionModel: "whisper-1",
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBe(0.003);
  });
});
