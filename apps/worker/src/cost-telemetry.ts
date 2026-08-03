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
 * Rows written before 2026-07-31 carry two fabricated figures, and their
 * values explain what you are looking at: estimatedComputeCostUsd was
 * sourceMinutes * 0.006, a hand-entered guess that happened to equal
 * whisper's rate, which is why the compute column mirrors the transcription
 * column in every historical row; and estimatedAnalysisCostUsd fell back to
 * sourceMinutes * 0.00005 whenever token usage was missing. Neither is a
 * measurement. Do not re-add either. Compute is now an env rate, unset by
 * default.
 *
 * ANALYSIS IS PRICED PER MODEL, from `analysisUsageByModel` - the model that
 * ANSWERED, not the one the config names. The two differ exactly when a stage
 * degrades to the fallback, which is when the price gap is largest. The
 * breakdown is now Job.analysisUsageByModel, written by stages/analyze.ts in the
 * same update as the totals it decomposes, so it sits on the row it describes
 * and is queryable for margin analysis. The ANALYZE JobStep's outputJson still
 * carries the engine's whole LlmUsage and is read as a fallback for jobs
 * analyzed before that column existed (see stages/finalize.ts, the precedence
 * chain in runFinalizeStage).
 *
 * estimatedTotalCostUsd is CASH ONLY (transcription + analysis) and is null
 * unless both parts are known. It deliberately excludes compute: the server is
 * rented whether a job runs or not, so compute is not money leaving the account
 * because of this job. free-settlement.ts sums the two cash lines directly and
 * documents the same rule - if a third cash line is ever added, add it here and
 * there; if a second non-cash line is added, add it only here.
 */

/** Tokens one model spent on a job. Structurally the persisted half of
 *  analyze-v2's LlmUsage.byModel; `requests` is not needed to price anything. */
export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JobCostTelemetryInput {
  sourceDurationSec: number | null | undefined;
  processingStartedAt: Date;
  processingEndedAt: Date;
  transcribeMs: number;
  analyzeMs: number;
  renderMs: number;
  clipsGenerated: number;
  transcriptionModel: string;
  /** The CONFIGURED critic. Recorded on the job row because a row must stay
   *  re-priceable, and used to price only when no breakdown is available. */
  criticModel: string;
  analysisInputTokens?: number | null;
  analysisOutputTokens?: number | null;
  /**
   * What each model actually spent. AUTHORITATIVE when present: the configured
   * critic is not necessarily the model that answered, and on 2026-08-03 it was
   * not - job cmscht6rp001xq41s5rhjx6q0 priced gpt-5-mini's tokens at
   * gpt-5.6-luna's rates and understated itself by ~48%, which is the figure
   * settleFreeLedger charges against the free-tier budget.
   *
   * Absent from BOTH records (a legacy row, the legacy engine, an unreadable
   * payload) falls back to the aggregate columns at the configured critic's rate
   * - what shipped before, imperfect but unchanged rather than newly null.
   */
  analysisUsageByModel?: Record<string, ModelTokenUsage> | null;
  prices: ModelPrices;
  /** USD per source minute of rented capacity. Unset means "do not report it". */
  computeCostPerMinuteUsd?: number | null;
}

export function buildJobCostTelemetry(input: JobCostTelemetryInput) {
  const sourceMinutes = Math.max(0, (input.sourceDurationSec ?? 0) / 60);

  const audioRate = audioPricePerMinute(input.prices, input.transcriptionModel);
  const estimatedTranscriptionCostUsd =
    audioRate === undefined ? null : roundUsd(sourceMinutes * audioRate);

  const estimatedAnalysisCostUsd = priceAnalysis(input);

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

/**
 * What the analysis cost, priced at the rates of the models that RAN.
 *
 * Each model's own tokens at its own rate, summed. A fallback job really did pay
 * two providers' prices - the failed attempts on the configured model plus the
 * successful ones on the fallback - so the honest figure is the sum, not either
 * side of it. (Tokens burned by an attempt that THREW are not in the breakdown
 * at all: the SDK throws before any usage object exists. This is therefore a
 * floor on a fallback job, and it is still much closer than the old figure.)
 *
 * One unpriced model makes the WHOLE sum null, never a partial: a sum missing
 * one model reads exactly like a complete one, which is the same failure the
 * removed DEFAULT_TOKEN_PRICE used to produce. Same rule as
 * estimatedTotalCostUsd one level up.
 */
function priceAnalysis(input: JobCostTelemetryInput): number | null {
  const byModel = input.analysisUsageByModel;
  if (byModel && Object.keys(byModel).length > 0) {
    let usd = 0;
    let tokens = 0;
    for (const [model, spent] of Object.entries(byModel)) {
      const price = tokenPrice(input.prices, model);
      if (price === undefined) return null;
      const inputTokens = Math.max(0, spent?.inputTokens ?? 0);
      const outputTokens = Math.max(0, spent?.outputTokens ?? 0);
      tokens += inputTokens + outputTokens;
      usd +=
        (inputTokens / 1_000_000) * price.input +
        (outputTokens / 1_000_000) * price.output;
    }
    // A breakdown of nothing is the same state as no token usage at all (the
    // degenerate path returns before any LLM call), and that has always been
    // reported as null rather than as a measured $0.
    return tokens > 0 ? roundUsd(usd) : null;
  }

  const inputTokens = input.analysisInputTokens ?? 0;
  const outputTokens = input.analysisOutputTokens ?? 0;
  const hasTokenUsage = inputTokens > 0 || outputTokens > 0;
  const critic = tokenPrice(input.prices, input.criticModel);
  if (!hasTokenUsage || critic === undefined) return null;
  return roundUsd(
    (inputTokens / 1_000_000) * critic.input +
      (outputTokens / 1_000_000) * critic.output
  );
}

function roundUsd(value: number): number {
  return Math.round(value * 1000) / 1000;
}
