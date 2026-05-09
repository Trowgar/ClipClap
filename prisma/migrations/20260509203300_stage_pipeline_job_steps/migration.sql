CREATE TYPE "JobStepName" AS ENUM ('DOWNLOAD', 'TRANSCRIBE', 'ANALYZE', 'RENDER', 'FINALIZE');
CREATE TYPE "JobStepStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

ALTER TABLE "jobs"
  ADD COLUMN "sourceArtifactKey" TEXT,
  ADD COLUMN "transcriptJson" JSONB,
  ADD COLUMN "renderManifest" JSONB;

CREATE TABLE "job_steps" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "step" "JobStepName" NOT NULL,
  "status" "JobStepStatus" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "inputJson" JSONB,
  "outputJson" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_steps_jobId_step_key" ON "job_steps"("jobId", "step");
CREATE INDEX "job_steps_status_step_idx" ON "job_steps"("status", "step");
CREATE INDEX "job_steps_jobId_idx" ON "job_steps"("jobId");

ALTER TABLE "job_steps"
  ADD CONSTRAINT "job_steps_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
