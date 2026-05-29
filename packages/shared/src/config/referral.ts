import type { PaymentSource } from "@prisma/client";

export const REFERRAL_CONFIG = {
  rateBps: 3000, // 30%
  holdDays: 14,
  payoutDays: [1, 15] as const,
  minPayoutUsd: 50,
  attributionWindowDays: 30,
  codeLength: 8,
  termsVersion: "2026-05-29",
  // Stripe fee comes from the real balance_transaction; Tribute is a flat configured rate.
  feeRateBps: { TRIBUTE: 1000 } as Partial<Record<PaymentSource, number>>,
  exchangeRatesToUsd: { usd: 1, eur: 1.08, rub: 0.011 } as Record<string, number>,
} as const;

export const REFERRAL_COOKIE_NAME = "cc_ref";

export function exchangeRateToUsd(currency: string): number {
  const code = currency.toLowerCase();
  const rate = REFERRAL_CONFIG.exchangeRatesToUsd[code];
  if (rate === undefined) {
    throw new Error(`No configured exchange rate for currency "${currency}"`);
  }
  return rate;
}
