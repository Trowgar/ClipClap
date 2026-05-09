const TRANSCRIPTION_COST_PER_MINUTE: Record<string, number> = {
  "gpt-4o-mini-transcribe": 0.003,
  "whisper-1": 0.006,
};

const DEFAULT_TRANSCRIPTION_COST_PER_MINUTE = 0.006;
const ANALYSIS_COST_PER_MINUTE = 0.00005;
const COMPUTE_COST_PER_MINUTE = 0.006;

export interface JobCostTelemetryInput {
  sourceDurationSec: number | null | undefined;
  processingStartedAt: Date;
  processingEndedAt: Date;
  transcribeMs: number;
  analyzeMs: number;
  renderMs: number;
  clipsGenerated: number;
  transcriptionModel?: string;
}

export function buildJobCostTelemetry(input: JobCostTelemetryInput) {
  const sourceMinutes = Math.max(0, (input.sourceDurationSec ?? 0) / 60);
  const transcriptionRate =
    TRANSCRIPTION_COST_PER_MINUTE[input.transcriptionModel ?? ""] ??
    DEFAULT_TRANSCRIPTION_COST_PER_MINUTE;

  const estimatedTranscriptionCostUsd = roundUsd(
    sourceMinutes * transcriptionRate
  );
  const estimatedAnalysisCostUsd = roundUsd(
    sourceMinutes * ANALYSIS_COST_PER_MINUTE
  );
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
