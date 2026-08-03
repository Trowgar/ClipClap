import { describe, expect, it } from "vitest";
import { loadModelPrices } from "@clipclap/shared";
import { buildJobCostTelemetry } from "../cost-telemetry";

const PRICES = loadModelPrices(
  {
    MODEL_PRICES_JSON: JSON.stringify({
      tokensPerMillionUsd: {
        "gpt-5.1": { input: 1.25, output: 10 },
        "gpt-5.6-luna": { input: 0.2, output: 1.2 },
        "gpt-5-mini": { input: 0.25, output: 2.0 },
        "gpt-4o-mini": { input: 0.15, output: 0.6 },
      },
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

  it("prices a two-model breakdown as the sum of each at its OWN rate", () => {
    // 1M input on one model and 1M output on the other, chosen so that every
    // wrong reading is a different number: the honest sum is 2.20, everything
    // at luna's rate is 1.40, everything at gpt-5-mini's is 2.25.
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.6-luna",
      analysisInputTokens: 1_000_000,
      analysisOutputTokens: 1_000_000,
      analysisUsageByModel: {
        "gpt-5.6-luna": { inputTokens: 1_000_000, outputTokens: 0 },
        "gpt-5-mini": { inputTokens: 0, outputTokens: 1_000_000 },
      },
      prices: PRICES,
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBe(2.2);
  });

  it("prices the models that ANSWERED even when the config names another", () => {
    // Job cmscht6rp001xq41s5rhjx6q0, 2026-08-03, with the split it must have
    // had: every critic batch and the finalizer failed on gpt-5.6-luna and was
    // re-run on gpt-5-mini, while the scanner ran on gpt-4o-mini throughout.
    // Priced at the CONFIGURED critic's rate this job recorded $0.024.
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 1499,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.6-luna",
      analysisInputTokens: 44_733,
      analysisOutputTokens: 12_198,
      analysisUsageByModel: {
        // 8 failed critic attempts + 2 failed finalizer attempts: the throw
        // carried no usage, so the tokens they really burned are unknown.
        "gpt-5.6-luna": { inputTokens: 0, outputTokens: 0 },
        "gpt-4o-mini": { inputTokens: 12_000, outputTokens: 2_000 },
        "gpt-5-mini": { inputTokens: 32_733, outputTokens: 10_198 },
      },
      prices: PRICES,
    });
    // 0.0030 + 0.0286 = 0.0316 -> 0.032, against the 0.024 that was recorded.
    expect(telemetry.estimatedAnalysisCostUsd).toBe(0.032);
    // ...and the row still records what the deployment ASKED for, which is the
    // only way a reader can see that it is not what ran.
    expect(telemetry.criticModel).toBe("gpt-5.6-luna");
  });

  it("writes null when ONE model in the breakdown has no price, never a partial sum", () => {
    // A sum missing one model reads exactly like a complete one. This is the
    // DEFAULT_TOKEN_PRICE failure in a new place.
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      analysisInputTokens: 1_046_000,
      analysisOutputTokens: 11_500,
      analysisUsageByModel: {
        "gpt-5.1": { inputTokens: 46_000, outputTokens: 11_500 },
        "a-model-nobody-priced": { inputTokens: 1_000_000, outputTokens: 0 },
      },
      prices: PRICES,
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBeNull();
    expect(telemetry.estimatedTotalCostUsd).toBeNull();
    // the half we do know is still reported
    expect(telemetry.estimatedTranscriptionCostUsd).toBe(0.36);
  });

  it("ignores the aggregate columns when a breakdown is present", () => {
    // Belt and braces on the seam: the two are written from the same LlmUsage,
    // so they agree - but if a caller ever passes both and they disagree, the
    // breakdown is the one that names models, and pricing must not silently
    // average them or fall back to the cheaper reading.
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      analysisInputTokens: 999_999_999,
      analysisOutputTokens: 999_999_999,
      analysisUsageByModel: {
        "gpt-4o-mini": { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      },
      prices: PRICES,
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBe(0.75);
  });

  it("falls back to the aggregate columns when the breakdown is absent or empty", () => {
    // Rows analyzed before the breakdown existed, and the legacy engine, keep
    // pricing exactly as they did - imperfect, but unchanged rather than null.
    for (const analysisUsageByModel of [undefined, null, {}]) {
      const telemetry = buildJobCostTelemetry({
        ...BASE,
        sourceDurationSec: 3600,
        transcriptionModel: "whisper-1",
        criticModel: "gpt-5.1",
        analysisInputTokens: 46_000,
        analysisOutputTokens: 11_500,
        analysisUsageByModel,
        prices: PRICES,
      });
      expect(telemetry.estimatedAnalysisCostUsd).toBe(0.173);
    }
  });

  it("writes null for a breakdown that recorded no tokens at all", () => {
    // The degenerate path returns before any LLM call. Zero tokens has always
    // been reported as "no figure", not as a measured $0.
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.6-luna",
      analysisInputTokens: 0,
      analysisOutputTokens: 0,
      analysisUsageByModel: { "gpt-5.6-luna": { inputTokens: 0, outputTokens: 0 } },
      prices: PRICES,
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBeNull();
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
