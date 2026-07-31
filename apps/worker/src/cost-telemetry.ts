import {
  audioPricePerMinute,
  tokenPrice,
  type ModelPrices,
} from "@clipclap/shared";

/**
 * What a job cost, computed from facts.
 *
 * There is no price table in this file, and there must never be one again. The
 * old table went stale the moment a provider moved a price, and its
 * DEFAULT_TOKEN_PRICE fallback meant an unpriced model got gpt-5.1's price -
 * a confident wrong number rather than no number. Prices now arrive from the
 * environment (see @clipclap/shared model-prices) and an unknown model yields
 * null.
 *
 * Two fabricated constants were removed with it:
 *   - COMPUTE_COST_PER_MINUTE = 0.006, a hand-entered guess that happened to
 *     equal whisper's rate, which is why the compute column mirrored the
 *     transcription column in every row ever written. It is now an env rate,
 *     unset by default.
 *   - ANALYSIS_COST_PER_MINUTE = 0.00005, the no-token-usage fallback.
 *
 * estimatedTotalCostUsd is CASH ONLY (transcription + analysis) and is null
 * unless both parts are known. It deliberately excludes compute: the server is
 * rented whether a job runs or not, so compute is not money leaving the account
 * because of this job. free-settlement.ts sums the two cash lines directly and
 * documents the same rule - if a third cash line is ever added, add it here and
 * there; if a second non-cash line is added, add it only here.
 */

export interface JobCostTelemetryInput {
  sourceDurationSec: number | null | undefined;
  processingStartedAt: Date;
  processingEndedAt: Date;
  transcribeMs: number;
  analyzeMs: number;
  renderMs: number;
  clipsGenerated: number;
  transcriptionModel: string;
  /** Model whose price dominates analysis cost (the critic). */
  criticModel: string;
  analysisInputTokens?: number | null;
  analysisOutputTokens?: number | null;
  prices: ModelPrices;
  /** USD per source minute of rented capacity. Unset means "do not report it". */
  computeCostPerMinuteUsd?: number | null;
}

export function buildJobCostTelemetry(input: JobCostTelemetryInput) {
  const sourceMinutes = Math.max(0, (input.sourceDurationSec ?? 0) / 60);

  const audioRate = audioPricePerMinute(input.prices, input.transcriptionModel);
  const estimatedTranscriptionCostUsd =
    audioRate === undefined ? null : roundUsd(sourceMinutes * audioRate);

  const inputTokens = input.analysisInputTokens ?? 0;
  const outputTokens = input.analysisOutputTokens ?? 0;
  const hasTokenUsage = inputTokens > 0 || outputTokens > 0;
  const critic = tokenPrice(input.prices, input.criticModel);
  const estimatedAnalysisCostUsd =
    hasTokenUsage && critic !== undefined
      ? roundUsd(
          (inputTokens / 1_000_000) * critic.input +
            (outputTokens / 1_000_000) * critic.output
        )
      : null;

  const computeRate = input.computeCostPerMinuteUsd;
  const estimatedComputeCostUsd =
    computeRate === undefined || computeRate === null
      ? null
      : roundUsd(sourceMinutes * computeRate);

  // A partial sum would read exactly like a whole one. Refuse instead.
  const estimatedTotalCostUsd =
    estimatedTranscriptionCostUsd === null || estimatedAnalysisCostUsd === null
      ? null
      : roundUsd(estimatedTranscriptionCostUsd + estimatedAnalysisCostUsd);

  return {
    processingStartedAt: input.processingStartedAt,
    processingEndedAt: input.processingEndedAt,
    processingMs:
      input.processingEndedAt.getTime() - input.processingStartedAt.getTime(),
    transcribeMs: input.transcribeMs,
    analyzeMs: input.analyzeMs,
    renderMs: input.renderMs,
    clipsGenerated: input.clipsGenerated,
    criticModel: input.criticModel,
    transcriptionModel: input.transcriptionModel,
    estimatedTranscriptionCostUsd,
    estimatedAnalysisCostUsd,
    estimatedComputeCostUsd,
    estimatedTotalCostUsd,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1000) / 1000;
}
