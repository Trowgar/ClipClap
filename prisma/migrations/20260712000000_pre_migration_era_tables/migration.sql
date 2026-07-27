-- Four tables, one enum and three columns on "users" predate the migration
-- era. They were created by `prisma db push` before this project used
-- migrations, and no migration ever created them - only later ones ALTER them.
-- Replaying the history into an empty database therefore died at
-- 20260713120000_tribute_webhook_inbox with
-- "relation tribute_webhook_events does not exist".
--
-- That is worse than a broken `prisma migrate dev`: it meant the repository
-- could not build its own database at all. A new developer, a restored
-- environment, or Prisma's own shadow database could never be bootstrapped.
--
-- Everything below is written in the shape these objects had BEFORE the later
-- migrations altered them, so those ALTERs still apply cleanly on a fresh
-- database:
--   - "TelegramDeliveryStatus" has no FAILURE_NOTIFIED - added by
--     20260725100000_telegram_delivery_failure_notified
--   - "telegram_deliveries" has no "attempts" - added by
--     20260725160000_telegram_delivery_attempts
--   - "tribute_webhook_events" has none of status/outcome/attempts/lastError/
--     processedAt/updatedAt and no status index - all added by
--     20260713120000_tribute_webhook_inbox, which also creates the
--     "TributeWebhookStatus" enum, so it is deliberately absent here
--
-- Every statement is guarded, because in production all of this already exists
-- and this migration must be an exact no-op there.

DO $$ BEGIN
  CREATE TYPE "TelegramDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "telegram_deliveries" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "status" "TelegramDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "telegram_deliveries_jobId_fkey" FOREIGN KEY ("jobId")
        REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "telegram_deliveries_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "telegram_deliveries_jobId_key"
    ON "telegram_deliveries"("jobId");
CREATE INDEX IF NOT EXISTS "telegram_deliveries_status_createdAt_idx"
    ON "telegram_deliveries"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "telegram_deliveries_userId_idx"
    ON "telegram_deliveries"("userId");

CREATE TABLE IF NOT EXISTS "telegram_link_tokens" (
    "code" TEXT NOT NULL,
    "userId" TEXT,
    "telegramId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_link_tokens_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "telegram_link_tokens_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "telegram_link_tokens_userId_idx"
    ON "telegram_link_tokens"("userId");
CREATE INDEX IF NOT EXISTS "telegram_link_tokens_telegramId_idx"
    ON "telegram_link_tokens"("telegramId");
CREATE INDEX IF NOT EXISTS "telegram_link_tokens_expiresAt_idx"
    ON "telegram_link_tokens"("expiresAt");

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX IF NOT EXISTS "stripe_webhook_events_type_createdAt_idx"
    ON "stripe_webhook_events"("type", "createdAt");

CREATE TABLE IF NOT EXISTS "tribute_webhook_events" (
    "id" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tribute_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tribute_webhook_events_eventHash_key"
    ON "tribute_webhook_events"("eventHash");
CREATE INDEX IF NOT EXISTS "tribute_webhook_events_name_createdAt_idx"
    ON "tribute_webhook_events"("name", "createdAt");

-- Three columns on "users" from the same era. Nothing later alters them, so
-- they go in at their current shape. All nullable, so adding them to a
-- populated table is instant and needs no backfill.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "currentPeriodStart" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegramLocale" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tributeSubscriptionId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "users_tributeSubscriptionId_key"
    ON "users"("tributeSubscriptionId");
