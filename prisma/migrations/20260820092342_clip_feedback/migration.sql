-- clip_feedback: one row per (clip, user) verdict on a delivered clip.
--
-- No foreign keys, deliberately. deleteProject hard-deletes the Job and Clip
-- cascades from it, and clip.service deletes single clips outright, so a
-- relation would erase "I rejected this clip and then deleted it" - the
-- strongest signal this table exists to hold. Same decision, same reason, as
-- funnel_events and upload_refusals.
--
-- clips.telegramMessageId is the anchor a user's reply is matched against.
-- Nullable on purpose: the delivery path already tolerates Telegram confirming
-- a send without a parseable payload.

-- AlterTable
ALTER TABLE "clips" ADD COLUMN     "telegramMessageId" INTEGER;

-- CreateTable
CREATE TABLE "clip_feedback" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "snapshot" JSONB,
    "evidenceKey" TEXT,
    "locale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clip_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clip_feedback_verdict_createdAt_idx" ON "clip_feedback"("verdict", "createdAt");

-- CreateIndex
CREATE INDEX "clip_feedback_reason_createdAt_idx" ON "clip_feedback"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "clip_feedback_jobId_idx" ON "clip_feedback"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "clip_feedback_clipId_userId_key" ON "clip_feedback"("clipId", "userId");
