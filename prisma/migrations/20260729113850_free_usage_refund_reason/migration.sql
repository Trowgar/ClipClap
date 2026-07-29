-- CreateEnum
CREATE TYPE "FreeUsageReason" AS ENUM ('FAILED_JOB', 'ZERO_CLIPS');

-- AlterTable
ALTER TABLE "free_usage" ADD COLUMN     "reason" "FreeUsageReason";

-- CreateIndex
CREATE UNIQUE INDEX "free_usage_userId_jobId_kind_key" ON "free_usage"("userId", "jobId", "kind");
