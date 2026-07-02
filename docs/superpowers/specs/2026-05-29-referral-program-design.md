# ClipClap Referral Program - Design Spec

**Date:** 2026-05-29
**Status:** Approved for planning
**Scope:** A unified referral/affiliate program shared by both the web app and the Telegram bot. Referrers earn a recurring lifetime commission on the payments of users they bring in, accrued to a balance, and paid out in scheduled batches via a Telegram-based admin CRM.

> Naming: the product is **ClipClap** (domain `clipclap.io`, bot `@ClipClapBot`). The legacy name "ClipClap" in `CLAUDE.md` is outdated; use ClipClap throughout.

---

## 1. Goals & Non-Goals

### Goals
- Let any user invite others via a referral link/code that works for both web and Telegram.
- Pay the referrer **30% of every successful payment** of their referred users, **for the lifetime** of those subscriptions.
- Track commissions in an auditable ledger with refund/chargeback handling.
- Accrue commissions to a balance with a hold period, then pay out in scheduled batches.
- Operate payouts manually at MVP via a Telegram admin CRM (no automated disbursement, no web admin panel).

### Non-Goals (MVP)
- No full affiliate marketplace, tiers, or multi-level (sub-affiliate) commissions.
- No automated crypto/fiat disbursement - payout is manual, admin-approved.
- No custom vanity referral codes (auto-generated slug only).
- No web admin panel - admin lives in the Telegram bot.
- No proportional partial-refund clawback (any refund voids the commission at MVP).

---

## 2. Agreed Parameters (all in config `referral.ts`)

| Parameter | Value |
|---|---|
| Commission rate | **30%** of each successful payment, **lifetime** (recurring) |
| Commission base | **net revenue** = gross - payment-processor fee |
| Attribution model | **last-touch**, 30-day cookie/binding window |
| Hold period | **14 days** after payment, then `AVAILABLE` |
| Payout schedule | Batches on the **1st and 15th** of each month |
| Minimum payout | **$50** available balance |
| Network/withdrawal fee | Deducted from the payout (entered by admin at approval) |
| Referral code | Auto-generated 8-char slug |
| Admin surface | Telegram bot commands gated by `REFERRAL_ADMIN_TELEGRAM_IDS` |

Rate is stored per-commission as `rateBps` (3000 = 30%) so it is fixed at accrual time and can be changed in config (e.g. temporary 2x promos) without rewriting history.

---

## 3. Data Model (Prisma)

### 3.1 `User` - new fields
```prisma
referralCode            String?   @unique   // auto 8-char slug, lazily generated
referredById            String?             // the referrer; set once, immutable
referredBy              User?     @relation("Referrals", fields: [referredById], references: [id])
referrals               User[]    @relation("Referrals")
payoutDestination       String?             // validated per payoutMethod, set by referrer
payoutMethod            String?             // "USDT_TRC20" | "PAYPAL" | "BANK"
referralTermsAcceptedAt DateTime?           // must be set before a referral code is issued
referralTermsVersion    String?             // which terms version was accepted (e.g. "2026-05-29")
```

### 3.2 `ReferralCommission` - the ledger (one row per referred payment)
```prisma
enum PaymentSource { STRIPE TRIBUTE }

enum CommissionStatus {
  PENDING         // within hold period
  AVAILABLE       // hold cleared, eligible for payout
  PAYOUT_PENDING  // locked into a ReferralPayout batch
  PAID            // disbursed
  VOIDED          // refund/chargeback/admin void
}

model ReferralCommission {
  id                String           @id @default(cuid())
  referrerId        String                                   // who earns
  referredUserId    String                                   // whose payment generated it
  source            PaymentSource
  externalPaymentId String                                   // Stripe invoice.id / Tribute period key
  originalCurrency  String                                   // "usd","eur","rub"
  originalAmount    Float                                    // amount in payment currency
  exchangeRateToUsd Float                                    // fixed at record creation
  grossAmountUsd    Float                                    // before deductions
  processorFeeUsd   Float                                    // Stripe: real balance_transaction fee; Tribute: configured 10%
  taxUsd            Float            @default(0)              // VAT/tax (0 at MVP, field ready)
  discountUsd       Float            @default(0)              // coupons/discounts (0 at MVP, field ready)
  refundUsd         Float            @default(0)              // partial refund tracking (0 at MVP)
  netAmountUsd      Float                                    // gross - processorFee - tax - discount (commission base)
  rateBps           Int                                      // 3000 = 30%, fixed at accrual
  commissionUsd     Float                                    // net * rateBps/10000
  status            CommissionStatus @default(PENDING)
  availableAt       DateTime                                 // paidAt + 14 days
  payoutId          String?                                  // ReferralPayout batch, when locked
  payout            ReferralPayout?  @relation(fields: [payoutId], references: [id])
  adminNote         String?                                  // for voids / overrides audit
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt

  @@unique([source, externalPaymentId])   // one payment = one commission; kills duplicate webhooks
  @@index([referrerId, status])
  @@index([status, availableAt])
}
```

> `@@unique([source, externalPaymentId])` is sufficient to guarantee "one payment = one commission" - a payment belongs to exactly one referred user, hence one referrer. `referrerId` is intentionally **not** part of the key. (Future: if a single invoice ever carries multiple billable line items, the key would extend to `[source, externalPaymentId, referredUserId]`; not needed for the current one-payment-one-commission model.)

### 3.3 `ReferralPayout` - a batch payout to one referrer
```prisma
enum PayoutStatus { PENDING APPROVED PAID REJECTED }

model ReferralPayout {
  id            String       @id @default(cuid())
  referrerId    String
  amountUsd     Float                              // sum of linked AVAILABLE commissions
  networkFeeUsd Float        @default(0)           // entered by admin at approval
  netPayoutUsd  Float                              // amountUsd - networkFeeUsd
  payoutMethod  String?
  destination   String                             // snapshot of payoutDestination at batch creation
  status        PayoutStatus @default(PENDING)
  txRef         String?                            // transfer hash/reference, set at mark-as-paid
  adminNote     String?
  approvedBy    String?                            // admin telegram id
  approvedAt    DateTime?
  paidAt        DateTime?
  rejectedAt    DateTime?
  commissions   ReferralCommission[]
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt

  @@index([status])
  @@index([referrerId])
}
```

### 3.4 Balance is derived, not stored
A referrer's balance is always an aggregate over the ledger, never a mutable counter:
- **Pending** = `sum(commissionUsd) where status = PENDING`
- **Available** = `sum(commissionUsd) where status = AVAILABLE`
- **Paid** = `sum(commissionUsd) where status = PAID`

This guarantees auditability and correct clawbacks.

---

## 4. Attribution Flow

Referral code is generated lazily: on first visit to the referral section (web `/dashboard/referrals` or `/referral` in the bot), if `referralCode` is empty **and** `referralTermsAcceptedAt` is set, generate a unique 8-char slug.

### 4.1 Web
1. Visitor lands on `clipclap.io/?ref=CODE` → middleware sets an `httpOnly` cookie `ref=CODE`, TTL 30 days. **Last-touch:** each new click overwrites the cookie.
2. On **account creation** (Auth.js `events.createUser`), read the cookie → resolve referrer by `referralCode` → call `attachReferral`. Clear the cookie afterward.

### 4.2 Telegram bot
1. Referral link = `t.me/ClipClapBot?start=ref_CODE`. A `start` deep-link bypasses the first-`/start` two-button onboarding screen (per existing onboarding behavior).
2. On `/start ref_CODE`, resolve the code → create the account (if new) → call `attachReferral`.

### 4.3 Shared rule - `attachReferral(newUserId, code)`
Sets `referredById` **once**, only if all hold:
- The code resolves to an existing referrer.
- Not a self-referral (referrer `id`, `telegramId`, and `email` all differ from the new user's).
- `referredById` is currently empty (one-time lock).

`referredById` is **immutable** after first assignment, except a manual admin override that writes an audit note.

---

## 5. Commission Accrual

Single idempotent function in `referral.service`:

```
recordCommission({ payerUserId, source, externalPaymentId, originalAmount,
                   originalCurrency, exchangeRateToUsd, grossAmountUsd, processorFeeUsd, paidAt }):
  1. payer = getUser(payerUserId)
  2. if !payer.referredById -> return            // unattached payer
  3. if referrer is self (id/telegram/email)     // safety net
       -> return
  4. if referrer is banned                        // /refban
       -> return
  5. netAmountUsd  = grossAmountUsd - processorFeeUsd - taxUsd - discountUsd   // tax/discount = 0 at MVP
  6. commissionUsd = round(netAmountUsd * RATE_BPS / 10000, 2)
  7. upsert ReferralCommission by (source, externalPaymentId)
       - on conflict: no-op (duplicate webhook)
       - status = PENDING, availableAt = paidAt + 14d
```

### 5.1 Call sites (no logic duplication)
- **Stripe** - `billing.service.ts` `handleWebhook`, case `invoice.payment_succeeded`:
  - `externalPaymentId = invoice.id`
  - `grossAmountUsd = amount_paid / 100` (normalized to USD)
  - `processorFeeUsd` = real fee from the invoice's `balance_transaction`
  - `paidAt = status_transitions.paid_at ?? created`
  - Covers both first payment and renewals.
- **Tribute** - `tribute.service.ts` `applySubscription` (`newSubscription` + `renewedSubscription`):
  - `externalPaymentId = period_id ?? `${subscription_id}:${expires_at}`` (each renewal has a distinct `expires_at`, so periods never collapse)
  - `grossAmountUsd` from `payload.amount` normalized to USD
  - `processorFeeUsd` = configured Tribute fee (10%)

### 5.2 Currency normalization
Non-USD payments are normalized using a fixed `exchangeRateToUsd` from config, **captured on the commission record** (`originalCurrency`, `originalAmount`, `exchangeRateToUsd`) so later rate changes never cause reconciliation drift.

### 5.3 Clawback (`voidCommission`)
- **Stripe:** handle `charge.refunded` and `charge.dispute.created` → void the matching commission. `invoice.payment_failed` is handled as a safety net (commission usually not yet created).
- **Tribute:** `cancelledSubscription` only voids **future** periods; already-`PAID` commissions are not touched.
- Commission in `PENDING` / `AVAILABLE` / `PAYOUT_PENDING` → `VOIDED`.
- Refund **after** `PAID` is **not** clawed back automatically: record the refund event, increment a refund count surfaced in the `/ref` admin card, flag the referrer for manual review if suspicious.
- MVP: any refund → `VOIDED` (no proportional partial-refund logic; noted as a later enhancement).

### 5.4 Hold release
A BullMQ repeatable job moves `PENDING → AVAILABLE` where `availableAt <= now`. No lazy recompute on read - balance and CRM stay simple.

---

## 6. Payout Lifecycle & Telegram CRM

### 6.1 Commission status flow
```
PENDING --(hold 14d)--> AVAILABLE --(batch job)--> PAYOUT_PENDING --(admin paid)--> PAID
                                    PAYOUT_PENDING --(admin reject)--> AVAILABLE
any state before PAID --(refund/chargeback/refvoid)--> VOIDED
```

### 6.2 Payout batch job (BullMQ repeatable, runs daily, acts on the 1st & 15th)
In a single transaction per referrer (prevents double payouts):
1. Group `AVAILABLE` commissions (not yet linked to a payout) by `referrerId`.
2. `available = sum(commissionUsd)`.
3. If `available >= $50` **and** `payoutDestination` is set:
   - Create `ReferralPayout(status=PENDING)` with `destination` snapshot and `amountUsd`.
   - Link the commissions and flip them to `PAYOUT_PENDING` **in the same transaction**.
4. Otherwise carry over to the next cycle.
5. Notify the referrer: "Payout of $X created, processing."

### 6.3 Telegram admin CRM (gated by `REFERRAL_ADMIN_TELEGRAM_IDS`)
- `/payouts` - list `PENDING` payouts (referrer, amount, destination, commission count) with inline buttons.
- **Approve** - confirm amount, enter `networkFeeUsd`, confirm destination → `APPROVED` (`approvedBy`, `approvedAt`, recompute `netPayoutUsd`).
- **Mark as paid** - enter `txRef` → `PAID` (`paidAt`); linked commissions → `PAID`. Notify referrer with the gross/fee/net breakdown.
- **Reject** - `REJECTED` (`rejectedAt`); linked commissions revert to `AVAILABLE` (return to next batch). For fraud cases.
- `/ref <code|telegramId>` - referrer card: total earned, available, pending payout, paid, referred-users count, active-subscriptions count, refund/chargeback count, status (active/banned).
- `/refban <userId>` - stop **future** accrual; leaves current commissions untouched.
- `/refvoid <userId> <reason>` - void current `AVAILABLE` / `PENDING` / `PAYOUT_PENDING` commissions. **Reason is mandatory** and written to each affected commission's `adminNote` (no void without a reason).

Approve and Mark-as-paid are deliberately separate steps (approve now, send USDT/PayPal/bank manually, then record the tx).

### 6.4 Payout notification format
```
Gross payout: $52.00
Network fee:  $2.00
Net payout:   $50.00
tx: 0xabc...
```

---

## 7. Referrer-Facing UI

### 7.1 Web - `/dashboard/referrals`
- Terms gate: if `referralTermsAcceptedAt` is unset, show a join screen - "By joining the affiliate program, you agree to the payout terms and anti-fraud rules." Accepting sets `referralTermsAcceptedAt` **and** `referralTermsVersion = REFERRAL_CONFIG.termsVersion`, then issues the code. If terms later change (e.g. 30% → 20%), the stored version records what each referrer agreed to.
- Referral links with copy buttons: `clipclap.io/?ref=CODE` and `t.me/ClipClapBot?start=ref_CODE`.
- Balance: **Pending** / **Available** / **Paid (total)**.
- "Next payout date: 1st / 15th" and "Minimum payout: $50".
- Payout destination field + method; if unset, banner "Not set - set payout details to receive payments." Payouts are not created until it is set.
- Referrals table (no PII): `User (masked) · Signup date · Plan · Status · Paid amount · Commission`.
- Payout history with `txRef` and status.
- Terms text: "30% commission from your referrals' net payments (after payment fees), for life. 14-day hold. Payouts on the 1st and 15th. $50 minimum."

### 7.2 Telegram bot - referrer commands (EN/RU by locale)
- `/referral` - links + short balance + next payout + minimum, with buttons `Copy link · Balance · Payout settings · How it works`:
  ```
  Your referral link:
  https://clipclap.io/?ref=ABCD1234

  Telegram link:
  https://t.me/ClipClapBot?start=ref_ABCD1234

  Balance:
  Pending:   $12.40
  Available: $54.20
  Paid:      $180.00

  Next payout: 1st / 15th
  Minimum payout: $50
  ```
- `/balance` - detailed balance + next payout date.
- `/payout` - set/change `payoutMethod` + `payoutDestination`, with per-method validation.

**Payout destination validation** (web and bot share one validator):
| `payoutMethod` | `payoutDestination` format |
|---|---|
| `PAYPAL` | valid email |
| `USDT_TRC20` | TRON address (starts with `T`, base58, 34 chars) |
| `BANK` | free text (IBAN/account), non-empty, manual admin verification |

Surface split: **web** for detailed stats, **bot** for quick actions + notifications, **admin Telegram CRM** for manual approve/reject.

---

## 8. Fraud & Edge Cases

- **Self-referral:** blocked by id/telegramId/email comparison in `attachReferral` plus a safety check at accrual.
- **Re-attribution:** `referredById` is immutable after first assignment (admin override only, with audit note).
- **Referrer deleted/banned:** ledger rows are retained for audit; payout eligibility goes to manual admin review rather than auto-paying.
- **Plan upgrade/downgrade:** commission is always a % of the actual payment amount, so it self-corrects.
- **Refund after `PAID`:** no auto clawback; record event, increment refund count, flag for review.
- **Duplicate webhook:** absorbed by `@@unique([source, externalPaymentId])`.
- **`payoutDestination` changed between batches:** the batch uses the `destination` snapshot taken at creation.
- **Non-USD currency:** normalized to USD with the rate captured on the record.

---

## 9. Configuration (`packages/shared/src/config/referral.ts`)
```ts
export const REFERRAL_CONFIG = {
  rateBps: 3000,                 // 30%
  holdDays: 14,
  payoutDays: [1, 15],
  minPayoutUsd: 50,
  attributionWindowDays: 30,
  codeLength: 8,
  termsVersion: "2026-05-29",    // bump when commission terms change
  feeRateBps: { TRIBUTE: 1000 }, // Stripe fee read from balance_transaction; Tribute 10%
  exchangeRatesToUsd: { usd: 1, eur: 1.08, rub: 0.011 }, // fixed at MVP
} as const;
```
`REFERRAL_ADMIN_TELEGRAM_IDS` lives in env (comma-separated).

---

## 10. Testing (Vitest, mirroring `tribute.service.test.ts`)
- `attachReferral`: happy path / self-referral / repeat attach (no overwrite) / unknown code.
- `recordCommission`: happy path / duplicate webhook → no duplicate / unattached payer / banned referrer → no accrual / net & rate math.
- Clawback: refund before hold ends → PENDING voided; refund after AVAILABLE → voided; refund after PAID → not clawed, refund count incremented.
- Hold-release job: `PENDING → AVAILABLE` on `availableAt`.
- Payout batch job: grouping, $50 threshold, missing destination skipped, `AVAILABLE → PAYOUT_PENDING` in a transaction (no duplicates on double run), commissions already linked to another payout are not re-included, destination snapshot stable when `payoutDestination` changes after creation.
- Attribution: last-touch cookie overwrite, 30-day window, bot deep-link.
- Webhook integration: Stripe `invoice.payment_succeeded` / `charge.refunded`; Tribute new/renewed/cancelled → correct ledger entries.

---

## 11. Out of Scope / Later
- Proportional partial-refund clawback.
- Custom vanity codes.
- Automated disbursement (Stripe Connect / crypto API).
- Sub-affiliate / multi-level tiers.
- Web admin panel.
- Live exchange-rate feed.
