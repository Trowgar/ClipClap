-- CreateEnum
CREATE TYPE "TributeWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'APPLIED', 'IGNORED', 'FAILED');

-- AlterTable
ALTER TABLE "tribute_webhook_events"
  ADD COLUMN "status" "TributeWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "outcome" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "processedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "tribute_webhook_events_status_idx" ON "tribute_webhook_events"("status");
