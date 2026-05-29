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

/**
 * Void all non-paid commissions for a payment (refund / chargeback / admin).
 * Detaches voided commissions from any open payout batch and recomputes the
 * affected payout(s). If an entire payout becomes empty it is auto-rejected.
 * All steps run in a single transaction so partial failures cannot leave
 * a half-detached state.
 */
export async function voidCommission(
  source: PaymentSource,
  externalPaymentId: string,
  reason: string
): Promise<{ voided: number }> {
  return prisma.$transaction(async (tx) => {
    // 1. Find open payouts that will lose commissions so we can recompute them.
    const affectedPayouts = await tx.referralPayout.findMany({
      where: {
        status: { in: ["PENDING", "APPROVED"] },
        commissions: {
          some: {
            source,
            externalPaymentId,
            status: "PAYOUT_PENDING",
          },
        },
      },
      select: { id: true, status: true, networkFeeUsd: true },
    });

    // 2. Void matching commissions and detach from any payout batch.
    const result = await tx.referralCommission.updateMany({
      where: {
        source,
        externalPaymentId,
        status: { in: [...NON_PAID_STATUSES] },
      },
      data: { status: "VOIDED", adminNote: reason, payoutId: null },
    });

    // 3. Recompute each affected payout.
    for (const payout of affectedPayouts) {
      const agg = await tx.referralCommission.aggregate({
        where: { payoutId: payout.id, status: "PAYOUT_PENDING" },
        _sum: { commissionUsd: true },
      });
      const remaining = round2(agg._sum.commissionUsd ?? 0);

      if (remaining === 0) {
        await tx.referralPayout.update({
          where: { id: payout.id },
          data: {
            status: "REJECTED",
            rejectedAt: new Date(),
            adminNote: "auto-voided: all linked commissions reversed",
          },
        });
      } else {
        await tx.referralPayout.update({
          where: { id: payout.id },
          data: {
            amountUsd: remaining,
            netPayoutUsd: round2(remaining - (payout.networkFeeUsd ?? 0)),
          },
        });
      }
    }

    return { voided: result.count };
  });
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

// ---- Payout destination validation ----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
export const PAYOUT_METHODS = ["PAYPAL", "USDT_TRC20", "BANK"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export function validatePayoutDestination(
  method: string,
  destination: string
): { ok: boolean; error?: string } {
  const value = destination?.trim() ?? "";
  switch (method) {
    case "PAYPAL":
      return EMAIL_RE.test(value) ? { ok: true } : { ok: false, error: "Invalid PayPal email" };
    case "USDT_TRC20":
      return TRON_RE.test(value) ? { ok: true } : { ok: false, error: "Invalid TRON address" };
    case "BANK":
      return value.length > 0 ? { ok: true } : { ok: false, error: "Bank details required" };
    default:
      return { ok: false, error: "Unsupported payout method" };
  }
}

export async function setPayoutDestination(
  userId: string,
  method: string,
  destination: string
): Promise<{ ok: boolean; error?: string }> {
  const v = validatePayoutDestination(method, destination);
  if (!v.ok) return v;
  await prisma.user.update({
    where: { id: userId },
    data: { payoutMethod: method, payoutDestination: destination.trim() },
  });
  return { ok: true };
}

export async function acceptReferralTerms(userId: string): Promise<string> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      referralTermsAcceptedAt: new Date(),
      referralTermsVersion: REFERRAL_CONFIG.termsVersion,
    },
  });
  return ensureReferralCode(userId);
}

export interface ReferralBalance {
  pendingUsd: number;
  availableUsd: number;
  payoutPendingUsd: number;
  paidUsd: number;
}

export async function getReferralBalance(referrerId: string): Promise<ReferralBalance> {
  const groups = await prisma.referralCommission.groupBy({
    by: ["status"],
    where: { referrerId },
    _sum: { commissionUsd: true },
  });
  const sumFor = (status: string) =>
    round2(groups.find((g) => g.status === status)?._sum.commissionUsd ?? 0);
  return {
    pendingUsd: sumFor("PENDING"),
    availableUsd: sumFor("AVAILABLE"),
    payoutPendingUsd: sumFor("PAYOUT_PENDING"),
    paidUsd: sumFor("PAID"),
  };
}

// ---- Admin operations ----

export async function listPendingPayouts() {
  return prisma.referralPayout.findMany({
    where: { status: { in: ["PENDING", "APPROVED"] } },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { commissions: true } } },
  });
}

/**
 * Approve a payout batch. Guards against acting on a non-PENDING payout
 * by using updateMany with a status condition; silently no-ops if already
 * in a terminal/approved state.
 */
export async function approvePayout(
  payoutId: string,
  adminTelegramId: string,
  networkFeeUsd: number
): Promise<void> {
  const payout = await prisma.referralPayout.findUniqueOrThrow({ where: { id: payoutId } });
  await prisma.referralPayout.updateMany({
    where: { id: payoutId, status: "PENDING" },
    data: {
      status: "APPROVED",
      approvedBy: adminTelegramId,
      approvedAt: new Date(),
      networkFeeUsd,
      netPayoutUsd: round2(payout.amountUsd - networkFeeUsd),
    },
  });
}

/**
 * Mark a payout as paid and flip all its PAYOUT_PENDING commissions to PAID.
 * Guards the payout update so a REJECTED or already-PAID payout is never
 * paid again. Guards the commission flip so VOIDED commissions cannot be
 * resurrected even if their payoutId was not cleared (defense-in-depth).
 */
export async function markPayoutPaid(payoutId: string, txRef: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.referralPayout.update({
      where: { id: payoutId, status: { in: ["PENDING", "APPROVED"] } },
      data: { status: "PAID", paidAt: new Date(), txRef },
    });
    await tx.referralCommission.updateMany({
      where: { payoutId, status: "PAYOUT_PENDING" },
      data: { status: "PAID" },
    });
  });
}

/**
 * Reject a payout and return its commissions to AVAILABLE.
 * Guards the payout update so a PAID or already-REJECTED payout is not
 * double-processed.
 */
export async function rejectPayout(payoutId: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.referralPayout.update({
      where: { id: payoutId, status: { in: ["PENDING", "APPROVED"] } },
      data: { status: "REJECTED", rejectedAt: new Date(), adminNote: reason },
    });
    await tx.referralCommission.updateMany({
      where: { payoutId },
      data: { status: "AVAILABLE", payoutId: null },
    });
  });
}

export async function banReferrer(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { referralBannedAt: new Date() } });
}

/**
 * Void all non-paid commissions for a referrer (e.g. on ban).
 * Detaches voided commissions from any open payout batch and recomputes the
 * affected payout(s). If an entire payout becomes empty it is auto-rejected.
 * All steps run in a single transaction.
 */
export async function voidReferrerCommissions(
  userId: string,
  reason: string
): Promise<{ voided: number }> {
  return prisma.$transaction(async (tx) => {
    // 1. Find open payouts that will lose commissions.
    const affectedPayouts = await tx.referralPayout.findMany({
      where: {
        status: { in: ["PENDING", "APPROVED"] },
        commissions: {
          some: {
            referrerId: userId,
            status: "PAYOUT_PENDING",
          },
        },
      },
      select: { id: true, status: true, networkFeeUsd: true },
    });

    // 2. Void matching commissions and detach from any payout batch.
    const result = await tx.referralCommission.updateMany({
      where: {
        referrerId: userId,
        status: { in: [...NON_PAID_STATUSES] },
      },
      data: { status: "VOIDED", adminNote: reason, payoutId: null },
    });

    // 3. Recompute each affected payout.
    for (const payout of affectedPayouts) {
      const agg = await tx.referralCommission.aggregate({
        where: { payoutId: payout.id, status: "PAYOUT_PENDING" },
        _sum: { commissionUsd: true },
      });
      const remaining = round2(agg._sum.commissionUsd ?? 0);

      if (remaining === 0) {
        await tx.referralPayout.update({
          where: { id: payout.id },
          data: {
            status: "REJECTED",
            rejectedAt: new Date(),
            adminNote: "auto-voided: all linked commissions reversed",
          },
        });
      } else {
        await tx.referralPayout.update({
          where: { id: payout.id },
          data: {
            amountUsd: remaining,
            netPayoutUsd: round2(remaining - (payout.networkFeeUsd ?? 0)),
          },
        });
      }
    }

    return { voided: result.count };
  });
}

export async function getReferrerCard(idOrCode: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ id: idOrCode }, { referralCode: idOrCode }, { telegramId: idOrCode }] },
    select: {
      id: true,
      referralCode: true,
      referralBannedAt: true,
      _count: { select: { referrals: true } },
    },
  });
  if (!user) return null;
  const balance = await getReferralBalance(user.id);
  const refundCount = await prisma.referralCommission.count({
    where: { referrerId: user.id, status: "VOIDED" },
  });
  return { user, balance, refundCount };
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
