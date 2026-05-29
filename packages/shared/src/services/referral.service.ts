import { randomBytes } from "crypto";
import type { PaymentSource } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { REFERRAL_CONFIG } from "../config/referral";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

export type AttachReferralStatus =
  | "attached"
  | "unknown_code"
  | "self_referral"
  | "already_attached";

export interface AttachReferralResult {
  status: AttachReferralStatus;
  referrerId?: string;
}

/** Generate a code that is not yet taken. Caller persists it. */
function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Lazily create and persist a referral code for a user that lacks one. */
export async function ensureReferralCode(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });
  if (user?.referralCode) return user.referralCode;

  // Retry on the (extremely unlikely) unique collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(REFERRAL_CONFIG.codeLength);
    try {
      await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return code;
    } catch {
      // unique violation -> try another code
    }
  }
  throw new Error("Failed to allocate a unique referral code");
}

/**
 * Bind `newUserId` to the referrer that owns `code`. Last-touch, one-time:
 * sets referredById only when it is currently null and not a self-referral.
 */
export async function attachReferral(
  newUserId: string,
  code: string
): Promise<AttachReferralResult> {
  const referrer = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true, telegramId: true, email: true, referralBannedAt: true },
  });
  if (!referrer) return { status: "unknown_code" };

  const newUser = await prisma.user.findUnique({
    where: { id: newUserId },
    select: { id: true, telegramId: true, email: true, referredById: true },
  });
  if (!newUser) return { status: "unknown_code" };

  if (newUser.referredById) return { status: "already_attached" };

  const isSelf =
    referrer.id === newUser.id ||
    (!!referrer.telegramId && referrer.telegramId === newUser.telegramId) ||
    (!!referrer.email && referrer.email === newUser.email);
  if (isSelf) return { status: "self_referral" };

  // Guard the one-time lock at the DB level: only update when still null.
  const updated = await prisma.user.updateMany({
    where: { id: newUserId, referredById: null },
    data: { referredById: referrer.id },
  });
  if (updated.count === 0) return { status: "already_attached" };

  return { status: "attached", referrerId: referrer.id };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NON_PAID_STATUSES = ["PENDING", "AVAILABLE", "PAYOUT_PENDING"] as const;

export interface RecordCommissionInput {
  payerUserId: string;
  source: PaymentSource;
  externalPaymentId: string;
  originalCurrency: string;
  originalAmount: number;
  grossAmountUsd: number;
  processorFeeUsd: number;
  taxUsd?: number;
  discountUsd?: number;
  exchangeRateToUsd?: number;
  paidAt: Date;
}

export type RecordCommissionStatus =
  | "recorded"
  | "no_referrer"
  | "self_referral"
  | "referrer_banned"
  | "duplicate";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function recordCommission(
  input: RecordCommissionInput
): Promise<{ status: RecordCommissionStatus }> {
  const payer = await prisma.user.findUnique({
    where: { id: input.payerUserId },
    select: { id: true, referredById: true, telegramId: true, email: true },
  });
  if (!payer?.referredById) return { status: "no_referrer" };

  const referrer = await prisma.user.findUnique({
    where: { id: payer.referredById },
    select: { id: true, telegramId: true, email: true, referralBannedAt: true },
  });
  if (!referrer) return { status: "no_referrer" };

  const isSelf =
    referrer.id === payer.id ||
    (!!referrer.telegramId && referrer.telegramId === payer.telegramId) ||
    (!!referrer.email && referrer.email === payer.email);
  if (isSelf) return { status: "self_referral" };

  if (referrer.referralBannedAt) return { status: "referrer_banned" };

  const taxUsd = input.taxUsd ?? 0;
  const discountUsd = input.discountUsd ?? 0;
  const netAmountUsd = round2(
    input.grossAmountUsd - input.processorFeeUsd - taxUsd - discountUsd
  );
  const commissionUsd = round2((netAmountUsd * REFERRAL_CONFIG.rateBps) / 10000);
  const availableAt = new Date(
    input.paidAt.getTime() + REFERRAL_CONFIG.holdDays * MS_PER_DAY
  );

  try {
    await prisma.referralCommission.create({
      data: {
        referrerId: referrer.id,
        referredUserId: payer.id,
        source: input.source,
        externalPaymentId: input.externalPaymentId,
        originalCurrency: input.originalCurrency,
        originalAmount: input.originalAmount,
        exchangeRateToUsd: input.exchangeRateToUsd ?? 1,
        grossAmountUsd: input.grossAmountUsd,
        processorFeeUsd: input.processorFeeUsd,
        taxUsd,
        discountUsd,
        netAmountUsd,
        rateBps: REFERRAL_CONFIG.rateBps,
        commissionUsd,
        status: "PENDING",
        availableAt,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { status: "duplicate" };
    throw err;
  }

  return { status: "recorded" };
}

/** Void all non-paid commissions for a payment (refund / chargeback / admin). */
export async function voidCommission(
  source: PaymentSource,
  externalPaymentId: string,
  reason: string
): Promise<{ voided: number }> {
  const result = await prisma.referralCommission.updateMany({
    where: {
      source,
      externalPaymentId,
      status: { in: [...NON_PAID_STATUSES] },
    },
    data: { status: "VOIDED", adminNote: reason },
  });
  return { voided: result.count };
}

/** Move matured PENDING commissions to AVAILABLE. Idempotent. */
export async function releaseMaturedCommissions(
  now: Date = new Date()
): Promise<{ released: number }> {
  const result = await prisma.referralCommission.updateMany({
    where: { status: "PENDING", availableAt: { lte: now } },
    data: { status: "AVAILABLE" },
  });
  return { released: result.count };
}

/**
 * Create payout batches for referrers whose AVAILABLE balance >= minimum and
 * who have a payout destination set. Each referrer is processed in its own
 * transaction that creates the payout AND locks its commissions to
 * PAYOUT_PENDING, so a double-run cannot create duplicate payouts.
 */
export async function runPayoutBatch(
  _now: Date = new Date()
): Promise<{ created: number }> {
  const groups = await prisma.referralCommission.groupBy({
    by: ["referrerId"],
    where: { status: "AVAILABLE", payoutId: null },
    _sum: { commissionUsd: true },
  });

  let created = 0;
  for (const group of groups) {
    const amountUsd = round2(group._sum.commissionUsd ?? 0);
    if (amountUsd < REFERRAL_CONFIG.minPayoutUsd) continue;

    const referrer = await prisma.user.findUnique({
      where: { id: group.referrerId },
      select: { id: true, payoutDestination: true, payoutMethod: true },
    });
    if (!referrer?.payoutDestination) continue;

    await prisma.$transaction(async (tx) => {
      const payout = await tx.referralPayout.create({
        data: {
          referrerId: referrer.id,
          amountUsd,
          networkFeeUsd: 0,
          netPayoutUsd: amountUsd,
          payoutMethod: referrer.payoutMethod,
          destination: referrer.payoutDestination!,
          status: "PENDING",
        },
      });
      await tx.referralCommission.updateMany({
        where: { referrerId: referrer.id, status: "AVAILABLE", payoutId: null },
        data: { status: "PAYOUT_PENDING", payoutId: payout.id },
      });
    });
    created += 1;
  }

  return { created };
}
