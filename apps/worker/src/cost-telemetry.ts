const TRANSCRIPTION_COST_PER_MINUTE: Record<string, number> = {
  "gpt-4o-mini-transcribe": 0.003,
  "whisper-1": 0.006,
};

const DEFAULT_TRANSCRIPTION_COST_PER_MINUTE = 0.006;
const ANALYSIS_COST_PER_MINUTE = 0.00005;
const COMPUTE_COST_PER_MINUTE = 0.006;

/** USD per 1M tokens (input, output). Estimation only - update with pricing. */
const MODEL_TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-5.1": { input: 1.25, output: 10.0 },
};
const DEFAULT_TOKEN_PRICE = { input: 1.25, output: 10.0 };

export interface JobCostTelemetryInput {
  sourceDurationSec: number | null | undefined;
  processingStartedAt: Date;
  processingEndedAt: Date;
  transcribeMs: number;
  analyzeMs: number;
  renderMs: number;
  clipsGenerated: number;
  transcriptionModel?: string;
  analysisInputTokens?: number | null;
  analysisOutputTokens?: number | null;
  /** Model whose price dominates analysis cost (the critic). */
  criticModel?: string;
}

export function buildJobCostTelemetry(input: JobCostTelemetryInput) {
  const sourceMinutes = Math.max(0, (input.sourceDurationSec ?? 0) / 60);
  const transcriptionRate =
    TRANSCRIPTION_COST_PER_MINUTE[input.transcriptionModel ?? ""] ??
    DEFAULT_TRANSCRIPTION_COST_PER_MINUTE;

  const estimatedTranscriptionCostUsd = roundUsd(
    sourceMinutes * transcriptionRate
  );
  const hasTokenUsage =
    (input.analysisInputTokens ?? 0) > 0 || (input.analysisOutputTokens ?? 0) > 0;
  const tokenPrice =
    MODEL_TOKEN_PRICES[input.criticModel ?? ""] ?? DEFAULT_TOKEN_PRICE;
  const estimatedAnalysisCostUsd = hasTokenUsage
    ? roundUsd(
        ((input.analysisInputTokens ?? 0) / 1_000_000) * tokenPrice.input +
          ((input.analysisOutputTokens ?? 0) / 1_000_000) * tokenPrice.output
      )
    : roundUsd(sourceMinutes * ANALYSIS_COST_PER_MINUTE);
  const estimatedComputeCostUsd = roundUsd(
    sourceMinutes * COMPUTE_COST_PER_MINUTE
  );

  return {
    processingStartedAt: input.processingStartedAt,
    processingEndedAt: input.processingEndedAt,
    processingMs:
      input.processingEndedAt.getTime() - input.processingStartedAt.getTime(),
    transcribeMs: input.transcribeMs,
    analyzeMs: input.analyzeMs,
    renderMs: input.renderMs,
    clipsGenerated: input.clipsGenerated,
    estimatedTranscriptionCostUsd,
    estimatedAnalysisCostUsd,
    estimatedComputeCostUsd,
    estimatedTotalCostUsd: roundUsd(
      estimatedTranscriptionCostUsd +
        estimatedAnalysisCostUsd +
        estimatedComputeCostUsd
    ),
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1000) / 1000;
}
