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
});
