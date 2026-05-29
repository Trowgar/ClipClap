-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('STRIPE', 'TRIBUTE');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'AVAILABLE', 'PAYOUT_PENDING', 'PAID', 'VOIDED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED');

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "referralCode"            TEXT,
  ADD COLUMN "referredById"            TEXT,
  ADD COLUMN "payoutDestination"       TEXT,
  ADD COLUMN "payoutMethod"            TEXT,
  ADD COLUMN "referralTermsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "referralTermsVersion"    TEXT,
  ADD COLUMN "referralBannedAt"        TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

-- AddForeignKey
ALTER TABLE "users"
  ADD CONSTRAINT "users_referredById_fkey"
  FOREIGN KEY ("referredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "referral_payouts" (
  "id"            TEXT NOT NULL,
  "referrerId"    TEXT NOT NULL,
  "amountUsd"     DOUBLE PRECISION NOT NULL,
  "networkFeeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "netPayoutUsd"  DOUBLE PRECISION NOT NULL,
  "payoutMethod"  TEXT,
  "destination"   TEXT NOT NULL,
  "status"        "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "txRef"         TEXT,
  "adminNote"     TEXT,
  "approvedBy"    TEXT,
  "approvedAt"    TIMESTAMP(3),
  "paidAt"        TIMESTAMP(3),
  "rejectedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "referral_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_commissions" (
  "id"                TEXT NOT NULL,
  "referrerId"        TEXT NOT NULL,
  "referredUserId"    TEXT NOT NULL,
  "source"            "PaymentSource" NOT NULL,
  "externalPaymentId" TEXT NOT NULL,
  "originalCurrency"  TEXT NOT NULL,
  "originalAmount"    DOUBLE PRECISION NOT NULL,
  "exchangeRateToUsd" DOUBLE PRECISION NOT NULL,
  "grossAmountUsd"    DOUBLE PRECISION NOT NULL,
  "processorFeeUsd"   DOUBLE PRECISION NOT NULL,
  "taxUsd"            DOUBLE PRECISION NOT NULL DEFAULT 0,
  "discountUsd"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "refundUsd"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  "netAmountUsd"      DOUBLE PRECISION NOT NULL,
  "rateBps"           INTEGER NOT NULL,
  "commissionUsd"     DOUBLE PRECISION NOT NULL,
  "status"            "CommissionStatus" NOT NULL DEFAULT 'PENDING',
  "availableAt"       TIMESTAMP(3) NOT NULL,
  "payoutId"          TEXT,
  "adminNote"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "referral_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "referral_payouts_status_idx" ON "referral_payouts"("status");

-- CreateIndex
CREATE INDEX "referral_payouts_referrerId_idx" ON "referral_payouts"("referrerId");

-- AddForeignKey
ALTER TABLE "referral_payouts"
  ADD CONSTRAINT "referral_payouts_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "referral_commissions_source_externalPaymentId_key"
  ON "referral_commissions"("source", "externalPaymentId");

-- CreateIndex
CREATE INDEX "referral_commissions_referrerId_status_idx"
  ON "referral_commissions"("referrerId", "status");

-- CreateIndex
CREATE INDEX "referral_commissions_status_availableAt_idx"
  ON "referral_commissions"("status", "availableAt");

-- AddForeignKey
ALTER TABLE "referral_commissions"
  ADD CONSTRAINT "referral_commissions_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_commissions"
  ADD CONSTRAINT "referral_commissions_referredUserId_fkey"
  FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_commissions"
  ADD CONSTRAINT "referral_commissions_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "referral_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
