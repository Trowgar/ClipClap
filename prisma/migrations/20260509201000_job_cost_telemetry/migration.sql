-- Add per-job timing and estimated cost telemetry for margin monitoring.
ALTER TABLE "jobs"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "processingEndedAt" TIMESTAMP(3),
  ADD COLUMN "processingMs" INTEGER,
  ADD COLUMN "transcribeMs" INTEGER,
  ADD COLUMN "analyzeMs" INTEGER,
  ADD COLUMN "renderMs" INTEGER,
  ADD COLUMN "clipsGenerated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "estimatedTranscriptionCostUsd" DOUBLE PRECISION,
  ADD COLUMN "estimatedAnalysisCostUsd" DOUBLE PRECISION,
  ADD COLUMN "estimatedComputeCostUsd" DOUBLE PRECISION,
  ADD COLUMN "estimatedTotalCostUsd" DOUBLE PRECISION;
