-- Plan enum: NONE/STARTER/PLUS/MAX (was FREE/STARTER/PRO).
-- Postgres cannot DROP a value from an enum, so we rebuild the type.
-- We do the rebuild in a single transaction-safe path that avoids
-- `ALTER TYPE ADD VALUE` (which cannot run inside a transaction block).
--
-- Mapping:
--   FREE    -> NONE
--   STARTER -> STARTER
--   PRO     -> MAX

-- 1. Rebuild the Plan enum.
ALTER TYPE "Plan" RENAME TO "Plan_old";
CREATE TYPE "Plan" AS ENUM ('NONE', 'STARTER', 'PLUS', 'MAX');
ALTER TABLE "users" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "users"
  ALTER COLUMN "plan" TYPE "Plan"
  USING (
    CASE "plan"::text
      WHEN 'FREE' THEN 'NONE'
      WHEN 'PRO'  THEN 'MAX'
      ELSE "plan"::text
    END
  )::"Plan";
ALTER TABLE "users" ALTER COLUMN "plan" SET DEFAULT 'NONE';
DROP TYPE "Plan_old";

-- 2. New enums for subscription lifecycle.
CREATE TYPE "SubscriptionStatus" AS ENUM ('NONE', 'ACTIVE', 'DUNNING', 'CANCELED_GRACE', 'CANCELED');
CREATE TYPE "BillingCycle" AS ENUM ('WEEKLY', 'MONTHLY');

-- 3. User: add subscription lifecycle columns.
ALTER TABLE "users"
  ADD COLUMN "subscriptionStatus"    "SubscriptionStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "billingCycle"          "BillingCycle",
  ADD COLUMN "currentPeriodEnd"      TIMESTAMP(3),
  ADD COLUMN "dunningSince"          TIMESTAMP(3),
  ADD COLUMN "graceEndsAt"           TIMESTAMP(3),
  ADD COLUMN "topUpMinutesRemaining" INTEGER             NOT NULL DEFAULT 0;

-- 4. Clip: retention fields.
ALTER TABLE "clips"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "deletedAt" TIMESTAMP(3);

-- 5. Indexes.
CREATE INDEX "clips_expiresAt_deletedAt_idx" ON "clips" ("expiresAt", "deletedAt");
CREATE INDEX "clips_userId_createdAt_idx"    ON "clips" ("userId", "createdAt" DESC);
CREATE INDEX "jobs_userId_status_idx"        ON "jobs"  ("userId", "status");
