-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "sourceSweptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_idx" ON "jobs"("status", "createdAt");
