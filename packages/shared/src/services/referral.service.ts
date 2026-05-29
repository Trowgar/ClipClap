import { randomBytes } from "crypto";
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
