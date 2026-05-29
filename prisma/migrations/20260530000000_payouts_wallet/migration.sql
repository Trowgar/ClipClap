-- New enums
CREATE TYPE "WalletEntryKind" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "WalletSource" AS ENUM ('REFERRAL', 'AD_PARTNERSHIP', 'ADJUSTMENT', 'WITHDRAWAL');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED');

-- Simplify CommissionStatus: migrate rows then swap the type.
ALTER TABLE "referral_commissions" ALTER COLUMN "status" DROP DEFAULT;
UPDATE "referral_commissions" SET "status" = 'AVAILABLE' WHERE "status" IN ('PAYOUT_PENDING', 'PAID');
ALTER TABLE "referral_commissions" ALTER COLUMN "status" TYPE TEXT;
DROP TYPE "CommissionStatus";
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'AVAILABLE', 'VOIDED');
ALTER TABLE "referral_commissions" ALTER COLUMN "status" TYPE "CommissionStatus" USING ("status"::"CommissionStatus");
ALTER TABLE "referral_commissions" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Drop the commission -> payout link.
ALTER TABLE "referral_commissions" DROP CONSTRAINT IF EXISTS "referral_commissions_payoutId_fkey";
ALTER TABLE "referral_commissions" DROP COLUMN IF EXISTS "payoutId";

-- Drop ReferralPayout + PayoutStatus.
DROP TABLE IF EXISTS "referral_payouts";
DROP TYPE IF EXISTS "PayoutStatus";

-- Drop User payout columns.
ALTER TABLE "users" DROP COLUMN IF EXISTS "payoutDestination";
ALTER TABLE "users" DROP COLUMN IF EXISTS "payoutMethod";

-- wallet_entries
CREATE TABLE "wallet_entries" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" "WalletEntryKind" NOT NULL,
  "source" "WalletSource" NOT NULL,
  "amountUsd" DOUBLE PRECISION NOT NULL,
  "refType" TEXT NOT NULL,
  "refId" TEXT NOT NULL,
  "memo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wallet_entries_source_refType_refId_key" ON "wallet_entries"("source", "refType", "refId");
CREATE INDEX "wallet_entries_userId_createdAt_idx" ON "wallet_entries"("userId", "createdAt");
CREATE INDEX "wallet_entries_userId_source_idx" ON "wallet_entries"("userId", "source");
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- withdrawal_requests
CREATE TABLE "withdrawal_requests" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amountUsd" DOUBLE PRECISION NOT NULL,
  "method" TEXT NOT NULL,
  "destination" TEXT NOT NULL,
  "requestedAvailableUsd" DOUBLE PRECISION NOT NULL,
  "networkFeeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "netAmountUsd" DOUBLE PRECISION,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "txRef" TEXT,
  "adminNote" TEXT,
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "paidBy" TEXT,
  "paidAt" TIMESTAMP(3),
  "rejectedBy" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "withdrawal_requests_status_createdAt_idx" ON "withdrawal_requests"("status", "createdAt");
CREATE INDEX "withdrawal_requests_userId_status_idx" ON "withdrawal_requests"("userId", "status");
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
