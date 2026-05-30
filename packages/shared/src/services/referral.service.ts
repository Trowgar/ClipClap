import { randomBytes } from "crypto";
import type { PaymentSource } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { REFERRAL_CONFIG } from "../config/referral";
import { postWalletEntry, getWalletBalance, getEarningsBySource } from "./wallet.service";

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
const NON_PAID_STATUSES = ["PENDING", "AVAILABLE"] as const;

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

/** Move matured PENDING commissions to AVAILABLE and credit the wallet. Idempotent. */
export async function releaseMaturedCommissions(
  now: Date = new Date()
): Promise<{ released: number }> {
  const matured = await prisma.referralCommission.findMany({
    where: { status: "PENDING", availableAt: { lte: now } },
    select: { id: true, referrerId: true, commissionUsd: true },
  });
  let released = 0;
  for (const c of matured) {
    await prisma.$transaction(async (tx) => {
      const upd = await tx.referralCommission.updateMany({
        where: { id: c.id, status: "PENDING" },
        data: { status: "AVAILABLE" },
      });
      if (upd.count === 0) return; // already released by a concurrent run
      await postWalletEntry(tx, {
        userId: c.referrerId, kind: "CREDIT", source: "REFERRAL",
        refType: "referral_commission", refId: c.id, amountUsd: c.commissionUsd,
      });
      released += 1;
    });
  }
  return { released };
}

/**
 * Void all non-paid commissions for a payment (refund / chargeback / admin).
 * Posts a wallet DEBIT clawback for each commission that has an existing CREDIT
 * ledger entry (ledger is the source of truth, not commission.status, to avoid
 * a race with releaseMaturedCommissions). All steps run in a single transaction.
 */
export async function voidCommission(
  source: PaymentSource,
  externalPaymentId: string,
  reason: string
): Promise<{ voided: number }> {
  const targets = await prisma.referralCommission.findMany({
    where: { source, externalPaymentId, status: { in: [...NON_PAID_STATUSES] } },
    select: { id: true, referrerId: true },
  });
  if (targets.length === 0) return { voided: 0 };
  await prisma.$transaction(async (tx) => {
    await tx.referralCommission.updateMany({
      where: { source, externalPaymentId, status: { in: [...NON_PAID_STATUSES] } },
      data: { status: "VOIDED", adminNote: reason },
    });
    for (const c of targets) {
      // Ledger is the source of truth: clawback only if a CREDIT was actually posted.
      const credit = await tx.walletEntry.findUnique({
        where: {
          source_refType_refId: {
            source: "REFERRAL", refType: "referral_commission", refId: c.id,
          },
        },
      });
      if (credit) {
        await postWalletEntry(tx, {
          userId: c.referrerId, kind: "DEBIT", source: "REFERRAL",
          refType: "referral_clawback", refId: c.id, amountUsd: credit.amountUsd,
        });
      }
    }
  });
  return { voided: targets.length };
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

// ---- Admin operations ----

export async function banReferrer(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { referralBannedAt: new Date() } });
}

/**
 * Void all non-paid commissions for a referrer (e.g. on ban).
 * Posts a wallet DEBIT clawback for each commission that has an existing CREDIT
 * ledger entry (ledger is the source of truth, not commission.status, to avoid
 * a race with releaseMaturedCommissions). All steps run in a single transaction.
 */
export async function voidReferrerCommissions(
  userId: string,
  reason: string
): Promise<{ voided: number }> {
  const targets = await prisma.referralCommission.findMany({
    where: { referrerId: userId, status: { in: [...NON_PAID_STATUSES] } },
    select: { id: true, referrerId: true },
  });
  if (targets.length === 0) return { voided: 0 };
  await prisma.$transaction(async (tx) => {
    await tx.referralCommission.updateMany({
      where: { referrerId: userId, status: { in: [...NON_PAID_STATUSES] } },
      data: { status: "VOIDED", adminNote: reason },
    });
    for (const c of targets) {
      // Ledger is the source of truth: clawback only if a CREDIT was actually posted.
      const credit = await tx.walletEntry.findUnique({
        where: {
          source_refType_refId: {
            source: "REFERRAL", refType: "referral_commission", refId: c.id,
          },
        },
      });
      if (credit) {
        await postWalletEntry(tx, {
          userId: c.referrerId, kind: "DEBIT", source: "REFERRAL",
          refType: "referral_clawback", refId: c.id, amountUsd: credit.amountUsd,
        });
      }
    }
  });
  return { voided: targets.length };
}

export interface ReferralStats {
  pendingUsd: number;
  earnedUsd: number;
}

export async function getReferralStats(userId: string): Promise<ReferralStats> {
  const [pending, credited, clawedBack] = await Promise.all([
    prisma.referralCommission.aggregate({ _sum: { commissionUsd: true }, where: { referrerId: userId, status: "PENDING" } }),
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "CREDIT", source: "REFERRAL" } }),
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "DEBIT", source: "REFERRAL" } }),
  ]);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    pendingUsd: r2(pending._sum.commissionUsd ?? 0),
    // Net of clawbacks (refunds/chargebacks) so the figure reflects real earnings.
    earnedUsd: r2((credited._sum.amountUsd ?? 0) - (clawedBack._sum.amountUsd ?? 0)),
  };
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
  const balance = await getWalletBalance(user.id);
  const bySource = await getEarningsBySource(user.id);
  const refundCount = await prisma.referralCommission.count({
    where: { referrerId: user.id, status: "VOIDED" },
  });
  return { user, balance, bySource, refundCount };
}
