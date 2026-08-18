-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "sourceFingerprint" TEXT;

-- CreateIndex
CREATE INDEX "jobs_userId_sourceFingerprint_idx" ON "jobs"("userId", "sourceFingerprint");
