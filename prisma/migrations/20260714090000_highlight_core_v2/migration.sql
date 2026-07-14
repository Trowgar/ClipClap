-- Highlight core V2: engine flags, language, coverage, clip metadata
CREATE TYPE "AnalyzeEngine" AS ENUM ('LEGACY', 'RECALL_CRITIC');
CREATE TYPE "NoClipsReason" AS ENUM ('NO_USABLE_SPEECH', 'NO_VIABLE_MOMENTS', 'PARTIAL_TRANSCRIPT');

ALTER TABLE "jobs"
  ADD COLUMN "language" TEXT,
  ADD COLUMN "languageRaw" TEXT,
  ADD COLUMN "noClipsReason" "NoClipsReason",
  ADD COLUMN "normalizedArtifactKey" TEXT,
  ADD COLUMN "analyzeEngine" "AnalyzeEngine",
  ADD COLUMN "highlightsVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "transcriptCoverage" DOUBLE PRECISION,
  ADD COLUMN "transcriptPartial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "analysisInputTokens" INTEGER,
  ADD COLUMN "analysisOutputTokens" INTEGER;

ALTER TABLE "clips"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "score" DOUBLE PRECISION,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "lowQuality" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hookStart" DOUBLE PRECISION,
  ADD COLUMN "hookEnd" DOUBLE PRECISION,
  ADD COLUMN "payoffAt" DOUBLE PRECISION,
  ADD COLUMN "clipKind" TEXT;

CREATE INDEX "clips_jobId_score_idx" ON "clips"("jobId", "score" DESC);
