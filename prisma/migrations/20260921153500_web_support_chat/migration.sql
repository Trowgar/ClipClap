ALTER TABLE "support_messages" ALTER COLUMN "telegramId" DROP NOT NULL;
ALTER TABLE "support_messages" ADD COLUMN "surface" TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE "support_messages" ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE "support_messages" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "support_messages" ADD COLUMN "readAt" TIMESTAMP(3);
ALTER TABLE "support_messages" ADD COLUMN "contextPath" TEXT;
ALTER TABLE "support_messages" ADD COLUMN "emailNotifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "support_messages_dedupeKey_key" ON "support_messages"("dedupeKey");
CREATE INDEX "support_messages_userId_surface_createdAt_idx" ON "support_messages"("userId", "surface", "createdAt");
CREATE INDEX "support_messages_userId_surface_direction_readAt_idx" ON "support_messages"("userId", "surface", "direction", "readAt");
