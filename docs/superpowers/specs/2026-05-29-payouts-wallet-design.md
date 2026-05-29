# ClipClap Payouts / Wallet - Design Spec

**Date:** 2026-05-29
**Status:** Approved for planning
**Supersedes:** the payout half of `2026-05-29-referral-program-design.md` (ReferralPayout, the 1st/15th batch job, `User.payoutMethod`/`payoutDestination`, the bot `/payout` command, and the referral-specific payout CRM).

## Summary

Introduce a single, source-agnostic **Wallet / Payouts** layer that is the one place a user's withdrawable money lives and the one place withdrawals happen. The referral program keeps its accrual/hold/clawback logic but stops owning payouts: once a referral commission clears its hold it posts a **credit** to the Wallet. Future earning sources (ad partnerships, manual bonuses, creator campaigns) post to the same Wallet. Withdrawals are **on-demand requests** (user picks a crypto method + amount), reviewed and paid manually by an admin via the existing Telegram CRM.

Separation of concerns:
- `ReferralCommission` answers **why** money appeared (accrual, 14-day hold, clawback).
- `WalletEntry` answers **money in balance** (immutable credit/debit ledger).
- `WithdrawalRequest` answers **money leaving** (request → approve → pay), and locks funds while in flight.

---

## 1. Goals & Non-Goals

### Goals
- One unified withdrawable balance across all earning sources (referral now; ad-partnership/bonuses later).
- On-demand withdrawal requests with manual admin approval and payment.
- Crypto-only payout methods at launch (manual fulfilment; method = where the admin sends).
- Auditable, immutable money ledger; balance derived, never a stored counter.
- Retire the referral-specific payout machinery cleanly.

### Non-Goals (MVP)
- The ad-partnership earning system itself (clients adding their TikTok/Reels as ad inventory, advertiser matching, pay-per-view). Out of scope; the Wallet is merely designed to accept it later as another credit source.
- Non-crypto rails (PayPal, bank, Skrill, etc.) - added later via config.
- Automated/programmatic disbursement (Stripe Connect, crypto payout APIs) - payouts are manual.
- Saved payout methods (destination is captured per-request at MVP).
- User-initiated cancellation of a pending request (`CANCELLED` status) - deferred.
- Scheduled batch payouts (the referral 1st/15th model is retired).

---

## 2. Agreed Parameters (config `WALLET_CONFIG`)

| Parameter | Value |
|---|---|
| Minimum withdrawal | **$50** (shared across all sources) |
| Partial withdrawal | allowed - any amount in `[$50 … available]` |
| Active requests per user | **1** at a time (`PENDING`/`APPROVED`) |
| Methods at launch | **crypto only** (USDT TRC20, USDT ERC20, BTC, ETH, USDC; extensible via config) |
| Network fee | entered by admin at approval, deducted from payout |
| Source-side hold | referral keeps its **14-day** hold before crediting the Wallet |
| Admin surface | Telegram CRM (generalized from referral payouts) |
| Negative balance | allowed after post-withdrawal clawback; **blocks new withdrawals** until recovered |

---

## 3. Data Model (Prisma)

### 3.1 `WalletEntry` - immutable money ledger
```prisma
enum WalletEntryKind { CREDIT  DEBIT }
enum WalletSource    { REFERRAL  AD_PARTNERSHIP  ADJUSTMENT  WITHDRAWAL }

model WalletEntry {
  id        String          @id @default(cuid())
  userId    String
  user      User            @relation(fields: [userId], references: [id], onDelete: Restrict)
  kind      WalletEntryKind                 // CREDIT (+) | DEBIT (-)
  source    WalletSource
  amountUsd Float                           // always a positive magnitude
  refType   String                          // fixed vocabulary (see below) - NOT null
  refId     String                          // source id - NOT null (money rows always reference something)
  memo      String?
  createdAt DateTime        @default(now())

  @@unique([source, refType, refId])        // one source event = one entry (idempotency)
  @@index([userId, createdAt])
  @@index([userId, source])
}
```

**`refType` fixed vocabulary** (avoid free-text drift): `referral_commission`, `referral_clawback`, `withdrawal`, `manual_adjustment`, `ad_campaign_reward`.

**`refId` is mandatory for every money row.** Manual adjustments generate their own `adjustmentId` (e.g. a cuid) rather than leaving `refId` null - this keeps the unique index free of NULL holes.

> `onDelete: Restrict` on the user relation: money ledger rows must never be cascade-deleted (audit retention). A user with wallet history cannot be hard-deleted; this also informs the referral spec's earlier open item.

### 3.2 `WithdrawalRequest` - one withdrawal (any source)
```prisma
enum WithdrawalStatus { PENDING  APPROVED  PAID  REJECTED }

model WithdrawalRequest {
  id                    String           @id @default(cuid())
  userId                String
  user                  User             @relation(fields: [userId], references: [id], onDelete: Restrict)
  amountUsd             Float                          // gross requested
  method                String                         // "USDT_TRC20" | "BTC" | ...
  destination           String                         // crypto address (validated per method)
  requestedAvailableUsd Float                          // snapshot of available at request time (audit)
  networkFeeUsd         Float            @default(0)    // set by admin at approval
  netAmountUsd          Float?                          // amountUsd - networkFeeUsd, computed at approval
  status                WithdrawalStatus @default(PENDING)
  txRef                 String?
  adminNote             String?
  approvedBy            String?
  approvedAt            DateTime?
  paidBy                String?
  paidAt                DateTime?
  rejectedBy            String?
  rejectedAt            DateTime?
  createdAt             DateTime         @default(now())
  updatedAt             DateTime         @updatedAt

  @@index([status, createdAt])
  @@index([userId, status])
}
```

### 3.3 Derived balances (never stored)
For a given `userId`:
- `ledgerBalance` = `sum(amountUsd where kind=CREDIT) - sum(amountUsd where kind=DEBIT)`
- `locked` = `sum(amountUsd) of WithdrawalRequest where status in (PENDING, APPROVED)`
- **`available` = `ledgerBalance - locked`** ← withdrawable amount
- `paidOut` (lifetime) = `sum(amountUsd) of WalletEntry where source=WITHDRAWAL` (all DEBIT)
- `clearing` (source-side, not yet money) = referral: `sum(commissionUsd) of ReferralCommission where status=PENDING`

Worked example:
```
start:            ledger 100, locked 0   -> available 100
request $50:      ledger 100, locked 50  -> available 50
paid:             ledger  50, locked 0   -> available 50   (DEBIT written, request leaves locked)
reject instead:   ledger 100, locked 0   -> available 100  (no DEBIT, funds unlock)
```

### 3.4 `ReferralCommission` changes (simplification)
- Status enum reduced to **`PENDING → AVAILABLE → VOIDED`**. Drop `PAYOUT_PENDING` and `PAID` (payout state now lives on `WithdrawalRequest`).
- The commission no longer tracks payout. "Has it been credited to the wallet?" is answered by the existence of a `WalletEntry` with `(source=REFERRAL, refType=referral_commission, refId=commissionId)` - no extra column needed.

### 3.5 `User` changes
- **Remove** `payoutMethod` and `payoutDestination` (destination is now snapshotted per `WithdrawalRequest`).
- Add relations: `walletEntries WalletEntry[]`, `withdrawalRequests WithdrawalRequest[]`.

---

## 4. Money Flows

### 4.1 Referral credit (on hold-release)
The existing `releaseMaturedCommissions` job flips `ReferralCommission` `PENDING → AVAILABLE`. In the **same transaction**, for each commission transitioned, post a wallet credit (idempotent via the unique key):
```
WalletEntry { userId: referrerId, kind: CREDIT, source: REFERRAL,
              refType: "referral_commission", refId: commissionId,
              amountUsd: commissionUsd }
```

### 4.2 Referral clawback (refund / chargeback / admin void)
`voidCommission` / `voidReferrerCommissions` set the commission to `VOIDED`. Then:
- If the commission was **never credited** (still `PENDING`, no wallet entry) → just void, no wallet entry.
- If it was **already credited** (`AVAILABLE`, wallet credit exists) → write a compensating debit:
```
WalletEntry { userId, kind: DEBIT, source: REFERRAL,
              refType: "referral_clawback", refId: commissionId,
              amountUsd: commissionUsd }
```
A post-withdrawal clawback may drive `ledgerBalance` negative - this is allowed and blocks new withdrawals until the balance recovers (see 4.4).

### 4.3 Withdrawal creation (`createWithdrawal`) - transactional, double-spend safe
Runs in a **Serializable** transaction with **retry (1-2x) on serialization failure**:
```
1. validate method ∈ WALLET_CONFIG.methods; validate destination per method rules
2. ledgerBalance = sum(CREDIT) - sum(DEBIT)         for userId
3. locked        = sum(amount) WHERE status IN (PENDING, APPROVED)
4. available     = ledgerBalance - locked
5. reject if any:
     - ledgerBalance <= 0 OR available <= 0          (negative/zero balance guard)
     - amount < WALLET_CONFIG.minWithdrawalUsd
     - amount > available
     - user already has an active request (PENDING/APPROVED)
6. create WithdrawalRequest(PENDING, amountUsd=amount, method, destination,
     requestedAvailableUsd = available, networkFeeUsd = 0, netAmountUsd = amount)
7. notify user: "Withdrawal requested, under review"
```

### 4.4 Withdrawal lifecycle (admin, manual)
Status guards enforced on every transition (wrong-state transitions throw):
```
PENDING  --approve(networkFeeUsd, adminId)-->  APPROVED
APPROVED --markPaid(txRef, adminId)-------->   PAID
PENDING/APPROVED --reject(reason, adminId)->   REJECTED
```
- **approve** (only from `PENDING`): require `0 <= networkFeeUsd < amountUsd` and resulting `netAmountUsd = amountUsd - networkFeeUsd > 0`. **Re-check coverage**: `ledgerBalance >= sum(active withdrawal amounts incl. this request)`; if a clawback has since reduced the balance below coverage, **block approval** with an admin error that shows the breakdown (no `ON_HOLD` state at MVP - admin resolves by rejecting or waiting for balance to recover), e.g.:
```
Cannot approve: balance no longer covers this withdrawal after a clawback.
Ledger balance: $40 · Locked: $50 · Requested: $50
``` Set `approvedBy`, `approvedAt`.
- **markPaid** (only from `APPROVED`): set `status=PAID`, `paidBy`, `paidAt`, `txRef`, **and** write the debit, all in **one transaction**, idempotently:
```
WalletEntry { userId, kind: DEBIT, source: WITHDRAWAL,
              refType: "withdrawal", refId: requestId, amountUsd }
```
  The `@@unique([source, refType, refId])` guarantees a double-pay/replayed command cannot double-debit.
- **reject** (from `PENDING` or `APPROVED`): **reason mandatory** → `adminNote`; set `rejectedBy`, `rejectedAt`. No wallet entry; funds unlock automatically (request leaves the `locked` set).

---

## 5. Anti-Fraud & Edge Cases
- **Double-spend:** transactional available-check + "one active request" rule.
- **Crypto address validation** per method (per-method regex/checksum; e.g. TRON `^T[1-9A-HJ-NP-Za-km-z]{33}$`).
- **Negative balance** (post-withdrawal clawback) blocks new withdrawals; active requests cannot be approved while uncovered.
- **Manual approval** of every request (anti-fraud review).
- **Source-side hold** (referral 14 days) - only matured money reaches the Wallet.
- **Idempotent debits** on payment (unique key) - no double-debit on retries.
- **Serialization retries** on the create transaction.
- Future (noted, not MVP): payout-destination-change cooldown once saved methods exist; withdrawal velocity limits; `CANCELLED` status for user self-cancel.

---

## 6. Admin (Telegram CRM) - generalized
The existing referral payout commands switch from `ReferralPayout` to `WithdrawalRequest` (gated by `REFERRAL_ADMIN_TELEGRAM_IDS`, possibly renamed `WALLET_ADMIN_TELEGRAM_IDS`):
- `/payouts` - list `PENDING`/`APPROVED` withdrawal requests (user, amount, method, destination).
- `/approve <id> <networkFee>` - approve (with fee/coverage guards from 4.4).
- `/paid <id> <txRef>` - mark paid (writes debit).
- `/reject <id> <reason>` - reject (reason mandatory).
- `/ref <code|telegramId|userId>` - now a **Wallet card**:
  ```
  Ledger balance · Locked · Available
  Pending withdrawal · Paid out (lifetime)
  Referral earned · Ad partnership earned
  Refund/clawback count · Status (active/banned)
  ```

---

## 7. User-Facing UI (minimal monochrome - matches the dashboard)

### 7.1 Sidebar
Add a **Payouts** item (Wallet icon) next to Affiliate.

### 7.2 `/dashboard/payouts` (server component + client islands)
- **Header:** "Payouts" + "Withdraw your earnings from across ClipClap."
- **Balance box:** large **Available** (`ledgerBalance - locked`); below a divider, small: **Clearing** (source-side hold, e.g. referral commissions < 14 days), **In withdrawal** (locked), **Paid out** (lifetime).
- **Earnings by source:** small line - "Referral: $X" (more sources later).
- **Withdraw (client island):**
  - If an active request exists (`PENDING`/`APPROVED`) → show its status card (amount, method, status, date) instead of the form ("one active at a time").
  - Else the form: **monochrome chip grid** of crypto methods (USDT TRC20 / USDT ERC20 / BTC / ETH / USDC) - selected chip = white border, no colored coin logos; destination input (validated per method); amount input (`[$50 … available]`); **Withdraw** button. If `available < $50` → disabled with hint.
- **Withdrawal history:** table - date, amount (gross / net), method, destination (masked), status, txRef.
- The history/source views should accommodate all `WalletSource` values (`Referral`, `Ad partnership`, `Adjustment`, `Withdrawal`) so the page reads as a true wallet, not a referral-only view.

### 7.3 `/dashboard/referrals` changes
- **Remove** the "Payout destination" section entirely.
- **Do NOT show "Available to withdraw"** here (single source of truth = Payouts page).
- Earnings box becomes referral-specific:
  - **Pending (14-day hold)** = `sum(commissionUsd) of ReferralCommission where status=PENDING`.
  - **Total referral earnings** = `sum(amountUsd) of WalletEntry where source=REFERRAL and kind=CREDIT` (matches the wallet ledger exactly - not raw `ReferralCommission` sums).
- Add CTA line: "Available to withdraw lives on your Payouts page →" → `/dashboard/payouts`.
- Keep: referral links (code/web/telegram), referrals table, how-it-works/terms.

### 7.4 Bot
- **Remove** the user `/payout` command (set destination) - destination is per-request, withdrawal is a web flow.
- `/balance` now shows **Wallet** balance: Available + **Clearing** with an inline note "Clearing = commissions still in a 14-day hold", plus "Withdraw on clipclap.io/dashboard/payouts".
- `/referral` unchanged (links + referral balance).

---

## 8. Migration (retire the old referral payout machinery)

Removing / replacing - the plan must leave **no** trace of the old payout path:
- **Drop models:** `ReferralPayout` (+ its enum `PayoutStatus`).
- **Drop `ReferralCommission` statuses:** `PAYOUT_PENDING`, `PAID` (migrate any existing rows in those states to `AVAILABLE` and ensure a corresponding wallet credit exists). Enum becomes `PENDING | AVAILABLE | VOIDED`.
- **Drop `User` columns:** `payoutMethod`, `payoutDestination`.
- **Delete service functions:** `runPayoutBatch`, `listPendingPayouts`, `approvePayout`, `markPayoutPaid`, `rejectPayout`, `setPayoutDestination`, `validatePayoutDestination` (the address validator moves to the wallet layer), `acceptReferralTerms`'s payout bits stay only as terms acceptance.
- **Remove the BullMQ payout-batch job** (`PAYOUT_BATCH_JOB`) and its schedule; **keep** `HOLD_RELEASE_JOB` but extend it to post wallet credits (4.1). The referral queue/scheduler stays for hold-release only.
- **Update `releaseMaturedCommissions`** to post wallet credits transactionally.
- **Update `voidCommission` / `voidReferrerCommissions`** to write `referral_clawback` debits for already-credited commissions (and drop the old PAYOUT_PENDING re-coverage logic, which no longer applies).
- **Bot:** remove `/payout` handler + i18n; switch admin CRM from `ReferralPayout` to `WithdrawalRequest`.
- **Web:** delete `apps/web/app/api/referrals/payout-destination/route.ts`; remove the payout form island; add the payouts page + APIs.
- **Data migration note:** since this is pre-launch with no real payout data, the migration can assume zero in-flight `ReferralPayout` rows; still write the Prisma migration to drop the tables/columns/enum values cleanly.

---

## 9. Config (`packages/shared/src/config/wallet.ts`)
```ts
export const WALLET_CONFIG = {
  minWithdrawalUsd: 50,
  methods: [
    { value: "USDT_TRC20", label: "USDT (TRC20)", validate: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
    { value: "USDT_ERC20", label: "USDT (ERC20)", validate: /^0x[a-fA-F0-9]{40}$/ },
    { value: "BTC",        label: "Bitcoin",      validate: /* bech32 + legacy */ },
    { value: "ETH",        label: "Ethereum",     validate: /^0x[a-fA-F0-9]{40}$/ },
    { value: "USDC",       label: "USDC (ERC20)", validate: /^0x[a-fA-F0-9]{40}$/ },
  ],
} as const;
```
Exact validators finalized in the plan; serialization-retry count and admin-id env name (`WALLET_ADMIN_TELEGRAM_IDS` vs reusing `REFERRAL_ADMIN_TELEGRAM_IDS`) decided there too.

---

## 10. Testing (Vitest)
- **Balance math:** ledgerBalance/locked/available across credits, debits, active requests; paidOut; clearing.
- **createWithdrawal:** happy path; below-min; above-available; zero/negative balance; existing active request; destination validation per method; (documented) serialization-retry behavior.
- **Lifecycle:** approve fee guards (`0 <= fee < amount`, net > 0); approve coverage re-check (blocks when clawback uncovered); markPaid writes idempotent debit (no double-debit on replay); reject requires reason + unlocks; status guards reject wrong-state transitions.
- **Referral integration:** hold-release posts a CREDIT idempotently; clawback before credit (no entry) vs after credit (debit); `ReferralCommission` only ever `PENDING/AVAILABLE/VOIDED`.
- **Referral page numbers:** Total referral earnings == sum of REFERRAL credits; Pending == PENDING commissions.
- **Migration:** no references to ReferralPayout/runPayoutBatch/payoutDestination/`/payout` remain (grep-level check in the plan's final task).

---

## 10a. Tech debt (noted, not MVP)
- **Money as `Float`:** MVP stores USD amounts as `Float` (consistent with the existing `ReferralCommission`/plan code). For a money system this should become integer cents (`amountUsdCents Int`) before volume grows - especially once CPA/CPM ad rewards produce many tiny accruals where float drift accumulates. Tracked as a future migration, not a launch blocker.

## 11. Out of Scope / Later
- Ad-partnership earning system (the credit source), creator campaigns, manual bonus UI.
- Non-crypto payout rails; saved payout methods + change-cooldown.
- Automated disbursement; withdrawal velocity limits; `CANCELLED` (user self-cancel).
- Web admin panel (admin stays in Telegram).
