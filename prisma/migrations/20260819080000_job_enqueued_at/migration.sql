-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "enqueuedAt" TIMESTAMP(3);

-- Every job that predates the queue was enqueued the moment it was created.
-- Without this backfill the release path would read every historical PENDING
-- row as "waiting for a slot" and re-enqueue it.
UPDATE "jobs" SET "enqueuedAt" = "createdAt";

-- CreateIndex
CREATE INDEX "jobs_userId_enqueuedAt_createdAt_idx" ON "jobs"("userId", "enqueuedAt", "createdAt");
