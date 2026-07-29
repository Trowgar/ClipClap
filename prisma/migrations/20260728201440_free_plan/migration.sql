-- Free plan groundwork: canonical email identity and the free-usage ledger.
--
-- Note on `free_usage.jobId`: it is deliberately a bare TEXT column with no
-- foreign key. deleteProject runs prisma.job.delete, so a FK here - with or
-- without a cascade - would either block the delete or let the delete erase the
-- ledger rows, and either way the free allowance becomes resettable by pressing
-- Delete. The column is for tracing a charge back to its job, nothing more.
--
-- The unique index on users.emailCanonical is created while every value is
-- still NULL, and Postgres allows any number of NULLs in a unique index, so
-- this migration cannot fail on existing duplicates. The backfill that fills
-- the column runs afterwards and skips collisions rather than erroring.

-- CreateEnum
CREATE TYPE "FreeUsageKind" AS ENUM ('CHARGE', 'REFUND');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailCanonical" TEXT;

-- CreateTable
CREATE TABLE "free_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" "FreeUsageKind" NOT NULL,
    "seconds" INTEGER NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "free_usage_userId_idx" ON "free_usage"("userId");

-- CreateIndex
CREATE INDEX "free_usage_createdAt_idx" ON "free_usage"("createdAt");

-- CreateIndex
CREATE INDEX "free_usage_jobId_idx" ON "free_usage"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "users_emailCanonical_key" ON "users"("emailCanonical");

-- AddForeignKey
ALTER TABLE "free_usage" ADD CONSTRAINT "free_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
