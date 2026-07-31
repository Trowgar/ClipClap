import { describe, expect, it } from "vitest";
import { loadModelPrices } from "@clipclap/shared";
import { buildJobCostTelemetry } from "../cost-telemetry";

const PRICES = loadModelPrices(
  {
    MODEL_PRICES_JSON: JSON.stringify({
      tokensPerMillionUsd: { "gpt-5.1": { input: 1.25, output: 10 } },
      audioPerMinuteUsd: { "whisper-1": 0.006, "gpt-4o-mini-transcribe": 0.003 },
    }),
  },
  () => {}
);

const BASE = {
  processingStartedAt: new Date("2026-07-31T10:00:00Z"),
  processingEndedAt: new Date("2026-07-31T10:12:30Z"),
  transcribeMs: 90_000,
  analyzeMs: 8_000,
  renderMs: 420_000,
  clipsGenerated: 4,
};

describe("buildJobCostTelemetry", () => {
  it("prices transcription per audio minute and analysis per token", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
    });

    // 60 min * 0.006 = 0.36
    expect(telemetry.estimatedTranscriptionCostUsd).toBe(0.36);
    // 46000/1M * 1.25 + 11500/1M * 10 = 0.0575 + 0.115 = 0.1725 -> 0.173
    expect(telemetry.estimatedAnalysisCostUsd).toBe(0.173);
    expect(telemetry.estimatedTotalCostUsd).toBe(0.533);
  });

  it("uses the transcription model's own rate", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 600,
      transcriptionModel: "gpt-4o-mini-transcribe",
      criticModel: "gpt-5.1",
      analysisInputTokens: 1_000_000,
      analysisOutputTokens: 0,
      prices: PRICES,
    });
    expect(telemetry.estimatedTranscriptionCostUsd).toBe(0.03);
    expect(telemetry.estimatedAnalysisCostUsd).toBe(1.25);
  });

  it("writes null, not a fallback, when the critic model has no price", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "a-model-nobody-priced",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBeNull();
    // and the total refuses to be a partial sum that reads like a whole one
    expect(telemetry.estimatedTotalCostUsd).toBeNull();
    // the part we DO know is still reported
    expect(telemetry.estimatedTranscriptionCostUsd).toBe(0.36);
  });

  it("writes null when the transcription model has no price", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "an-asr-nobody-priced",
      criticModel: "gpt-5.1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
    });
    expect(telemetry.estimatedTranscriptionCostUsd).toBeNull();
    expect(telemetry.estimatedTotalCostUsd).toBeNull();
  });

  it("writes null analysis cost when no tokens were recorded, with no per-minute invention", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      prices: PRICES,
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBeNull();
    expect(telemetry.estimatedTotalCostUsd).toBeNull();
  });

  it("omits compute cost unless a rate is configured", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
    });
    expect(telemetry.estimatedComputeCostUsd).toBeNull();
    // total is cash only, so it does not carry the compute line
    expect(telemetry.estimatedTotalCostUsd).toBe(0.533);
  });

  it("includes compute cost when a rate is configured, without changing the cash total", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
      computeCostPerMinuteUsd: 0.006,
    });
    expect(telemetry.estimatedComputeCostUsd).toBe(0.36);
    expect(telemetry.estimatedTotalCostUsd).toBe(0.533);
  });

  it("passes timing fields through untouched", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      prices: PRICES,
    });
    expect(telemetry.processingMs).toBe(750_000);
    expect(telemetry.transcribeMs).toBe(90_000);
    expect(telemetry.analyzeMs).toBe(8_000);
    expect(telemetry.renderMs).toBe(420_000);
    expect(telemetry.clipsGenerated).toBe(4);
  });

  it("records the models that produced the figures", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      prices: PRICES,
    });
    expect(telemetry.criticModel).toBe("gpt-5.1");
    expect(telemetry.transcriptionModel).toBe("whisper-1");
  });
});
