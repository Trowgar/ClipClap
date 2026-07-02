# ClipClap Referral Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified referral program (web + Telegram bot) where referrers earn 30% lifetime commission on referred users' payments, accrued to an auditable ledger, held 14 days, and paid out in admin-approved batches on the 1st & 15th via a Telegram CRM.

**Architecture:** All business logic lives in `packages/shared/src/services/referral.service.ts` (service-layer pattern per CLAUDE.md), called by both Stripe/Tribute webhook handlers and the bot. Commissions are an immutable ledger (`ReferralCommission`); balance is a derived aggregate. Two idempotent, time-driven service functions (`releaseMaturedCommissions`, `runPayoutBatch`) are scheduled by BullMQ repeatable jobs in the worker process. Attribution is last-touch: a 30-day cookie on web (read at Auth.js `createUser`) and a `ref_<code>` Telegram deep-link.

**Tech Stack:** TypeScript, Next.js 15 (App Router), Prisma + PostgreSQL, BullMQ + Redis, Auth.js v5, Vitest. Monorepo with npm workspaces; shared package imported as `@clipclap/shared`.

---

## Conventions (read once before starting)

- **Test runner:** `npx vitest run <path>` from repo root. Existing shared tests live in `packages/shared/src/**/__tests__/*.test.ts` and mock Prisma with `vi.hoisted` + `vi.mock("../../lib/prisma", ...)` (see `tribute.service.test.ts`).
- **Prisma:** schema at `prisma/schema.prisma`; migrations via `npx prisma migrate dev --name <name>`. Client uses `engineType = "binary"`.
- **Commits:** small and frequent, one per task step group. Conventional Commits style (`feat(referral): ...`).
- **Money math:** all amounts stored as USD `Float`. Round commission to 2 decimals with `Math.round(x * 100) / 100`.
- **Import surface:** new shared code must be re-exported from `packages/shared/src/services/index.ts` and (for config) reachable via `packages/shared/src/config/index.ts` so `@clipclap/shared` consumers can import it.

---

## File Structure

**Create:**
- `packages/shared/src/config/referral.ts` — `REFERRAL_CONFIG` constants + `termsVersion`.
- `packages/shared/src/services/referral.service.ts` — all referral business logic.
- `packages/shared/src/services/__tests__/referral.service.test.ts` — unit tests.
- `packages/shared/src/lib/referral-queue.ts` — BullMQ queue + repeatable-job registration.
- `apps/worker/src/referral-scheduler.ts` — Worker that runs hold-release + payout-batch jobs.
- `apps/web/app/(dashboard)/dashboard/referrals/page.tsx` — referrer dashboard.
- `apps/web/app/api/referrals/route.ts` — GET dashboard data.
- `apps/web/app/api/referrals/payout-destination/route.ts` — POST set destination.
- `apps/web/app/api/referrals/accept-terms/route.ts` — POST accept terms.

**Modify:**
- `prisma/schema.prisma` — new models, enums, User fields.
- `packages/shared/src/config/index.ts` — export referral config.
- `packages/shared/src/services/index.ts` — export referral service.
- `packages/shared/src/services/billing.service.ts` — accrue/void commission on Stripe events.
- `packages/shared/src/services/tribute.service.ts` — accrue commission on Tribute events.
- `apps/web/middleware.ts` — capture `?ref=` cookie.
- `apps/web/lib/auth.ts` — `events.createUser` attaches referral from cookie.
- `apps/bot/src/handlers.ts` — `ref_` deep-link, `/referral` `/balance` `/payout` + admin commands.
- `apps/bot/src/i18n.ts` — referral strings (EN/RU).
- `apps/worker/src/index.ts` — start the referral scheduler.

---

## Task 1: Prisma schema + migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add enums** after the existing `enum BillingCycle { ... }` block in `prisma/schema.prisma`:

```prisma
enum PaymentSource {
  STRIPE
  TRIBUTE
}

enum CommissionStatus {
  PENDING
  AVAILABLE
  PAYOUT_PENDING
  PAID
  VOIDED
}

enum PayoutStatus {
  PENDING
  APPROVED
  PAID
  REJECTED
}
```

- [ ] **Step 2: Add referral fields + relations to the `User` model.** Inside `model User { ... }`, add these scalar fields after `topUpMinutesRemaining`:

```prisma
  referralCode            String?   @unique
  referredById            String?
  payoutDestination       String?
  payoutMethod            String?
  referralTermsAcceptedAt DateTime?
  referralTermsVersion    String?
  referralBannedAt        DateTime?
```

And add these relation fields alongside the existing relation block (`jobs Job[]` etc.):

```prisma
  referredBy          User?                @relation("Referrals", fields: [referredById], references: [id])
  referrals           User[]               @relation("Referrals")
  commissionsEarned   ReferralCommission[] @relation("ReferrerCommissions")
  commissionsCaused   ReferralCommission[] @relation("ReferredCommissions")
  payouts             ReferralPayout[]
```

- [ ] **Step 3: Add the `ReferralCommission` model** at the end of the file (before the Auth.js models comment block is fine; anywhere top-level):

```prisma
model ReferralCommission {
  id                String           @id @default(cuid())
  referrerId        String
  referrer          User             @relation("ReferrerCommissions", fields: [referrerId], references: [id], onDelete: Cascade)
  referredUserId    String
  referredUser      User             @relation("ReferredCommissions", fields: [referredUserId], references: [id], onDelete: Cascade)
  source            PaymentSource
  externalPaymentId String
  originalCurrency  String
  originalAmount    Float
  exchangeRateToUsd Float
  grossAmountUsd    Float
  processorFeeUsd   Float
  taxUsd            Float            @default(0)
  discountUsd       Float            @default(0)
  refundUsd         Float            @default(0)
  netAmountUsd      Float
  rateBps           Int
  commissionUsd     Float
  status            CommissionStatus @default(PENDING)
  availableAt       DateTime
  payoutId          String?
  payout            ReferralPayout?  @relation(fields: [payoutId], references: [id])
  adminNote         String?
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt

  @@unique([source, externalPaymentId])
  @@index([referrerId, status])
  @@index([status, availableAt])
  @@map("referral_commissions")
}
```

- [ ] **Step 4: Add the `ReferralPayout` model:**

```prisma
model ReferralPayout {
  id            String               @id @default(cuid())
  referrerId    String
  referrer      User                 @relation(fields: [referrerId], references: [id], onDelete: Cascade)
  amountUsd     Float
  networkFeeUsd Float                @default(0)
  netPayoutUsd  Float
  payoutMethod  String?
  destination   String
  status        PayoutStatus         @default(PENDING)
  txRef         String?
  adminNote     String?
  approvedBy    String?
  approvedAt    DateTime?
  paidAt        DateTime?
  rejectedAt    DateTime?
  commissions   ReferralCommission[]
  createdAt     DateTime             @default(now())
  updatedAt     DateTime             @updatedAt

  @@index([status])
  @@index([referrerId])
  @@map("referral_payouts")
}
```

- [ ] **Step 5: Create the migration**

Run: `npx prisma migrate dev --name add_referral_program`
Expected: migration created under `prisma/migrations/<timestamp>_add_referral_program/` and Prisma Client regenerated. No errors.

- [ ] **Step 6: Verify the client typecheck**

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS (no type errors from the new models).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(referral): add referral ledger schema and migration"
```

---

## Task 2: Referral config

**Files:**
- Create: `packages/shared/src/config/referral.ts`
- Modify: `packages/shared/src/config/index.ts`

- [ ] **Step 1: Write the config**

Create `packages/shared/src/config/referral.ts`:

```ts
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
```

- [ ] **Step 2: Export from the config barrel**

Add to `packages/shared/src/config/index.ts`:

```ts
export * from "./referral";
```

(If the file does not already use `export *`, match its existing style — e.g. add `export { REFERRAL_CONFIG, REFERRAL_COOKIE_NAME, exchangeRateToUsd } from "./referral";`.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/config
git commit -m "feat(referral): add referral config constants"
```

---

## Task 3: `attachReferral` + code generation (TDD)

**Files:**
- Create: `packages/shared/src/services/referral.service.ts`
- Test: `packages/shared/src/services/__tests__/referral.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/referral.service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
      updateMany: mocks.userUpdateMany,
    },
  },
}));

import { attachReferral } from "../referral.service";

const REFERRER = {
  id: "ref-1",
  telegramId: "111",
  email: "ref@example.com",
  referralBannedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("attachReferral", () => {
  it("attaches a fresh user to the referrer", async () => {
    mocks.userFindUnique
      .mockResolvedValueOnce({ ...REFERRER }) // resolve referrer by code
      .mockResolvedValueOnce({
        id: "new-1",
        telegramId: "222",
        email: "new@example.com",
        referredById: null,
      }); // load new user
    mocks.userUpdateMany.mockResolvedValue({ count: 1 });

    const result = await attachReferral("new-1", "ABCD1234");

    expect(result.status).toBe("attached");
    expect(mocks.userUpdateMany).toHaveBeenCalledWith({
      where: { id: "new-1", referredById: null },
      data: { referredById: "ref-1" },
    });
  });

  it("rejects an unknown code", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    const result = await attachReferral("new-1", "NOPE");
    expect(result.status).toBe("unknown_code");
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks self-referral by id", async () => {
    mocks.userFindUnique
      .mockResolvedValueOnce({ ...REFERRER })
      .mockResolvedValueOnce({
        id: "ref-1",
        telegramId: "111",
        email: "ref@example.com",
        referredById: null,
      });
    const result = await attachReferral("ref-1", "ABCD1234");
    expect(result.status).toBe("self_referral");
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing binding", async () => {
    mocks.userFindUnique
      .mockResolvedValueOnce({ ...REFERRER })
      .mockResolvedValueOnce({
        id: "new-1",
        telegramId: "222",
        email: "new@example.com",
        referredById: "someone-else",
      });
    const result = await attachReferral("new-1", "ABCD1234");
    expect(result.status).toBe("already_attached");
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`
Expected: FAIL with "Cannot find module '../referral.service'" (or "attachReferral is not a function").

- [ ] **Step 3: Implement `attachReferral` + `generateReferralCode`**

Create `packages/shared/src/services/referral.service.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export the service**

Add to `packages/shared/src/services/index.ts`:

```ts
export * as referralService from "./referral.service";
export * from "./referral.service";
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/referral.service.ts packages/shared/src/services/__tests__/referral.service.test.ts packages/shared/src/services/index.ts
git commit -m "feat(referral): add attachReferral and code generation"
```

---

## Task 4: `recordCommission` + `voidCommission` (TDD)

**Files:**
- Modify: `packages/shared/src/services/referral.service.ts`
- Test: `packages/shared/src/services/__tests__/referral.service.test.ts`

- [ ] **Step 1: Add the failing tests.** Extend the test file's mock to include `referralCommission`, and append a new `describe` block.

Update the `vi.hoisted` mock object and the `vi.mock` to add the commission delegate:

```ts
// add to the mocks object in vi.hoisted(...)
  commissionFindUnique: vi.fn(),
  commissionCreate: vi.fn(),
  commissionUpdateMany: vi.fn(),
```

```ts
// add inside the prisma mock object
    referralCommission: {
      findUnique: mocks.commissionFindUnique,
      create: mocks.commissionCreate,
      updateMany: mocks.commissionUpdateMany,
    },
```

Add to the imports from `../referral.service`: `recordCommission, voidCommission`.

Append:

```ts
describe("recordCommission", () => {
  const base = {
    payerUserId: "new-1",
    source: "STRIPE" as const,
    externalPaymentId: "in_123",
    originalCurrency: "usd",
    originalAmount: 9,
    grossAmountUsd: 9,
    processorFeeUsd: 0.56,
    paidAt: new Date("2026-05-01T00:00:00Z"),
  };

  it("creates a PENDING commission for an attached payer", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "new-1",
      referredById: "ref-1",
      telegramId: "222",
      email: "new@example.com",
    });
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-1",
      telegramId: "111",
      email: "ref@example.com",
      referralBannedAt: null,
    });
    mocks.commissionCreate.mockResolvedValue({ id: "com-1" });

    const result = await recordCommission(base);

    expect(result.status).toBe("recorded");
    const arg = mocks.commissionCreate.mock.calls[0][0].data;
    expect(arg.netAmountUsd).toBeCloseTo(8.44, 2);
    expect(arg.commissionUsd).toBeCloseTo(2.53, 2); // 8.44 * 0.30 = 2.532 -> 2.53
    expect(arg.status).toBe("PENDING");
    expect(arg.availableAt.toISOString()).toBe("2026-05-15T00:00:00.000Z"); // +14d
  });

  it("skips an unattached payer", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "new-1",
      referredById: null,
    });
    const result = await recordCommission(base);
    expect(result.status).toBe("no_referrer");
    expect(mocks.commissionCreate).not.toHaveBeenCalled();
  });

  it("skips a banned referrer", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "new-1",
      referredById: "ref-1",
      telegramId: "222",
      email: "new@example.com",
    });
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-1",
      telegramId: "111",
      email: "ref@example.com",
      referralBannedAt: new Date(),
    });
    const result = await recordCommission(base);
    expect(result.status).toBe("referrer_banned");
    expect(mocks.commissionCreate).not.toHaveBeenCalled();
  });

  it("is idempotent on duplicate external payment id", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "new-1",
      referredById: "ref-1",
      telegramId: "222",
      email: "new@example.com",
    });
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-1",
      telegramId: "111",
      email: "ref@example.com",
      referralBannedAt: null,
    });
    mocks.commissionCreate.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" })
    );
    const result = await recordCommission(base);
    expect(result.status).toBe("duplicate");
  });
});

describe("voidCommission", () => {
  it("voids non-paid commissions for a payment and records the reason", async () => {
    mocks.commissionUpdateMany.mockResolvedValue({ count: 1 });
    const result = await voidCommission("STRIPE", "in_123", "refund");
    expect(result.voided).toBe(1);
    expect(mocks.commissionUpdateMany).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        externalPaymentId: "in_123",
        status: { in: ["PENDING", "AVAILABLE", "PAYOUT_PENDING"] },
      },
      data: { status: "VOIDED", adminNote: "refund" },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`
Expected: FAIL ("recordCommission is not a function").

- [ ] **Step 3: Implement the functions.** Append to `packages/shared/src/services/referral.service.ts`:

```ts
import type { PaymentSource } from "@prisma/client";

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
```

- [ ] **Step 4: Run to verify passes**

Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/referral.service.ts packages/shared/src/services/__tests__/referral.service.test.ts
git commit -m "feat(referral): add recordCommission and voidCommission"
```

---

## Task 5: Wire accrual + clawback into Stripe & Tribute webhooks

**Files:**
- Modify: `packages/shared/src/services/billing.service.ts:197` (invoice.payment_succeeded) and the `switch` in `handleWebhook`
- Modify: `packages/shared/src/services/tribute.service.ts:118` (`applySubscription`) and `applyCancellation`

- [ ] **Step 1: Add a Stripe fee helper + accrual in `invoice.payment_succeeded`.** In `billing.service.ts`, inside `case "invoice.payment_succeeded":` after the existing `prisma.user.updateMany(...)` call that flips status to ACTIVE, add:

```ts
      // Referral accrual: attribute 30% of net to the payer's referrer.
      const payer = await prisma.user.findUnique({
        where: { stripeSubscriptionId: subscriptionId },
        select: { id: true },
      });
      if (payer && invoice.amount_paid > 0) {
        // Real processor fee from the balance transaction when available.
        let feeUsd = 0;
        const bt = invoice.charge
          ? await stripe.charges
              .retrieve(
                typeof invoice.charge === "string" ? invoice.charge : invoice.charge.id,
                { expand: ["balance_transaction"] }
              )
              .then((c) => c.balance_transaction)
              .catch(() => null)
          : null;
        if (bt && typeof bt !== "string") feeUsd = bt.fee / 100;

        const paidAtSec =
          invoice.status_transitions?.paid_at ?? invoice.created;
        const { referralService } = await import("./index");
        await referralService.recordCommission({
          payerUserId: payer.id,
          source: "STRIPE",
          externalPaymentId: invoice.id,
          originalCurrency: invoice.currency ?? "usd",
          originalAmount: invoice.amount_paid / 100,
          exchangeRateToUsd: 1, // Stripe is charged in USD for this product
          grossAmountUsd: invoice.amount_paid / 100,
          processorFeeUsd: feeUsd,
          paidAt: new Date(paidAtSec * 1000),
        });
      }
```

> Dynamic `import("./index")` avoids a static cycle (referral.service does not import billing.service, but this keeps the pattern consistent with the existing `topup.service` dynamic import in this file).

- [ ] **Step 2: Add Stripe clawback cases.** In the same `switch (event.type)`, add two new cases (place them after `invoice.payment_succeeded`):

```ts
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const invoiceId =
        typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
      if (invoiceId) {
        const { referralService } = await import("./index");
        await referralService.voidCommission("STRIPE", invoiceId, "charge.refunded");
      }
      break;
    }

    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId =
        typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
      if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId).catch(() => null);
        const invoiceId =
          charge && typeof charge.invoice === "string"
            ? charge.invoice
            : charge?.invoice?.id;
        if (invoiceId) {
          const { referralService } = await import("./index");
          await referralService.voidCommission("STRIPE", invoiceId, "charge.dispute.created");
        }
      }
      break;
    }
```

- [ ] **Step 3: Accrual in Tribute `applySubscription`.** In `tribute.service.ts`, inside `applySubscription`, after the `await notifyPaymentEvent(...)` call and before `return { status: "applied", ... }`, add:

```ts
  const amount = payload.amount ?? payload.price ?? 0;
  if (amount > 0) {
    const currency = (payload.currency ?? "usd").toLowerCase();
    const externalPaymentId =
      payload.period_id ?? `${tributeSubscriptionId}:${payload.expires_at}`;
    const { recordCommission } = await import("./referral.service");
    const { exchangeRateToUsd, REFERRAL_CONFIG } = await import("../config/referral");
    const rate = exchangeRateToUsd(currency);
    const grossAmountUsd = (amount / 100) * rate; // Tribute amounts are in minor units
    const feeRateBps = REFERRAL_CONFIG.feeRateBps.TRIBUTE ?? 0;
    const processorFeeUsd = (grossAmountUsd * feeRateBps) / 10000;
    await recordCommission({
      payerUserId: user.id,
      source: "TRIBUTE",
      externalPaymentId,
      originalCurrency: currency,
      originalAmount: amount / 100,
      exchangeRateToUsd: rate,
      grossAmountUsd,
      processorFeeUsd,
      paidAt: new Date(),
    });
  }
```

> `amount` from Tribute is in minor units (e.g. cents) per the existing `makeEnvelope` test fixture (`amount: 810` for an $8.10 net). Confirm the unit against a real Tribute payload before launch; if Tribute sends major units, drop the `/100`.

- [ ] **Step 4: Tribute clawback on cancellation.** In `applyCancellation`, after the `prisma.user.update(...)` call, add (only voids **future**/non-paid; already-paid is untouched by `voidCommission`'s status filter):

```ts
  // Cancellation does not refund past periods; nothing to void for already-billed
  // periods. Future renewals simply stop arriving. No commission void here.
```

> Intentional no-op with a comment: Tribute cancellation ends future billing, so there is no past payment to claw back. Refunds (if Tribute ever sends them) would be a separate event handled later.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS. (If `invoice.charge` / `status_transitions` types complain, the installed Stripe SDK version exposes them; cast with `as Stripe.Invoice` already in scope.)

- [ ] **Step 6: Run the full shared test suite (nothing should regress)**

Run: `npx vitest run packages/shared/src`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/services/billing.service.ts packages/shared/src/services/tribute.service.ts
git commit -m "feat(referral): accrue and void commissions from Stripe and Tribute webhooks"
```

---

## Task 6: Hold-release + payout-batch service functions (TDD)

**Files:**
- Modify: `packages/shared/src/services/referral.service.ts`
- Test: `packages/shared/src/services/__tests__/referral.service.test.ts`

- [ ] **Step 1: Add failing tests.** Extend the prisma mock with the pieces these functions need, then append tests.

Add to `vi.hoisted` mocks:

```ts
  commissionUpdateManyRelease: vi.fn(),
  txFn: vi.fn(),
  commissionGroupBy: vi.fn(),
  payoutCreate: vi.fn(),
```

Replace the `referralCommission` mock block and add `$transaction` + `referralPayout` so the mock prisma reads:

```ts
    referralCommission: {
      findUnique: mocks.commissionFindUnique,
      create: mocks.commissionCreate,
      updateMany: mocks.commissionUpdateMany,
      groupBy: mocks.commissionGroupBy,
    },
    referralPayout: {
      create: mocks.payoutCreate,
    },
    $transaction: mocks.txFn,
```

Append tests:

```ts
import { releaseMaturedCommissions, runPayoutBatch } from "../referral.service";

describe("releaseMaturedCommissions", () => {
  it("flips matured PENDING commissions to AVAILABLE", async () => {
    mocks.commissionUpdateMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-05-20T00:00:00Z");
    const result = await releaseMaturedCommissions(now);
    expect(result.released).toBe(3);
    expect(mocks.commissionUpdateMany).toHaveBeenCalledWith({
      where: { status: "PENDING", availableAt: { lte: now } },
      data: { status: "AVAILABLE" },
    });
  });
});

describe("runPayoutBatch", () => {
  it("creates a payout and locks commissions for referrers above the minimum", async () => {
    mocks.commissionGroupBy.mockResolvedValue([
      { referrerId: "ref-1", _sum: { commissionUsd: 60 } },
      { referrerId: "ref-2", _sum: { commissionUsd: 10 } }, // below $50, skipped
    ]);
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-1",
      payoutDestination: "Tabc...",
      payoutMethod: "USDT_TRC20",
    });
    // $transaction runs the callback with a tx client; reuse the same mocks.
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        referralPayout: { create: mocks.payoutCreate },
        referralCommission: { updateMany: mocks.commissionUpdateMany },
      })
    );
    mocks.payoutCreate.mockResolvedValue({ id: "pay-1" });
    mocks.commissionUpdateMany.mockResolvedValue({ count: 2 });

    const now = new Date("2026-06-01T00:00:00Z");
    const result = await runPayoutBatch(now);

    expect(result.created).toBe(1);
    expect(mocks.payoutCreate).toHaveBeenCalledTimes(1);
    const created = mocks.payoutCreate.mock.calls[0][0].data;
    expect(created.referrerId).toBe("ref-1");
    expect(created.amountUsd).toBe(60);
    expect(created.destination).toBe("Tabc...");
  });

  it("skips referrers without a payout destination", async () => {
    mocks.commissionGroupBy.mockResolvedValue([
      { referrerId: "ref-3", _sum: { commissionUsd: 80 } },
    ]);
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "ref-3",
      payoutDestination: null,
      payoutMethod: null,
    });
    const result = await runPayoutBatch(new Date("2026-06-01T00:00:00Z"));
    expect(result.created).toBe(0);
    expect(mocks.payoutCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`
Expected: FAIL ("releaseMaturedCommissions is not a function").

- [ ] **Step 3: Implement.** Append to `referral.service.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify passes**

Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/referral.service.ts packages/shared/src/services/__tests__/referral.service.test.ts
git commit -m "feat(referral): add hold-release and payout-batch job logic"
```

---

## Task 7: Schedule the jobs (BullMQ repeatable) in the worker

**Files:**
- Create: `packages/shared/src/lib/referral-queue.ts`
- Modify: `packages/shared/src/lib/index.ts`
- Create: `apps/worker/src/referral-scheduler.ts`
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Add the queue + repeatable-job registration.** Create `packages/shared/src/lib/referral-queue.ts`:

```ts
import { Queue } from "bullmq";
import { getRedis } from "./redis";

export const REFERRAL_QUEUE_NAME = "referral-maintenance";
export const HOLD_RELEASE_JOB = "hold-release";
export const PAYOUT_BATCH_JOB = "payout-batch";

let referralQueue: Queue | null = null;

export function getReferralQueue(): Queue {
  if (!referralQueue) {
    referralQueue = new Queue(REFERRAL_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    });
  }
  return referralQueue;
}

/**
 * Register repeatable jobs. Idempotent on jobId, so calling on every worker
 * boot is safe. Hold-release runs hourly; payout-batch runs daily at 02:00 UTC
 * (the job body itself checks whether "today" is a payout day).
 */
export async function registerReferralSchedules(): Promise<void> {
  const queue = getReferralQueue();
  await queue.add(
    HOLD_RELEASE_JOB,
    {},
    { repeat: { pattern: "0 * * * *" }, jobId: HOLD_RELEASE_JOB }
  );
  await queue.add(
    PAYOUT_BATCH_JOB,
    {},
    { repeat: { pattern: "0 2 * * *" }, jobId: PAYOUT_BATCH_JOB }
  );
}
```

- [ ] **Step 2: Export from the lib barrel.** Add to `packages/shared/src/lib/index.ts`:

```ts
export * from "./referral-queue";
```

- [ ] **Step 3: Create the worker.** Create `apps/worker/src/referral-scheduler.ts`:

```ts
import { Worker } from "bullmq";
import {
  getRedis,
  REFERRAL_QUEUE_NAME,
  HOLD_RELEASE_JOB,
  PAYOUT_BATCH_JOB,
  REFERRAL_CONFIG,
  releaseMaturedCommissions,
  runPayoutBatch,
} from "@clipclap/shared";

export function createReferralScheduler(): Worker {
  const worker = new Worker(
    REFERRAL_QUEUE_NAME,
    async (job) => {
      const now = new Date();
      if (job.name === HOLD_RELEASE_JOB) {
        const { released } = await releaseMaturedCommissions(now);
        console.log(`[referral] released ${released} commissions`);
        return;
      }
      if (job.name === PAYOUT_BATCH_JOB) {
        const day = now.getUTCDate();
        if (!REFERRAL_CONFIG.payoutDays.includes(day as 1 | 15)) {
          console.log(`[referral] payout-batch skipped (day ${day})`);
          return;
        }
        const { created } = await runPayoutBatch(now);
        console.log(`[referral] created ${created} payouts`);
      }
    },
    { connection: getRedis(), concurrency: 1 }
  );
  worker.on("failed", (job, err) =>
    console.error(`[referral] ${job?.name} failed:`, err.message)
  );
  return worker;
}
```

- [ ] **Step 4: Start it from the worker entrypoint.** In `apps/worker/src/index.ts`, only the `finalize` role (a single, always-on role) should own the scheduler to avoid N workers each registering it. Replace the file body with:

```ts
import { createStageWorker } from "./worker-app";
import { registerReferralSchedules } from "@clipclap/shared";
import { createReferralScheduler } from "./referral-scheduler";

const role = process.env.WORKER_ROLE;

console.log(`ClipClap worker starting with role=${role ?? "(empty)"}`);

const worker = createStageWorker(role);

// Only one role hosts the referral scheduler so schedules register once.
let referralScheduler: ReturnType<typeof createReferralScheduler> | null = null;
if (role === "finalize") {
  referralScheduler = createReferralScheduler();
  void registerReferralSchedules().catch((err) =>
    console.error("[referral] failed to register schedules:", err)
  );
}

async function shutdown(signal: string) {
  console.log(`${signal} received; closing worker`);
  await worker.close();
  if (referralScheduler) await referralScheduler.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
```

> If no worker runs with `WORKER_ROLE=finalize` in your deployment, pick whichever single-instance role does, or add a dedicated `scheduler` role. Verify against `docker-compose.yml` worker service env before merging.

- [ ] **Step 5: Typecheck worker**

Run: `npx tsc -p apps/worker/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/lib/referral-queue.ts packages/shared/src/lib/index.ts apps/worker/src/referral-scheduler.ts apps/worker/src/index.ts
git commit -m "feat(referral): schedule hold-release and payout jobs via BullMQ"
```

---

## Task 8: Admin + read APIs (balance, dashboard, payout admin) (TDD)

**Files:**
- Modify: `packages/shared/src/services/referral.service.ts`
- Test: `packages/shared/src/services/__tests__/referral.service.test.ts`

- [ ] **Step 1: Add failing tests for balance + payout-destination validation.** Append:

```ts
import {
  getReferralBalance,
  validatePayoutDestination,
  setPayoutDestination,
} from "../referral.service";

describe("validatePayoutDestination", () => {
  it("accepts a valid PayPal email", () => {
    expect(validatePayoutDestination("PAYPAL", "a@b.com").ok).toBe(true);
  });
  it("rejects a bad PayPal email", () => {
    expect(validatePayoutDestination("PAYPAL", "nope").ok).toBe(false);
  });
  it("accepts a TRON address", () => {
    expect(
      validatePayoutDestination("USDT_TRC20", "TJRabcdefghijklmnopqrstuvwxyz12345").ok
    ).toBe(true);
  });
  it("rejects a non-TRON address", () => {
    expect(validatePayoutDestination("USDT_TRC20", "0xabc").ok).toBe(false);
  });
  it("accepts non-empty bank text", () => {
    expect(validatePayoutDestination("BANK", "DE89 3704 0044 0532 0130 00").ok).toBe(true);
  });
  it("rejects an unknown method", () => {
    expect(validatePayoutDestination("CASH", "x").ok).toBe(false);
  });
});

describe("getReferralBalance", () => {
  it("aggregates pending, available, and paid", async () => {
    mocks.commissionGroupBy.mockResolvedValue([
      { status: "PENDING", _sum: { commissionUsd: 5 } },
      { status: "AVAILABLE", _sum: { commissionUsd: 60 } },
      { status: "PAYOUT_PENDING", _sum: { commissionUsd: 12 } },
      { status: "PAID", _sum: { commissionUsd: 100 } },
    ]);
    const balance = await getReferralBalance("ref-1");
    expect(balance.pendingUsd).toBe(5);
    expect(balance.availableUsd).toBe(60);
    expect(balance.payoutPendingUsd).toBe(12);
    expect(balance.paidUsd).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement balance, validation, setters, terms, and admin functions.** Append to `referral.service.ts`:

```ts
import type { PayoutStatus } from "@prisma/client";

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

export async function approvePayout(
  payoutId: string,
  adminTelegramId: string,
  networkFeeUsd: number
): Promise<void> {
  const payout = await prisma.referralPayout.findUniqueOrThrow({ where: { id: payoutId } });
  await prisma.referralPayout.update({
    where: { id: payoutId },
    data: {
      status: "APPROVED",
      approvedBy: adminTelegramId,
      approvedAt: new Date(),
      networkFeeUsd,
      netPayoutUsd: round2(payout.amountUsd - networkFeeUsd),
    },
  });
}

export async function markPayoutPaid(payoutId: string, txRef: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.referralPayout.update({
      where: { id: payoutId },
      data: { status: "PAID", paidAt: new Date(), txRef },
    });
    await tx.referralCommission.updateMany({
      where: { payoutId },
      data: { status: "PAID" },
    });
  });
}

export async function rejectPayout(payoutId: string, reason: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.referralPayout.update({
      where: { id: payoutId },
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

export async function voidReferrerCommissions(
  userId: string,
  reason: string
): Promise<{ voided: number }> {
  const result = await prisma.referralCommission.updateMany({
    where: { referrerId: userId, status: { in: [...NON_PAID_STATUSES] } },
    data: { status: "VOIDED", adminNote: reason },
  });
  return { voided: result.count };
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
```

- [ ] **Step 4: Run to verify passes**

Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the web read API.** Create `apps/web/app/api/referrals/route.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma, referralService } from "@clipclap/shared";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      referralCode: true,
      referralTermsAcceptedAt: true,
      payoutMethod: true,
      payoutDestination: true,
    },
  });

  const balance = await referralService.getReferralBalance(userId);
  const referrals = await prisma.user.findMany({
    where: { referredById: userId },
    select: { id: true, createdAt: true, plan: true, subscriptionStatus: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    code: user?.referralCode ?? null,
    termsAccepted: !!user?.referralTermsAcceptedAt,
    payoutMethod: user?.payoutMethod ?? null,
    payoutDestination: user?.payoutDestination ?? null,
    balance,
    referrals,
  });
}
```

- [ ] **Step 6: Create the accept-terms + payout-destination APIs.**

Create `apps/web/app/api/referrals/accept-terms/route.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { referralService } from "@clipclap/shared";

export async function POST() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const code = await referralService.acceptReferralTerms(userId);
  return NextResponse.json({ code });
}
```

Create `apps/web/app/api/referrals/payout-destination/route.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { referralService } from "@clipclap/shared";

export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { method, destination } = await req.json();
  const result = await referralService.setPayoutDestination(userId, method, destination);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: Typecheck web**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/services/referral.service.ts packages/shared/src/services/__tests__/referral.service.test.ts apps/web/app/api/referrals
git commit -m "feat(referral): balance/dashboard/admin service functions and web APIs"
```

---

## Task 9: Web attribution (cookie + Auth.js) and dashboard page

**Files:**
- Modify: `apps/web/middleware.ts`
- Modify: `apps/web/lib/auth.ts`
- Create: `apps/web/app/(dashboard)/dashboard/referrals/page.tsx`

- [ ] **Step 1: Capture the ref cookie in middleware.** Replace `apps/web/middleware.ts` with:

```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { REFERRAL_COOKIE_NAME, REFERRAL_CONFIG } from "@clipclap/shared";

export function middleware(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get("ref");

  // Auth guard only for /dashboard.
  if (req.nextUrl.pathname.startsWith("/dashboard")) {
    const sessionCookie =
      req.cookies.get("authjs.session-token") ||
      req.cookies.get("__Secure-authjs.session-token") ||
      req.cookies.get("next-auth.session-token") ||
      req.cookies.get("__Secure-next-auth.session-token");
    if (!sessionCookie) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    return NextResponse.next();
  }

  // Last-touch attribution: set/overwrite the ref cookie on any page hit with ?ref=.
  const res = NextResponse.next();
  if (ref) {
    res.cookies.set(REFERRAL_COOKIE_NAME, ref, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: REFERRAL_CONFIG.attributionWindowDays * 24 * 60 * 60,
      path: "/",
    });
  }
  return res;
}

export const config = {
  matcher: ["/", "/dashboard/:path*"],
};
```

- [ ] **Step 2: Attach the referral at account creation.** In `apps/web/lib/auth.ts`, add a `createUser` event inside the existing `events: { ... }` block:

```ts
    async createUser({ user }) {
      try {
        const { cookies } = await import("next/headers");
        const { referralService, REFERRAL_COOKIE_NAME } = await import("@clipclap/shared");
        const code = (await cookies()).get(REFERRAL_COOKIE_NAME)?.value;
        if (code && user.id) {
          await referralService.attachReferral(user.id, code);
        }
      } catch (err) {
        console.error("[referral] attach on createUser failed:", err);
      }
    },
```

> `cookies()` is readable inside Auth.js route-handler events. `attachReferral` is one-time and idempotent, so a stale cookie is harmless. The cookie naturally expires after 30 days.

- [ ] **Step 3: Create the dashboard page.** Create `apps/web/app/(dashboard)/dashboard/referrals/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

interface ReferralData {
  code: string | null;
  termsAccepted: boolean;
  payoutMethod: string | null;
  payoutDestination: string | null;
  balance: {
    pendingUsd: number;
    availableUsd: number;
    payoutPendingUsd: number;
    paidUsd: number;
  };
  referrals: Array<{
    id: string;
    createdAt: string;
    plan: string;
    subscriptionStatus: string;
  }>;
}

export default function ReferralsPage() {
  const [data, setData] = useState<ReferralData | null>(null);
  const [method, setMethod] = useState("USDT_TRC20");
  const [destination, setDestination] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/referrals");
    if (res.ok) setData(await res.json());
  }
  useEffect(() => {
    void load();
  }, []);

  async function acceptTerms() {
    await fetch("/api/referrals/accept-terms", { method: "POST" });
    await load();
  }

  async function saveDestination() {
    setError(null);
    const res = await fetch("/api/referrals/payout-destination", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, destination }),
    });
    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "Failed to save");
      return;
    }
    await load();
  }

  if (!data) return <div className="p-8 text-[#EDEDED]">Loading…</div>;

  if (!data.termsAccepted) {
    return (
      <div className="p-8 max-w-2xl text-[#EDEDED]">
        <h1 className="text-2xl font-semibold mb-4">Affiliate Program</h1>
        <p className="mb-6 text-neutral-400">
          Earn 30% of your referrals&apos; net payments (after payment fees), for life.
          14-day hold. Payouts on the 1st and 15th. $50 minimum. By joining you agree
          to the payout terms and anti-fraud rules.
        </p>
        <button
          onClick={acceptTerms}
          className="rounded bg-white px-4 py-2 font-medium text-black"
        >
          Join the program
        </button>
      </div>
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
  const botName = process.env.NEXT_PUBLIC_BOT_NAME ?? "ClipClapBot";
  const webLink = `${base}/?ref=${data.code}`;
  const tgLink = `https://t.me/${botName}?start=ref_${data.code}`;

  return (
    <div className="p-8 max-w-3xl text-[#EDEDED] space-y-8">
      <h1 className="text-2xl font-semibold">Affiliate Program</h1>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Your links</h2>
        <CopyRow label="Web" value={webLink} />
        <CopyRow label="Telegram" value={tgLink} />
      </section>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Pending" value={data.balance.pendingUsd} />
        <Stat label="Available" value={data.balance.availableUsd} />
        <Stat label="In payout" value={data.balance.payoutPendingUsd} />
        <Stat label="Paid" value={data.balance.paidUsd} />
      </section>
      <p className="text-sm text-neutral-400">
        Next payout: 1st / 15th · Minimum payout: $50
      </p>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Payout destination</h2>
        {!data.payoutDestination && (
          <p className="text-sm text-yellow-500">
            Not set — set payout details to receive payments.
          </p>
        )}
        <div className="flex gap-2">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="rounded bg-neutral-900 px-3 py-2"
          >
            <option value="USDT_TRC20">USDT (TRC20)</option>
            <option value="PAYPAL">PayPal</option>
            <option value="BANK">Bank</option>
          </select>
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder={data.payoutDestination ?? "destination"}
            className="flex-1 rounded bg-neutral-900 px-3 py-2"
          />
          <button onClick={saveDestination} className="rounded bg-white px-4 py-2 text-black">
            Save
          </button>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Referrals</h2>
        <table className="w-full text-sm">
          <thead className="text-neutral-400">
            <tr>
              <th className="text-left">User</th>
              <th className="text-left">Signup</th>
              <th className="text-left">Plan</th>
              <th className="text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.referrals.map((r) => (
              <tr key={r.id}>
                <td>{r.id.slice(0, 6)}…</td>
                <td>{new Date(r.createdAt).toISOString().slice(0, 10)}</td>
                <td>{r.plan}</td>
                <td>{r.subscriptionStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-neutral-800 p-3">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="text-xl font-semibold">${value.toFixed(2)}</div>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-sm text-neutral-400">{label}</span>
      <code className="flex-1 rounded bg-neutral-900 px-3 py-2 text-sm">{value}</code>
      <button
        onClick={() => navigator.clipboard.writeText(value)}
        className="rounded border border-neutral-700 px-3 py-2 text-sm"
      >
        Copy
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck web**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS. (If `@/lib/auth` path alias differs, match the import style used by sibling API routes under `apps/web/app/api`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/middleware.ts apps/web/lib/auth.ts "apps/web/app/(dashboard)/dashboard/referrals/page.tsx"
git commit -m "feat(referral): web attribution cookie, attach-on-signup, and dashboard page"
```

---

## Task 10: Bot — `ref_` deep-link + `/referral` `/balance` `/payout`

**Files:**
- Modify: `apps/bot/src/handlers.ts`
- Modify: `apps/bot/src/i18n.ts`
- Test: `apps/bot/src/__tests__/parse-start-payload.test.ts`

- [ ] **Step 1: Extend `parseStartPayload` for `ref_` (failing test first).** In `apps/bot/src/__tests__/parse-start-payload.test.ts`, add:

```ts
  it("parses a ref_ payload", () => {
    expect(parseStartPayload("/start ref_ABCD1234")).toEqual({
      kind: "ref",
      code: "ABCD1234",
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/bot/src/__tests__/parse-start-payload.test.ts`
Expected: FAIL (returns `null` for the `ref_` payload).

- [ ] **Step 3: Implement the parser change.** In `apps/bot/src/handlers.ts`, update the `StartPayload` type and `parseStartPayload`:

```ts
type StartPayload =
  | { kind: "link"; code: string }
  | { kind: "ref"; code: string }
  | null;

export function parseStartPayload(text: string): StartPayload {
  const trimmed = text.replace(/^\/start(@\S+)?\s*/, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("link_")) {
    const code = trimmed.slice("link_".length).trim();
    if (code) return { kind: "link", code };
  }
  if (trimmed.startsWith("ref_")) {
    const code = trimmed.slice("ref_".length).trim();
    if (code) return { kind: "ref", code };
  }
  return null;
}
```

- [ ] **Step 4: Handle the `ref` deep-link in `handleStart`.** In `handleStart`, after the `if (payload?.kind === "link")` block, add:

```ts
  if (payload?.kind === "ref") {
    const from = message.from!;
    const isNew = !existing;
    const user = await resolveTelegramUser(from);
    if (isNew) {
      const { referralService } = await import("@clipclap/shared");
      await referralService.attachReferral(user.id, payload.code);
    }
    // fall through to the normal welcome flow below
  }
```

> Only attach for brand-new accounts (`existing` was null before `resolveTelegramUser` created the row), preserving the one-time lock. `attachReferral` itself also guards against overwrite, so this is belt-and-suspenders.

- [ ] **Step 5: Add referral string keys to i18n.** In `apps/bot/src/i18n.ts`, add to BOTH the `en` and `ru` dictionaries (use the existing dict shape; functions where values are interpolated):

```ts
  // en
  referralInfo: (web: string, tg: string, available: string, pending: string, paid: string) =>
    `Your referral links:\nWeb: ${web}\nTelegram: ${tg}\n\nBalance:\nPending: $${pending}\nAvailable: $${available}\nPaid: $${paid}\n\nNext payout: 1st / 15th\nMinimum payout: $50`,
  referralNoCode: "Open the affiliate program on the website to get your link first.",
  balanceInfo: (available: string, pending: string, paid: string) =>
    `Balance:\nPending: $${pending}\nAvailable: $${available}\nPaid: $${paid}\nNext payout: 1st / 15th`,
  payoutPrompt: "Send your payout details as:\n/payout USDT_TRC20 <address>\nor /payout PAYPAL <email>",
  payoutSaved: "Payout destination saved.",
  payoutInvalid: (err: string) => `Could not save: ${err}`,
```

```ts
  // ru
  referralInfo: (web: string, tg: string, available: string, pending: string, paid: string) =>
    `Ваши реферальные ссылки:\nСайт: ${web}\nTelegram: ${tg}\n\nБаланс:\nВ ожидании: $${pending}\nДоступно: $${available}\nВыплачено: $${paid}\n\nБлижайшая выплата: 1 / 15 числа\nМинимум на вывод: $50`,
  referralNoCode: "Сначала откройте партнёрскую программу на сайте, чтобы получить ссылку.",
  balanceInfo: (available: string, pending: string, paid: string) =>
    `Баланс:\nВ ожидании: $${pending}\nДоступно: $${available}\nВыплачено: $${paid}\nБлижайшая выплата: 1 / 15 числа`,
  payoutPrompt: "Отправьте реквизиты так:\n/payout USDT_TRC20 <адрес>\nили /payout PAYPAL <email>",
  payoutSaved: "Реквизиты для выплаты сохранены.",
  payoutInvalid: (err: string) => `Не удалось сохранить: ${err}`,
```

- [ ] **Step 6: Route the new commands in `handleUpdate`.** In `apps/bot/src/handlers.ts`, inside `handleUpdate` after the `/menu` branch and before the `menuAction` block, add:

```ts
  if (text === "/referral" || text.startsWith("/referral ") || text.startsWith("/referral@")) {
    await handleReferral(client, message, from, dict, config);
    return;
  }
  if (text === "/balance" || text.startsWith("/balance@")) {
    await handleBalance(client, message, from, dict);
    return;
  }
  if (text === "/payout" || text.startsWith("/payout ")) {
    await handlePayout(client, message, from, text, dict);
    return;
  }
```

- [ ] **Step 7: Implement the handlers.** Append to `apps/bot/src/handlers.ts`:

```ts
async function handleReferral(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  dict: Dict,
  config: BotRuntimeConfig
) {
  const user = await resolveTelegramUser(from);
  const { referralService } = await import("@clipclap/shared");
  const code = await referralService.ensureReferralCode(user.id);
  const balance = await referralService.getReferralBalance(user.id);
  const botName = process.env.TELEGRAM_BOT_USERNAME ?? "ClipClapBot";
  const web = `${config.appUrl}/?ref=${code}`;
  const tg = `https://t.me/${botName}?start=ref_${code}`;
  await client.sendMessage(
    message.chat.id,
    dict.referralInfo(
      web,
      tg,
      balance.availableUsd.toFixed(2),
      balance.pendingUsd.toFixed(2),
      balance.paidUsd.toFixed(2)
    )
  );
}

async function handleBalance(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  dict: Dict
) {
  const user = await resolveTelegramUser(from);
  const { referralService } = await import("@clipclap/shared");
  const b = await referralService.getReferralBalance(user.id);
  await client.sendMessage(
    message.chat.id,
    dict.balanceInfo(b.availableUsd.toFixed(2), b.pendingUsd.toFixed(2), b.paidUsd.toFixed(2))
  );
}

async function handlePayout(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  text: string,
  dict: Dict
) {
  const parts = text.trim().split(/\s+/).slice(1); // drop "/payout"
  if (parts.length < 2) {
    await client.sendMessage(message.chat.id, dict.payoutPrompt);
    return;
  }
  const [method, ...rest] = parts;
  const destination = rest.join(" ");
  const user = await resolveTelegramUser(from);
  const { referralService } = await import("@clipclap/shared");
  const result = await referralService.setPayoutDestination(user.id, method, destination);
  await client.sendMessage(
    message.chat.id,
    result.ok ? dict.payoutSaved : dict.payoutInvalid(result.error ?? "invalid")
  );
}
```

- [ ] **Step 8: Run the bot tests**

Run: `npx vitest run apps/bot/src`
Expected: PASS (including the new `ref_` parse test).

- [ ] **Step 9: Typecheck bot**

Run: `npx tsc -p apps/bot/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/i18n.ts apps/bot/src/__tests__/parse-start-payload.test.ts
git commit -m "feat(referral): bot ref deep-link and /referral /balance /payout commands"
```

---

## Task 11: Bot — admin CRM commands

**Files:**
- Modify: `apps/bot/src/handlers.ts`
- Test: `apps/bot/src/__tests__/referral-admin.test.ts` (create)

- [ ] **Step 1: Add an admin-allowlist helper test.** Create `apps/bot/src/__tests__/referral-admin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isReferralAdmin } from "../handlers";

describe("isReferralAdmin", () => {
  it("matches an id in the allowlist", () => {
    expect(isReferralAdmin("111", "111,222")).toBe(true);
  });
  it("rejects an id not in the allowlist", () => {
    expect(isReferralAdmin("333", "111,222")).toBe(false);
  });
  it("rejects when allowlist is empty", () => {
    expect(isReferralAdmin("111", undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/bot/src/__tests__/referral-admin.test.ts`
Expected: FAIL ("isReferralAdmin is not exported").

- [ ] **Step 3: Implement the helper + admin routing.** In `apps/bot/src/handlers.ts`, add the exported helper near the top (after the CALLBACK constants):

```ts
export function isReferralAdmin(
  telegramId: string,
  allowlist: string | undefined
): boolean {
  if (!allowlist) return false;
  return allowlist
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(telegramId);
}
```

In `handleUpdate`, after the `/payout` branch, add admin routing:

```ts
  if (text.startsWith("/payouts") || text.startsWith("/ref ") ||
      text.startsWith("/refban ") || text.startsWith("/refvoid ")) {
    if (isReferralAdmin(String(from.id), process.env.REFERRAL_ADMIN_TELEGRAM_IDS)) {
      await handleAdminCommand(client, message, text);
      return;
    }
    // non-admins fall through to the default hint
  }
```

- [ ] **Step 4: Implement `handleAdminCommand`.** Append to `apps/bot/src/handlers.ts`:

```ts
async function handleAdminCommand(
  client: TelegramClient,
  message: TelegramMessage,
  text: string
) {
  const { referralService } = await import("@clipclap/shared");
  const chatId = message.chat.id;
  const adminId = String(message.from!.id);

  if (text.startsWith("/payouts")) {
    const payouts = await referralService.listPendingPayouts();
    if (payouts.length === 0) {
      await client.sendMessage(chatId, "No pending payouts.");
      return;
    }
    const lines = payouts.map(
      (p) =>
        `${p.id}\n  ${p.status} $${p.amountUsd.toFixed(2)} → ${p.destination} (${p._count.commissions} commissions)`
    );
    await client.sendMessage(
      chatId,
      `Pending payouts:\n${lines.join("\n")}\n\n` +
        `Approve: /approve <id> <networkFee>\nPaid: /paid <id> <txRef>\nReject: /reject <id> <reason>`
    );
    return;
  }

  if (text.startsWith("/ref ")) {
    const key = text.slice("/ref ".length).trim();
    const card = await referralService.getReferrerCard(key);
    if (!card) {
      await client.sendMessage(chatId, "Referrer not found.");
      return;
    }
    await client.sendMessage(
      chatId,
      `Referrer ${card.user.id} (${card.user.referralCode ?? "no code"})\n` +
        `Referred: ${card.user._count.referrals}\n` +
        `Pending $${card.balance.pendingUsd.toFixed(2)} · ` +
        `Available $${card.balance.availableUsd.toFixed(2)} · ` +
        `In payout $${card.balance.payoutPendingUsd.toFixed(2)} · ` +
        `Paid $${card.balance.paidUsd.toFixed(2)}\n` +
        `Voided: ${card.refundCount}\n` +
        `Status: ${card.user.referralBannedAt ? "BANNED" : "active"}`
    );
    return;
  }

  if (text.startsWith("/refban ")) {
    const userId = text.slice("/refban ".length).trim();
    await referralService.banReferrer(userId);
    await client.sendMessage(chatId, `Banned ${userId} from future accrual.`);
    return;
  }

  if (text.startsWith("/refvoid ")) {
    const rest = text.slice("/refvoid ".length).trim();
    const [userId, ...reasonParts] = rest.split(/\s+/);
    const reason = reasonParts.join(" ");
    if (!userId || !reason) {
      await client.sendMessage(chatId, "Usage: /refvoid <userId> <reason>");
      return;
    }
    const { voided } = await referralService.voidReferrerCommissions(userId, reason);
    await client.sendMessage(chatId, `Voided ${voided} commissions for ${userId}.`);
    return;
  }
}
```

- [ ] **Step 5: Route the approve/paid/reject sub-commands.** In `handleUpdate`, add alongside the other admin branch (these are admin-only too):

```ts
  if (text.startsWith("/approve ") || text.startsWith("/paid ") || text.startsWith("/reject ")) {
    if (isReferralAdmin(String(from.id), process.env.REFERRAL_ADMIN_TELEGRAM_IDS)) {
      await handleAdminPayoutAction(client, message, text);
      return;
    }
  }
```

Append the handler:

```ts
async function handleAdminPayoutAction(
  client: TelegramClient,
  message: TelegramMessage,
  text: string
) {
  const { referralService } = await import("@clipclap/shared");
  const chatId = message.chat.id;
  const adminId = String(message.from!.id);
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];
  const id = parts[1];

  if (cmd === "/approve") {
    const fee = Number(parts[2] ?? "0");
    await referralService.approvePayout(id, adminId, Number.isFinite(fee) ? fee : 0);
    await client.sendMessage(chatId, `Approved ${id} (fee $${fee}).`);
    return;
  }
  if (cmd === "/paid") {
    const txRef = parts.slice(2).join(" ");
    await referralService.markPayoutPaid(id, txRef);
    await client.sendMessage(chatId, `Marked ${id} paid (tx ${txRef}).`);
    return;
  }
  if (cmd === "/reject") {
    const reason = parts.slice(2).join(" ");
    await referralService.rejectPayout(id, reason || "rejected");
    await client.sendMessage(chatId, `Rejected ${id}.`);
    return;
  }
}
```

- [ ] **Step 6: Run the bot tests**

Run: `npx vitest run apps/bot/src`
Expected: PASS.

- [ ] **Step 7: Typecheck bot**

Run: `npx tsc -p apps/bot/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/__tests__/referral-admin.test.ts
git commit -m "feat(referral): telegram admin CRM commands for payouts and moderation"
```

---

## Task 12: Env docs + final full test pass

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document new env vars.** Add to `.env.example`:

```bash
# Referral program
REFERRAL_ADMIN_TELEGRAM_IDS=   # comma-separated admin telegram IDs
TELEGRAM_BOT_USERNAME=ClipClapBot
NEXT_PUBLIC_APP_URL=https://clipclap.io
NEXT_PUBLIC_BOT_NAME=ClipClapBot
```

- [ ] **Step 2: Run the entire test suite**

Run: `npx vitest run`
Expected: PASS (all packages).

- [ ] **Step 3: Typecheck everything**

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit && npx tsc -p apps/web/tsconfig.json --noEmit && npx tsc -p apps/bot/tsconfig.json --noEmit && npx tsc -p apps/worker/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(referral): document referral env vars"
```

---

## Self-Review Notes (spec coverage)

- **30% lifetime, net base, config-driven rate** → Task 2 (`REFERRAL_CONFIG.rateBps`), Task 4 (`recordCommission` net math).
- **Ledger model, derived balance** → Task 1 (`ReferralCommission`), Task 8 (`getReferralBalance` aggregate).
- **`@@unique([source, externalPaymentId])` / duplicate-webhook protection** → Task 1, Task 4 (`P2002` → `duplicate`).
- **Attribution: last-touch 30d cookie (web) + `ref_` deep-link (bot), one-time lock, self-referral block** → Task 9 (middleware + `createUser`), Task 10 (deep-link), Task 3 (`attachReferral`).
- **Hold 14d release** → Task 6 (`releaseMaturedCommissions`), Task 7 (hourly schedule).
- **Payout batch 1st/15th, $50 min, destination required, PAYOUT_PENDING lock in a transaction** → Task 6 (`runPayoutBatch`), Task 7 (daily schedule + day check).
- **Clawback (Stripe refund/dispute; void non-paid only; no auto-clawback after PAID)** → Task 5, Task 4 (`voidCommission` status filter excludes `PAID`).
- **Telegram CRM: /payouts, approve, mark-paid, reject, /ref, /refban, /refvoid <reason>** → Task 11; Approve and Mark-as-paid are separate (`approvePayout` vs `markPayoutPaid`).
- **Payout destination validation per method + terms gate with version** → Task 8 (`validatePayoutDestination`, `acceptReferralTerms`), Task 9 (terms gate UI).
- **Referrer UI web + bot** → Task 9 (page), Task 10 (`/referral` `/balance` `/payout`).
- **Tests mirroring tribute.service.test.ts** → Tasks 3, 4, 6, 8, 10, 11.

**Open verification items flagged for the implementer (not blockers):** Tribute `amount` minor/major units (Task 5 Step 3 note); which worker role is single-instance for hosting the scheduler (Task 7 Step 4 note); `@/lib/auth` path alias vs sibling routes (Task 8/9).

**Known deferred (spec coverage gap — track as follow-up):** Referrer-facing payout notifications (spec §6.2 step 5 "Payout of $X created, processing" and §6.4 gross/fee/net breakdown on mark-as-paid) are NOT wired in this plan. They require extending `telegram-notification.service.ts` with new `kind`s and emitting from `runPayoutBatch` / `markPayoutPaid`. Recommended as a small Task 13 before launch; the program is functional without it (admin sees status in the CRM), but referrers won't get a push when a payout is created/paid.
