# ClipClap Payouts / Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the referral-specific payout machinery with a single source-agnostic Wallet/Payouts layer: an immutable money ledger (`WalletEntry`), on-demand crypto `WithdrawalRequest`s with manual admin approval, and a `/dashboard/payouts` page — while the referral program keeps only accrual/hold/clawback and posts credits to the wallet.

**Architecture:** New `wallet.service` (derived balances + idempotent ledger writes) and `withdrawal.service` (create in a Serializable transaction + admin lifecycle) in `packages/shared/src/services`. Referral hold-release posts `WalletEntry` CREDITs; referral clawback posts compensating DEBITs. The old `ReferralPayout` model, `runPayoutBatch`, the 1st/15th BullMQ job, `User.payoutMethod/payoutDestination`, the bot `/payout` command, and the referral payout CRM are removed. The Telegram admin CRM is generalized to `WithdrawalRequest`.

**Tech Stack:** TypeScript, Next.js 15 (App Router), Prisma + PostgreSQL, BullMQ + Redis, Auth.js v5, Vitest. Monorepo (`@clipfast/shared`). Continues on branch `feat/referral-program`.

---

## Conventions & environment (read once)

- **Branch:** stay on `feat/referral-program`.
- **Tests / typecheck run on the HOST:** `npx vitest run <path>`; `npx tsc -p <project>/tsconfig.json --noEmit`. Prisma is **mocked** in unit tests (no DB).
- **Prisma migrations run INSIDE a container** (host can't resolve the `postgres` docker host). Pattern used for the referral schema:
  1. Edit `prisma/schema.prisma` on the host.
  2. Hand-write the migration SQL under `prisma/migrations/<timestamp>_<name>/migration.sql` (the container exec has no interactive TTY for `migrate dev`).
  3. Apply: `docker compose exec -T web npx prisma migrate deploy --schema /app/prisma/schema.prisma`.
  4. Regenerate the client on the HOST: `npx prisma generate` (host typecheck/tests use it).
  5. Regenerate the client INSIDE each app container that runs the new code + restart it: `docker compose exec -T <svc> npx prisma generate --schema /app/prisma/schema.prisma && docker compose restart <svc>` (web, bot, worker-finalize). Each container has its own baked client.
- **Web/bot/worker typecheck needs shared `dist` rebuilt first:** `npx tsc -p packages/shared/tsconfig.json` (emit) then the app typecheck. `dist/` is gitignored.
- **Commits:** `git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "<msg>"`. Conventional Commits.
- **Punctuation:** plain hyphens only, never em/en-dashes (project rule).
- **Money math:** USD `Float` (MVP; cents migration is documented tech-debt). Round with `Math.round(x * 100) / 100`.
- **Admin allowlist:** reuse the existing `REFERRAL_ADMIN_TELEGRAM_IDS` env (no new var) and the existing `isReferralAdmin` helper in the bot.

---

## File Structure

**Create:**
- `packages/shared/src/config/wallet.ts` — `WALLET_CONFIG` (min, methods+regex, retry count) + helpers.
- `packages/shared/src/services/wallet.service.ts` — balances + `postWalletEntry` (idempotent ledger write).
- `packages/shared/src/services/withdrawal.service.ts` — create/approve/markPaid/reject + queries + destination validation.
- `packages/shared/src/services/__tests__/wallet.service.test.ts`
- `packages/shared/src/services/__tests__/withdrawal.service.test.ts`
- `apps/web/app/(dashboard)/dashboard/payouts/page.tsx`
- `apps/web/app/api/payouts/route.ts` — GET wallet summary.
- `apps/web/app/api/payouts/withdraw/route.ts` — POST create withdrawal.
- `apps/web/components/payouts/withdraw-form.tsx` — client island (chip grid + form).

**Modify:**
- `prisma/schema.prisma` — add wallet models; simplify `ReferralCommission`; drop `ReferralPayout`/`PayoutStatus`/`User.payout*`.
- `packages/shared/src/config/index.ts`, `packages/shared/src/services/index.ts` — barrels.
- `packages/shared/src/services/referral.service.ts` — integrate wallet; delete payout fns.
- `packages/shared/src/services/__tests__/referral.service.test.ts` — update for new behavior.
- `packages/shared/src/lib/referral-queue.ts` — drop payout-batch repeatable.
- `apps/worker/src/referral-scheduler.ts` — drop payout-batch branch.
- `apps/bot/src/handlers.ts`, `apps/bot/src/i18n.ts`, bot tests — `/balance`, remove `/payout`, admin CRM → withdrawals, `/referral`.
- `apps/web/components/sidebar.tsx` — add Payouts nav item.
- `apps/web/app/(dashboard)/dashboard/referrals/page.tsx` — remove payout block, referral-only earnings, CTA.
- `apps/web/app/api/referrals/route.ts` — referral stats instead of balance.

**Delete:**
- `apps/web/app/api/referrals/payout-destination/route.ts`
- `apps/web/components/referrals/payout-form.tsx`

---

## Task 1: Prisma schema + migration

**Files:** Modify `prisma/schema.prisma`.

- [ ] **Step 1: Add wallet enums + models.** Add after the existing referral enums:

```prisma
enum WalletEntryKind { CREDIT  DEBIT }
enum WalletSource    { REFERRAL  AD_PARTNERSHIP  ADJUSTMENT  WITHDRAWAL }
enum WithdrawalStatus { PENDING  APPROVED  PAID  REJECTED }

model WalletEntry {
  id        String          @id @default(cuid())
  userId    String
  user      User            @relation(fields: [userId], references: [id], onDelete: Restrict)
  kind      WalletEntryKind
  source    WalletSource
  amountUsd Float
  refType   String
  refId     String
  memo      String?
  createdAt DateTime        @default(now())

  @@unique([source, refType, refId])
  @@index([userId, createdAt])
  @@index([userId, source])
  @@map("wallet_entries")
}

model WithdrawalRequest {
  id                    String           @id @default(cuid())
  userId                String
  user                  User             @relation(fields: [userId], references: [id], onDelete: Restrict)
  amountUsd             Float
  method                String
  destination           String
  requestedAvailableUsd Float
  networkFeeUsd         Float            @default(0)
  netAmountUsd          Float?
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
  @@map("withdrawal_requests")
}
```

- [ ] **Step 2: Simplify `CommissionStatus`.** Change the enum to drop `PAYOUT_PENDING` and `PAID`:

```prisma
enum CommissionStatus {
  PENDING
  AVAILABLE
  VOIDED
}
```

- [ ] **Step 3: Drop `ReferralPayout` + `PayoutStatus`.** Remove the entire `model ReferralPayout { ... }` block and the `enum PayoutStatus { ... }` block. In `model ReferralCommission`, remove the `payoutId`/`payout` fields and the `payout ReferralPayout?` relation. In `model User`, remove the `payouts ReferralPayout[]` relation, the `payoutDestination` and `payoutMethod` scalar fields.

- [ ] **Step 4: Add wallet relations to `User`.** In `model User`, add alongside the other relations:

```prisma
  walletEntries      WalletEntry[]
  withdrawalRequests WithdrawalRequest[]
```

- [ ] **Step 5: Hand-write the migration.** Create `prisma/migrations/20260530000000_payouts_wallet/migration.sql`:

```sql
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
```

- [ ] **Step 6: Apply + regenerate.**
Run: `docker compose exec -T web npx prisma migrate deploy --schema /app/prisma/schema.prisma`
Expected: "All migrations have been successfully applied."
Then: `npx prisma generate` (host).
Then verify in-sync: `docker compose exec -T web npx prisma migrate status --schema /app/prisma/schema.prisma` → "up to date".

- [ ] **Step 7: Typecheck shared.** Note: `referral.service.ts` will now have type errors (it references removed models/statuses) — that is expected and fixed in Task 5. To verify the SCHEMA/migration alone, run `npx prisma validate` (expect valid) and confirm `migrate status` is clean. Do NOT expect `tsc` to pass yet.

- [ ] **Step 8: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(payouts): wallet schema, simplify commission status, drop ReferralPayout"
```

---

## Task 2: Wallet config

**Files:** Create `packages/shared/src/config/wallet.ts`; modify `packages/shared/src/config/index.ts`.

- [ ] **Step 1: Write the config.** Create `packages/shared/src/config/wallet.ts`:

```ts
export interface WalletMethod {
  value: string;
  label: string;
  /** Address validation for this crypto network. */
  validate: RegExp;
}

export const WALLET_CONFIG = {
  minWithdrawalUsd: 50,
  /** Serializable transaction retry attempts on serialization failure. */
  serializableRetries: 2,
  methods: [
    { value: "USDT_TRC20", label: "USDT (TRC20)", validate: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
    { value: "USDT_ERC20", label: "USDT (ERC20)", validate: /^0x[a-fA-F0-9]{40}$/ },
    { value: "BTC",        label: "Bitcoin",      validate: /^(bc1[a-z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
    { value: "ETH",        label: "Ethereum",     validate: /^0x[a-fA-F0-9]{40}$/ },
    { value: "USDC",       label: "USDC (ERC20)", validate: /^0x[a-fA-F0-9]{40}$/ },
  ] as WalletMethod[],
} as const;

export function findWalletMethod(value: string): WalletMethod | undefined {
  return WALLET_CONFIG.methods.find((m) => m.value === value);
}
```

- [ ] **Step 2: Export from the config barrel.** Add to `packages/shared/src/config/index.ts`:

```ts
export { WALLET_CONFIG, findWalletMethod } from "./wallet";
export type { WalletMethod } from "./wallet";
```

- [ ] **Step 3: Typecheck.** `npx tsc -p packages/shared/tsconfig.json --noEmit` — note it will still fail in `referral.service.ts` (Task 5). Confirm there are NO errors in `config/wallet.ts` specifically (grep the output for `config/wallet`).

- [ ] **Step 4: Commit.**
```bash
git add packages/shared/src/config
git commit -m "feat(payouts): add wallet config (min, crypto methods, retries)"
```

---

## Task 3: `wallet.service` — balances + idempotent ledger writes (TDD)

**Files:** Create `packages/shared/src/services/wallet.service.ts` + `__tests__/wallet.service.test.ts`; modify services barrel.

- [ ] **Step 1: Write failing tests.** Create `packages/shared/src/services/__tests__/wallet.service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entryAggregate: vi.fn(),
  entryGroupBy: vi.fn(),
  entryCreate: vi.fn(),
  withdrawalAggregate: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    walletEntry: {
      aggregate: mocks.entryAggregate,
      groupBy: mocks.entryGroupBy,
      create: mocks.entryCreate,
    },
    withdrawalRequest: { aggregate: mocks.withdrawalAggregate },
  },
}));

import { getWalletBalance, postWalletEntry } from "../wallet.service";

beforeEach(() => vi.clearAllMocks());

describe("getWalletBalance", () => {
  it("computes ledger, locked, available, paidOut", async () => {
    // credits 120, debits 20 (of which withdrawals 20)
    mocks.entryAggregate
      .mockResolvedValueOnce({ _sum: { amountUsd: 120 } }) // CREDIT
      .mockResolvedValueOnce({ _sum: { amountUsd: 20 } })  // DEBIT
      .mockResolvedValueOnce({ _sum: { amountUsd: 20 } }); // WITHDRAWAL paidOut
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 30 } }); // locked

    const b = await getWalletBalance("u1");
    expect(b.ledgerBalanceUsd).toBe(100);
    expect(b.lockedUsd).toBe(30);
    expect(b.availableUsd).toBe(70);
    expect(b.paidOutUsd).toBe(20);
  });

  it("defaults missing sums to 0", async () => {
    mocks.entryAggregate.mockResolvedValue({ _sum: { amountUsd: null } });
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: null } });
    const b = await getWalletBalance("u1");
    expect(b).toEqual({ ledgerBalanceUsd: 0, lockedUsd: 0, availableUsd: 0, paidOutUsd: 0 });
  });
});

describe("postWalletEntry", () => {
  it("creates an entry via the given client", async () => {
    mocks.entryCreate.mockResolvedValue({ id: "w1" });
    await postWalletEntry(undefined, {
      userId: "u1", kind: "CREDIT", source: "REFERRAL",
      refType: "referral_commission", refId: "c1", amountUsd: 5,
    });
    expect(mocks.entryCreate).toHaveBeenCalledWith({
      data: {
        userId: "u1", kind: "CREDIT", source: "REFERRAL",
        refType: "referral_commission", refId: "c1", amountUsd: 5, memo: undefined,
      },
    });
  });

  it("is idempotent on P2002 (duplicate)", async () => {
    mocks.entryCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(
      postWalletEntry(undefined, {
        userId: "u1", kind: "CREDIT", source: "REFERRAL",
        refType: "referral_commission", refId: "c1", amountUsd: 5,
      })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module '../wallet.service'`).
Run: `npx vitest run packages/shared/src/services/__tests__/wallet.service.test.ts`

- [ ] **Step 3: Implement.** Create `packages/shared/src/services/wallet.service.ts`:

```ts
import { prisma } from "../lib/prisma";
import type { Prisma, PrismaClient, WalletEntryKind, WalletSource } from "@prisma/client";

/** Prisma client or an interactive-transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface WalletBalance {
  ledgerBalanceUsd: number;
  lockedUsd: number;
  availableUsd: number;
  paidOutUsd: number;
}

export async function getWalletBalance(userId: string): Promise<WalletBalance> {
  const [credit, debit, withdrawn, locked] = await Promise.all([
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "CREDIT" } }),
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "DEBIT" } }),
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, source: "WITHDRAWAL" } }),
    prisma.withdrawalRequest.aggregate({
      _sum: { amountUsd: true },
      where: { userId, status: { in: ["PENDING", "APPROVED"] } },
    }),
  ]);
  const ledgerBalanceUsd = round2((credit._sum.amountUsd ?? 0) - (debit._sum.amountUsd ?? 0));
  const lockedUsd = round2(locked._sum.amountUsd ?? 0);
  return {
    ledgerBalanceUsd,
    lockedUsd,
    availableUsd: round2(ledgerBalanceUsd - lockedUsd),
    paidOutUsd: round2(withdrawn._sum.amountUsd ?? 0),
  };
}

/** Credits earned per source (CREDIT only). Missing sources -> 0. */
export async function getEarningsBySource(userId: string): Promise<Record<string, number>> {
  const groups = await prisma.walletEntry.groupBy({
    by: ["source"],
    where: { userId, kind: "CREDIT" },
    _sum: { amountUsd: true },
  });
  const out: Record<string, number> = {};
  for (const g of groups) out[g.source] = round2(g._sum.amountUsd ?? 0);
  return out;
}

export interface PostWalletEntryInput {
  userId: string;
  kind: WalletEntryKind;
  source: WalletSource;
  refType: string;
  refId: string;
  amountUsd: number;
  memo?: string;
}

/**
 * Append a money-ledger row. Idempotent on the (source, refType, refId) unique
 * key: a duplicate (P2002) is a no-op. Pass a transaction client when posting
 * inside a larger transaction (referral release / withdrawal payment).
 */
export async function postWalletEntry(client: Db | undefined, input: PostWalletEntryInput): Promise<void> {
  const db = client ?? prisma;
  try {
    await db.walletEntry.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        source: input.source,
        refType: input.refType,
        refId: input.refId,
        amountUsd: input.amountUsd,
        memo: input.memo,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return; // already posted
    throw err;
  }
}
```

- [ ] **Step 4: Run — expect PASS** (4 tests).
Run: `npx vitest run packages/shared/src/services/__tests__/wallet.service.test.ts`

- [ ] **Step 5: Export from services barrel.** Add to `packages/shared/src/services/index.ts`:

```ts
export * as walletService from "./wallet.service";
export * from "./wallet.service";
```

- [ ] **Step 6: Commit.**
```bash
git add packages/shared/src/services/wallet.service.ts packages/shared/src/services/__tests__/wallet.service.test.ts packages/shared/src/services/index.ts
git commit -m "feat(payouts): wallet.service balances and idempotent ledger writes"
```

---

## Task 4: `withdrawal.service` — create / approve / markPaid / reject (TDD)

**Files:** Create `packages/shared/src/services/withdrawal.service.ts` + `__tests__/withdrawal.service.test.ts`; modify services barrel.

- [ ] **Step 1: Write failing tests.** Create `packages/shared/src/services/__tests__/withdrawal.service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  txFn: vi.fn(),
  wrFindFirst: vi.fn(),
  wrCreate: vi.fn(),
  wrFindUnique: vi.fn(),
  wrUpdateMany: vi.fn(),
  entryCreate: vi.fn(),
  entryAggregate: vi.fn(),
  withdrawalAggregate: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $transaction: mocks.txFn,
    withdrawalRequest: {
      findFirst: mocks.wrFindFirst,
      create: mocks.wrCreate,
      findUnique: mocks.wrFindUnique,
      updateMany: mocks.wrUpdateMany,
      aggregate: mocks.withdrawalAggregate,
    },
    walletEntry: { create: mocks.entryCreate, aggregate: mocks.entryAggregate },
  },
}));

import {
  validateWithdrawalDestination,
  createWithdrawal,
  approveWithdrawal,
} from "../withdrawal.service";

beforeEach(() => vi.clearAllMocks());

describe("validateWithdrawalDestination", () => {
  it("accepts a TRON address for USDT_TRC20", () => {
    expect(validateWithdrawalDestination("USDT_TRC20", "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X").ok).toBe(true);
  });
  it("rejects an EVM address for USDT_TRC20", () => {
    expect(validateWithdrawalDestination("USDT_TRC20", "0xabc").ok).toBe(false);
  });
  it("rejects an unknown method", () => {
    expect(validateWithdrawalDestination("DOGE", "x").ok).toBe(false);
  });
});

describe("createWithdrawal", () => {
  // Make $transaction just run the callback with a tx client exposing the mocks.
  function wireTx() {
    mocks.txFn.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        walletEntry: { aggregate: mocks.entryAggregate },
        withdrawalRequest: {
          aggregate: mocks.withdrawalAggregate,
          findFirst: mocks.wrFindFirst,
          create: mocks.wrCreate,
        },
      })
    );
  }

  it("creates a PENDING request when available covers the amount", async () => {
    wireTx();
    mocks.entryAggregate
      .mockResolvedValueOnce({ _sum: { amountUsd: 100 } }) // credit
      .mockResolvedValueOnce({ _sum: { amountUsd: 0 } });  // debit
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 0 } }); // locked
    mocks.wrFindFirst.mockResolvedValue(null); // no active request
    mocks.wrCreate.mockResolvedValue({ id: "wr1" });

    const r = await createWithdrawal("u1", {
      method: "USDT_TRC20", destination: "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X", amountUsd: 60,
    });
    expect(r.status).toBe("created");
    const data = mocks.wrCreate.mock.calls[0][0].data;
    expect(data.status).toBe("PENDING");
    expect(data.requestedAvailableUsd).toBe(100);
    expect(data.netAmountUsd).toBe(60);
  });

  it("rejects below minimum", async () => {
    wireTx();
    mocks.entryAggregate.mockResolvedValue({ _sum: { amountUsd: 100 } });
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 0 } });
    mocks.wrFindFirst.mockResolvedValue(null);
    const r = await createWithdrawal("u1", {
      method: "USDT_TRC20", destination: "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X", amountUsd: 10,
    });
    expect(r.status).toBe("error");
    expect(mocks.wrCreate).not.toHaveBeenCalled();
  });

  it("rejects when an active request exists", async () => {
    wireTx();
    mocks.entryAggregate.mockResolvedValue({ _sum: { amountUsd: 100 } });
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 0 } });
    mocks.wrFindFirst.mockResolvedValue({ id: "existing" });
    const r = await createWithdrawal("u1", {
      method: "USDT_TRC20", destination: "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X", amountUsd: 60,
    });
    expect(r.status).toBe("error");
    expect(mocks.wrCreate).not.toHaveBeenCalled();
  });

  it("rejects amount above available", async () => {
    wireTx();
    mocks.entryAggregate
      .mockResolvedValueOnce({ _sum: { amountUsd: 100 } })
      .mockResolvedValueOnce({ _sum: { amountUsd: 0 } });
    mocks.withdrawalAggregate.mockResolvedValue({ _sum: { amountUsd: 80 } }); // locked 80 -> available 20
    mocks.wrFindFirst.mockResolvedValue(null);
    const r = await createWithdrawal("u1", {
      method: "USDT_TRC20", destination: "TJuBGXHbNJXgSJVbEUGjMpfNrY3NW4Mv2X", amountUsd: 60,
    });
    expect(r.status).toBe("error");
  });
});

describe("approveWithdrawal", () => {
  it("rejects a fee >= amount", async () => {
    mocks.wrFindUnique.mockResolvedValue({ id: "wr1", userId: "u1", amountUsd: 50, status: "PENDING" });
    const r = await approveWithdrawal("wr1", "admin1", 60);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
Run: `npx vitest run packages/shared/src/services/__tests__/withdrawal.service.test.ts`

- [ ] **Step 3: Implement.** Create `packages/shared/src/services/withdrawal.service.ts`:

```ts
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { WALLET_CONFIG, findWalletMethod } from "../config/wallet";
import { postWalletEntry } from "./wallet.service";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const ACTIVE = ["PENDING", "APPROVED"] as const;

export function validateWithdrawalDestination(
  method: string,
  destination: string
): { ok: boolean; error?: string } {
  const m = findWalletMethod(method);
  if (!m) return { ok: false, error: "Unsupported method" };
  return m.validate.test(destination.trim())
    ? { ok: true }
    : { ok: false, error: `Invalid ${m.label} address` };
}

export interface CreateWithdrawalInput {
  method: string;
  destination: string;
  amountUsd: number;
}

export type CreateWithdrawalResult =
  | { status: "created"; requestId: string }
  | { status: "error"; error: string };

/** Run fn in a Serializable transaction, retrying on serialization failures. */
async function withSerializableRetry<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= WALLET_CONFIG.serializableRetries; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: "Serializable" });
    } catch (err) {
      // P2034: transaction failed due to a write conflict or deadlock; retry.
      if ((err as { code?: string }).code === "P2034") { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}

async function ledgerBalanceInTx(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const [c, d] = await Promise.all([
    tx.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "CREDIT" } }),
    tx.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "DEBIT" } }),
  ]);
  return round2((c._sum.amountUsd ?? 0) - (d._sum.amountUsd ?? 0));
}

async function lockedInTx(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const l = await tx.withdrawalRequest.aggregate({
    _sum: { amountUsd: true },
    where: { userId, status: { in: [...ACTIVE] } },
  });
  return round2(l._sum.amountUsd ?? 0);
}

export async function createWithdrawal(
  userId: string,
  input: CreateWithdrawalInput
): Promise<CreateWithdrawalResult> {
  const v = validateWithdrawalDestination(input.method, input.destination);
  if (!v.ok) return { status: "error", error: v.error! };
  const amount = round2(input.amountUsd);

  return withSerializableRetry(async (tx) => {
    const ledger = await ledgerBalanceInTx(tx, userId);
    const locked = await lockedInTx(tx, userId);
    const available = round2(ledger - locked);

    if (ledger <= 0 || available <= 0) return { status: "error", error: "No funds available" };
    if (amount < WALLET_CONFIG.minWithdrawalUsd)
      return { status: "error", error: `Minimum withdrawal is $${WALLET_CONFIG.minWithdrawalUsd}` };
    if (amount > available) return { status: "error", error: "Amount exceeds available balance" };

    const active = await tx.withdrawalRequest.findFirst({
      where: { userId, status: { in: [...ACTIVE] } },
      select: { id: true },
    });
    if (active) return { status: "error", error: "You already have a withdrawal in progress" };

    const created = await tx.withdrawalRequest.create({
      data: {
        userId,
        amountUsd: amount,
        method: input.method,
        destination: input.destination.trim(),
        requestedAvailableUsd: available,
        networkFeeUsd: 0,
        netAmountUsd: amount,
        status: "PENDING",
      },
      select: { id: true },
    });
    return { status: "created", requestId: created.id };
  });
}

export async function listPendingWithdrawals() {
  return prisma.withdrawalRequest.findMany({
    where: { status: { in: [...ACTIVE] } },
    orderBy: { createdAt: "asc" },
  });
}

export async function getActiveWithdrawal(userId: string) {
  return prisma.withdrawalRequest.findFirst({
    where: { userId, status: { in: [...ACTIVE] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getWithdrawalHistory(userId: string) {
  return prisma.withdrawalRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function approveWithdrawal(
  id: string,
  adminId: string,
  networkFeeUsd: number
): Promise<{ ok: boolean; error?: string }> {
  const wr = await prisma.withdrawalRequest.findUnique({ where: { id } });
  if (!wr) return { ok: false, error: "Not found" };
  if (wr.status !== "PENDING") return { ok: false, error: `Cannot approve from status ${wr.status}` };
  if (networkFeeUsd < 0 || networkFeeUsd >= wr.amountUsd)
    return { ok: false, error: "Fee must be >= 0 and < amount" };
  const net = round2(wr.amountUsd - networkFeeUsd);
  if (net <= 0) return { ok: false, error: "Net payout must be positive" };

  // Re-check coverage: ledger must still cover all active withdrawals.
  const ledger = await ledgerBalanceInTx(prisma as unknown as Prisma.TransactionClient, wr.userId);
  const locked = await lockedInTx(prisma as unknown as Prisma.TransactionClient, wr.userId);
  if (ledger < locked) {
    return {
      ok: false,
      error:
        `Cannot approve: balance no longer covers this withdrawal after a clawback. ` +
        `Ledger balance: $${ledger} - Locked: $${locked} - Requested: $${wr.amountUsd}`,
    };
  }

  const updated = await prisma.withdrawalRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "APPROVED", approvedBy: adminId, approvedAt: new Date(), networkFeeUsd, netAmountUsd: net },
  });
  if (updated.count === 0) return { ok: false, error: "State changed; retry" };
  return { ok: true };
}

export async function markWithdrawalPaid(id: string, adminId: string, txRef: string): Promise<{ ok: boolean; error?: string }> {
  return prisma.$transaction(async (tx) => {
    const wr = await tx.withdrawalRequest.findUnique({ where: { id } });
    if (!wr) return { ok: false, error: "Not found" };
    if (wr.status !== "APPROVED") return { ok: false, error: `Cannot pay from status ${wr.status}` };
    await tx.withdrawalRequest.update({
      where: { id },
      data: { status: "PAID", paidBy: adminId, paidAt: new Date(), txRef },
    });
    await postWalletEntry(tx, {
      userId: wr.userId, kind: "DEBIT", source: "WITHDRAWAL",
      refType: "withdrawal", refId: wr.id, amountUsd: wr.amountUsd,
    });
    return { ok: true };
  });
}

export async function rejectWithdrawal(id: string, adminId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  if (!reason?.trim()) return { ok: false, error: "Reason required" };
  const updated = await prisma.withdrawalRequest.updateMany({
    where: { id, status: { in: [...ACTIVE] } },
    data: { status: "REJECTED", rejectedBy: adminId, rejectedAt: new Date(), adminNote: reason },
  });
  if (updated.count === 0) return { ok: false, error: "Not in a rejectable state" };
  return { ok: true };
}
```

> Note on the approve coverage re-check: it runs two aggregates on the live `prisma` client (cast to the tx-client type for helper reuse). This is a best-effort guard at MVP; the authoritative double-spend protection is the Serializable create path. Tests mock these aggregates.

- [ ] **Step 4: Run — expect PASS.**
Run: `npx vitest run packages/shared/src/services/__tests__/withdrawal.service.test.ts`

- [ ] **Step 5: Export from services barrel.** Add to `packages/shared/src/services/index.ts`:

```ts
export * as withdrawalService from "./withdrawal.service";
export * from "./withdrawal.service";
```

- [ ] **Step 6: Commit.**
```bash
git add packages/shared/src/services/withdrawal.service.ts packages/shared/src/services/__tests__/withdrawal.service.test.ts packages/shared/src/services/index.ts
git commit -m "feat(payouts): withdrawal.service create/approve/markPaid/reject"
```

---

## Task 5: Referral integration + remove payout machinery (TDD)

**Files:** Modify `packages/shared/src/services/referral.service.ts` + its test; `packages/shared/src/lib/referral-queue.ts`; `apps/worker/src/referral-scheduler.ts`.

- [ ] **Step 1: Delete the payout functions from `referral.service.ts`.** Remove these exports entirely: `PAYOUT_METHODS`, `PayoutMethod` type, `validatePayoutDestination`, `setPayoutDestination`, `getReferralBalance` (+ its `ReferralBalance` interface), `listPendingPayouts`, `approvePayout`, `markPayoutPaid`, `rejectPayout`, `runPayoutBatch`. (Keep `ensureReferralCode`, `attachReferral`, `recordCommission`, `acceptReferralTerms`, `banReferrer`.)

- [ ] **Step 2: Update `NON_PAID_STATUSES`.** It currently includes `PAYOUT_PENDING`. Change to:
```ts
const NON_PAID_STATUSES = ["PENDING", "AVAILABLE"] as const;
```

- [ ] **Step 3: Update the failing tests first.** In `packages/shared/src/services/__tests__/referral.service.test.ts`:
  - Remove the `describe` blocks for `validatePayoutDestination`, `getReferralBalance`, `runPayoutBatch`, `releaseMaturedCommissions` (old form), and the void test's old payout-recompute assertions.
  - Add `walletEntry` to the prisma mock and add these tests:

```ts
// add to vi.hoisted mocks: commissionFindMany: vi.fn(), entryCreate: vi.fn()
// add to prisma mock: referralCommission: { ..., findMany: mocks.commissionFindMany },
//                     walletEntry: { create: mocks.entryCreate }, $transaction: mocks.txFn

import { releaseMaturedCommissions, voidCommission, getReferralStats } from "../referral.service";

describe("releaseMaturedCommissions", () => {
  it("flips matured PENDING commissions to AVAILABLE and posts a wallet CREDIT each", async () => {
    mocks.commissionFindMany.mockResolvedValue([
      { id: "c1", referrerId: "r1", commissionUsd: 5 },
      { id: "c2", referrerId: "r1", commissionUsd: 3 },
    ]);
    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralCommission: { updateMany: mocks.commissionUpdateMany },
        walletEntry: { create: mocks.entryCreate },
      })
    );
    mocks.commissionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.entryCreate.mockResolvedValue({ id: "w" });

    const r = await releaseMaturedCommissions(new Date("2026-06-01T00:00:00Z"));
    expect(r.released).toBe(2);
    expect(mocks.entryCreate).toHaveBeenCalledTimes(2);
    const first = mocks.entryCreate.mock.calls[0][0].data;
    expect(first).toMatchObject({
      userId: "r1", kind: "CREDIT", source: "REFERRAL",
      refType: "referral_commission", refId: "c1", amountUsd: 5,
    });
  });
});

describe("voidCommission", () => {
  it("voids non-paid commissions and posts a clawback DEBIT for already-credited ones", async () => {
    // one commission, currently AVAILABLE (credited)
    mocks.commissionFindMany.mockResolvedValue([
      { id: "c1", referrerId: "r1", commissionUsd: 5, status: "AVAILABLE" },
    ]);
    mocks.txFn.mockImplementation(async (cb) =>
      cb({
        referralCommission: { updateMany: mocks.commissionUpdateMany },
        walletEntry: { create: mocks.entryCreate },
      })
    );
    mocks.commissionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.entryCreate.mockResolvedValue({ id: "w" });

    const r = await voidCommission("STRIPE", "in_1", "refund");
    expect(r.voided).toBe(1);
    const debit = mocks.entryCreate.mock.calls[0][0].data;
    expect(debit).toMatchObject({
      kind: "DEBIT", source: "REFERRAL", refType: "referral_clawback", refId: "c1", amountUsd: 5,
    });
  });
});
```

- [ ] **Step 4: Run — expect FAIL.**
Run: `npx vitest run packages/shared/src/services/__tests__/referral.service.test.ts`

- [ ] **Step 5: Rewrite `releaseMaturedCommissions`** in `referral.service.ts` to post credits. Add `import { postWalletEntry } from "./wallet.service";` at the top. Replace the function body:

```ts
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
```

- [ ] **Step 6: Rewrite `voidCommission`** to drop the old payout-recompute and post clawback debits. Replace its body:

```ts
export async function voidCommission(
  source: PaymentSource,
  externalPaymentId: string,
  reason: string
): Promise<{ voided: number }> {
  const targets = await prisma.referralCommission.findMany({
    where: { source, externalPaymentId, status: { in: [...NON_PAID_STATUSES] } },
    select: { id: true, referrerId: true, commissionUsd: true, status: true },
  });
  if (targets.length === 0) return { voided: 0 };

  await prisma.$transaction(async (tx) => {
    await tx.referralCommission.updateMany({
      where: { source, externalPaymentId, status: { in: [...NON_PAID_STATUSES] } },
      data: { status: "VOIDED", adminNote: reason },
    });
    for (const c of targets) {
      if (c.status === "AVAILABLE") {
        // already credited to the wallet -> compensating debit (may push balance negative)
        await postWalletEntry(tx, {
          userId: c.referrerId, kind: "DEBIT", source: "REFERRAL",
          refType: "referral_clawback", refId: c.id, amountUsd: c.commissionUsd,
        });
      }
    }
  });
  return { voided: targets.length };
}
```

- [ ] **Step 7: Rewrite `voidReferrerCommissions`** the same way (admin void by referrer):

```ts
export async function voidReferrerCommissions(
  userId: string,
  reason: string
): Promise<{ voided: number }> {
  const targets = await prisma.referralCommission.findMany({
    where: { referrerId: userId, status: { in: [...NON_PAID_STATUSES] } },
    select: { id: true, referrerId: true, commissionUsd: true, status: true },
  });
  if (targets.length === 0) return { voided: 0 };
  await prisma.$transaction(async (tx) => {
    await tx.referralCommission.updateMany({
      where: { referrerId: userId, status: { in: [...NON_PAID_STATUSES] } },
      data: { status: "VOIDED", adminNote: reason },
    });
    for (const c of targets) {
      if (c.status === "AVAILABLE") {
        await postWalletEntry(tx, {
          userId: c.referrerId, kind: "DEBIT", source: "REFERRAL",
          refType: "referral_clawback", refId: c.id, amountUsd: c.commissionUsd,
        });
      }
    }
  });
  return { voided: targets.length };
}
```

- [ ] **Step 8: Add `getReferralStats`** (replaces `getReferralBalance` for the referral page). Append:

```ts
export interface ReferralStats {
  pendingUsd: number;   // commissions still in hold
  earnedUsd: number;    // total credited to the wallet from referrals
}

export async function getReferralStats(userId: string): Promise<ReferralStats> {
  const [pending, earned] = await Promise.all([
    prisma.referralCommission.aggregate({ _sum: { commissionUsd: true }, where: { referrerId: userId, status: "PENDING" } }),
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "CREDIT", source: "REFERRAL" } }),
  ]);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    pendingUsd: r2(pending._sum.commissionUsd ?? 0),
    earnedUsd: r2(earned._sum.amountUsd ?? 0),
  };
}
```

- [ ] **Step 9: Update `getReferrerCard`** to show the wallet card. Replace its balance call: import `getWalletBalance, getEarningsBySource` from `./wallet.service` and build:

```ts
export async function getReferrerCard(idOrCode: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ id: idOrCode }, { referralCode: idOrCode }, { telegramId: idOrCode }] },
    select: { id: true, referralCode: true, referralBannedAt: true, _count: { select: { referrals: true } } },
  });
  if (!user) return null;
  const { getWalletBalance, getEarningsBySource } = await import("./wallet.service");
  const balance = await getWalletBalance(user.id);
  const bySource = await getEarningsBySource(user.id);
  const refundCount = await prisma.referralCommission.count({ where: { referrerId: user.id, status: "VOIDED" } });
  return { user, balance, bySource, refundCount };
}
```

(Use a static `import { getWalletBalance, getEarningsBySource } from "./wallet.service";` at the top instead of dynamic import if there is no cycle — wallet.service does not import referral.service, so a static import is fine and preferred.)

- [ ] **Step 10: Drop the payout-batch job.** In `packages/shared/src/lib/referral-queue.ts`:
  - Remove the `PAYOUT_BATCH_JOB` export and its `queue.add(PAYOUT_BATCH_JOB, ...)` in `registerReferralSchedules`.
  - Add a cleanup so an already-registered repeatable is removed on boot (pre-launch Redis may hold it):
```ts
export async function registerReferralSchedules(): Promise<void> {
  const queue = getReferralQueue();
  await queue.add(HOLD_RELEASE_JOB, {}, { repeat: { pattern: "0 * * * *" }, jobId: HOLD_RELEASE_JOB });
  // Retire the old 1st/15th payout batch if still scheduled in Redis.
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === "payout-batch") await queue.removeRepeatableByKey(job.key);
  }
}
```

- [ ] **Step 11: Update the worker scheduler.** In `apps/worker/src/referral-scheduler.ts`, remove the `PAYOUT_BATCH_JOB` and `runPayoutBatch` imports and the entire `if (job.name === PAYOUT_BATCH_JOB) { ... }` branch (keep only the hold-release branch).

- [ ] **Step 12: Run shared tests + typecheck.**
Run: `npx vitest run packages/shared/src` → expect PASS (referral + wallet + withdrawal).
Run: `npx tsc -p packages/shared/tsconfig.json --noEmit` → expect CLEAN now.
Run: `npx tsc -p packages/shared/tsconfig.json` (emit) then `npx tsc -p apps/worker/tsconfig.json --noEmit` → expect CLEAN.

- [ ] **Step 13: Commit.**
```bash
git add packages/shared/src/services/referral.service.ts packages/shared/src/services/__tests__/referral.service.test.ts packages/shared/src/lib/referral-queue.ts apps/worker/src/referral-scheduler.ts
git commit -m "feat(payouts): referral posts wallet credits/clawbacks; drop payout batch"
```

---

## Task 6: Telegram bot — admin CRM → withdrawals, /balance, remove /payout

**Files:** Modify `apps/bot/src/handlers.ts`, `apps/bot/src/i18n.ts`, and the bot tests.

- [ ] **Step 1: Remove the user `/payout` command.** In `handlers.ts`: delete the `/payout` routing branch in `handleUpdate` and the `handlePayout` function. In `i18n.ts`: remove `payoutPrompt`, `payoutSaved`, `payoutInvalid` from the `Dict` interface and both `en`/`ru` objects.

- [ ] **Step 2: Update `/balance` to wallet balance.** Change the `Dict` `balanceInfo` signature and both locales to:
```ts
// Dict
balanceInfo: (available: string, clearing: string) => string;
```
```ts
// en
balanceInfo: (available, clearing) =>
  `Wallet balance:\nAvailable: $${available}\nClearing: $${clearing} (commissions still in a 14-day hold)\n\nWithdraw on clipclap.io/dashboard/payouts`,
// ru
balanceInfo: (available, clearing) =>
  `Баланс кошелька:\nДоступно: $${available}\nВ обработке: $${clearing} (комиссии ещё в 14-дневном холде)\n\nВывод на clipclap.io/dashboard/payouts`,
```
Update `handleBalance` in `handlers.ts`:
```ts
async function handleBalance(client: TelegramClient, message: TelegramMessage, from: TelegramUser, dict: Dict) {
  const user = await resolveTelegramUser(from);
  const { walletService, referralService } = await import("@clipfast/shared");
  const bal = await walletService.getWalletBalance(user.id);
  const stats = await referralService.getReferralStats(user.id);
  await client.sendMessage(
    message.chat.id,
    dict.balanceInfo(bal.availableUsd.toFixed(2), stats.pendingUsd.toFixed(2))
  );
}
```

- [ ] **Step 3: Update `/referral` (`handleReferral`).** Replace its `getReferralBalance` call with `getReferralStats`, and update `dict.referralInfo` to show referral earnings + pending (not available/paid). New signature + bodies:
```ts
// Dict
referralInfo: (web: string, tg: string, earned: string, pending: string) => string;
// en
referralInfo: (web, tg, earned, pending) =>
  `Your referral links:\nWeb: ${web}\nTelegram: ${tg}\n\nReferral earnings: $${earned}\nPending (14-day hold): $${pending}\n\nWithdraw on clipclap.io/dashboard/payouts`,
// ru
referralInfo: (web, tg, earned, pending) =>
  `Ваши реферальные ссылки:\nСайт: ${web}\nTelegram: ${tg}\n\nЗаработано с рефералов: $${earned}\nВ ожидании (14-дневный холд): $${pending}\n\nВывод на clipclap.io/dashboard/payouts`,
```
```ts
// handleReferral: replace balance lines
const stats = await referralService.getReferralStats(user.id);
await client.sendMessage(message.chat.id,
  dict.referralInfo(web, tg, stats.earnedUsd.toFixed(2), stats.pendingUsd.toFixed(2)));
```

- [ ] **Step 4: Switch the admin CRM to withdrawals.** In `handleAdminCommand` and `handleAdminPayoutAction`, replace the `referralService` payout calls with `withdrawalService`:
  - `/payouts` → `withdrawalService.listPendingWithdrawals()`; render each: `${w.id}\n  ${w.status} $${w.amountUsd.toFixed(2)} ${w.method} -> ${w.destination}`.
  - `/approve <id> <fee>` → `const r = await withdrawalService.approveWithdrawal(id, adminId, fee); reply r.ok ? "Approved" : r.error`.
  - `/paid <id> <txRef>` → `const r = await withdrawalService.markWithdrawalPaid(id, adminId, txRef); reply r.ok ? ... : r.error`.
  - `/reject <id> <reason>` → `const r = await withdrawalService.rejectWithdrawal(id, adminId, reason); reply r.ok ? ... : r.error`.
  - `/ref <key>` → `getReferrerCard` now returns `{ user, balance, bySource, refundCount }`; render the Wallet card:
```
Referrer <id> (<code>)
Referred: <n>
Ledger $<balance.ledgerBalanceUsd> - Locked $<balance.lockedUsd> - Available $<balance.availableUsd>
Paid out $<balance.paidOutUsd>
Referral earned $<bySource.REFERRAL ?? 0>
Voided: <refundCount>  Status: <active|BANNED>
```
Import `withdrawalService` from `@clipfast/shared` (dynamic import inside the handlers, matching the existing pattern).

- [ ] **Step 5: Update bot tests.** In `apps/bot/src/__tests__/i18n.test.ts` the canonical command set should no longer include `payout`? (We never added `payout` to the slash list — only `referral`. So no change there.) If any test references the removed `payoutPrompt`/`payoutSaved` keys, update it. Run the bot suite and fix any references.

- [ ] **Step 6: Tests + typecheck.**
Run: `npx vitest run apps/bot/src` → PASS.
Run: `npx tsc -p packages/shared/tsconfig.json` (emit) then `npx tsc -p apps/bot/tsconfig.json --noEmit` → CLEAN.

- [ ] **Step 7: Commit.**
```bash
git add apps/bot/src/handlers.ts apps/bot/src/i18n.ts apps/bot/src/__tests__
git commit -m "feat(payouts): bot wallet /balance, withdrawal admin CRM, remove /payout"
```

---

## Task 7: Web — Payouts page + APIs + sidebar

**Files:** Create the page, two API routes, the withdraw island; modify the sidebar.

- [ ] **Step 1: GET wallet summary API.** Create `apps/web/app/api/payouts/route.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { walletService, withdrawalService, referralService } from "@clipfast/shared";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [balance, bySource, active, history, referralStats] = await Promise.all([
    walletService.getWalletBalance(userId),
    walletService.getEarningsBySource(userId),
    withdrawalService.getActiveWithdrawal(userId),
    withdrawalService.getWithdrawalHistory(userId),
    referralService.getReferralStats(userId),
  ]);

  return NextResponse.json({
    balance,
    bySource,
    clearingUsd: referralStats.pendingUsd, // source-side hold (referral commissions)
    active,
    history,
  });
}
```

- [ ] **Step 2: POST create withdrawal API.** Create `apps/web/app/api/payouts/withdraw/route.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withdrawalService } from "@clipfast/shared";

export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { method, destination, amountUsd } = await req.json();
  const result = await withdrawalService.createWithdrawal(userId, {
    method, destination, amountUsd: Number(amountUsd),
  });
  if (result.status === "error") return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, requestId: result.requestId });
}
```

- [ ] **Step 3: Withdraw form island.** Create `apps/web/components/payouts/withdraw-form.tsx` — monochrome chip grid + destination + amount. Full code:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleNotch } from "@phosphor-icons/react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const METHODS = [
  { value: "USDT_TRC20", label: "USDT (TRC20)" },
  { value: "USDT_ERC20", label: "USDT (ERC20)" },
  { value: "BTC", label: "Bitcoin" },
  { value: "ETH", label: "Ethereum" },
  { value: "USDC", label: "USDC" },
];

export function WithdrawForm({ availableUsd, minUsd }: { availableUsd: number; minUsd: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [method, setMethod] = useState("USDT_TRC20");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const belowMin = availableUsd < minUsd;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/payouts/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, destination, amountUsd: Number(amount) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Couldn't submit");
        return;
      }
      toast({ title: "Withdrawal requested, under review" });
      startTransition(() => router.refresh());
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (belowMin) {
    return (
      <p className="text-sm text-muted-foreground">
        You need at least ${minUsd.toFixed(2)} available to withdraw.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-xs text-muted-foreground">Method</div>
        <div className="flex flex-wrap gap-2">
          {METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMethod(m.value)}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm transition-colors",
                method === m.value
                  ? "border-foreground text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <input
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        placeholder="Destination address"
        spellCheck={false}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
      />
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        placeholder={`Amount ($${minUsd} - $${availableUsd.toFixed(2)})`}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm tabular-nums"
      />
      <button
        type="button"
        onClick={submit}
        disabled={submitting || !destination.trim() || !amount}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {submitting && <CircleNotch weight="bold" className="h-3.5 w-3.5 animate-spin" />}
        Withdraw
      </button>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Payouts page.** Create `apps/web/app/(dashboard)/dashboard/payouts/page.tsx` (server component, minimal monochrome like the referrals page). Full code:

```tsx
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { walletService, withdrawalService, referralService, WALLET_CONFIG } from "@clipfast/shared";
import { WithdrawForm } from "@/components/payouts/withdraw-form";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending", APPROVED: "Approved", PAID: "Paid", REJECTED: "Rejected",
};

export default async function PayoutsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const [balance, bySource, active, history, referralStats] = await Promise.all([
    walletService.getWalletBalance(userId),
    walletService.getEarningsBySource(userId),
    withdrawalService.getActiveWithdrawal(userId),
    withdrawalService.getWithdrawalHistory(userId),
    referralService.getReferralStats(userId),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Payouts</h1>
        <p className="text-sm text-muted-foreground">Withdraw your earnings from across ClipClap.</p>
      </div>

      {/* Balance */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Balance</h2>
        <div className="rounded-lg border border-border p-5">
          <div className="text-sm text-muted-foreground">Available to withdraw</div>
          <div className="mt-1 text-3xl font-bold tabular-nums">{money(balance.availableUsd)}</div>
          <div className="mt-5 grid grid-cols-3 gap-4 border-t border-border pt-4">
            <div>
              <div className="text-xs text-muted-foreground">Clearing</div>
              <div className="mt-0.5 text-sm tabular-nums">{money(referralStats.pendingUsd)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">In withdrawal</div>
              <div className="mt-0.5 text-sm tabular-nums">{money(balance.lockedUsd)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Paid out</div>
              <div className="mt-0.5 text-sm tabular-nums">{money(balance.paidOutUsd)}</div>
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Clearing = referral commissions still in a 14-day hold. Earned from referrals:{" "}
            {money(bySource.REFERRAL ?? 0)}.
          </p>
        </div>
      </div>

      {/* Withdraw or active request */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Withdraw</h2>
        {active ? (
          <div className="rounded-lg border border-border p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Active request</span>
              <span>{STATUS_LABEL[active.status] ?? active.status}</span>
            </div>
            <div className="mt-2 tabular-nums">{money(active.amountUsd)} - {active.method}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              One withdrawal at a time. You can request another once this is paid or rejected.
            </p>
          </div>
        ) : (
          <WithdrawForm availableUsd={balance.availableUsd} minUsd={WALLET_CONFIG.minWithdrawalUsd} />
        )}
      </div>

      {/* History */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">History</h2>
        {history.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No withdrawals yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Method</th>
                  <th className="px-4 py-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((w) => (
                  <tr key={w.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-muted-foreground">
                      {w.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {money(w.amountUsd)}
                      {w.netAmountUsd != null && w.netAmountUsd !== w.amountUsd && (
                        <span className="text-muted-foreground"> (net {money(w.netAmountUsd)})</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{w.method}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {STATUS_LABEL[w.status] ?? w.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Sidebar item.** In `apps/web/components/sidebar.tsx`, import `Wallet` from `@phosphor-icons/react` and add to `navItems` after the Affiliate entry:
```ts
{ href: "/dashboard/payouts", label: "Payouts", icon: Wallet },
```

- [ ] **Step 6: Build dist + web typecheck + render.**
Run: `npx tsc -p packages/shared/tsconfig.json` then `npx tsc -p apps/web/tsconfig.json --noEmit` → CLEAN.
After deploying the migration + regenerating the web container client (see conventions), probe: the page should compile and render 200 for an authenticated user.

- [ ] **Step 7: Commit.**
```bash
git add apps/web/app/api/payouts "apps/web/app/(dashboard)/dashboard/payouts" apps/web/components/payouts apps/web/components/sidebar.tsx
git commit -m "feat(payouts): payouts page, wallet APIs, sidebar item"
```

---

## Task 8: Referrals page cleanup + referrals API

**Files:** Modify `apps/web/app/(dashboard)/dashboard/referrals/page.tsx`, `apps/web/app/api/referrals/route.ts`; delete `payout-destination/route.ts` and `payout-form.tsx`.

- [ ] **Step 1: Delete the obsolete payout files.**
```bash
git rm apps/web/app/api/referrals/payout-destination/route.ts apps/web/components/referrals/payout-form.tsx
```

- [ ] **Step 2: Update the referrals API.** Edit `apps/web/app/api/referrals/route.ts` to return referral stats instead of wallet balance + payout fields. Replace the body so it returns:
```ts
const stats = await referralService.getReferralStats(userId);
const referrals = await prisma.user.findMany({
  where: { referredById: userId },
  select: { id: true, createdAt: true, plan: true, subscriptionStatus: true },
  orderBy: { createdAt: "desc" }, take: 100,
});
return NextResponse.json({
  code: user?.referralCode ?? null,
  termsAccepted: !!user?.referralTermsAcceptedAt,
  pendingUsd: stats.pendingUsd,
  earnedUsd: stats.earnedUsd,
  referrals,
});
```
Remove the `payoutMethod`/`payoutDestination` selects from the `user` query and the `balance` field.

- [ ] **Step 3: Rewrite the referrals page** (`page.tsx`). Remove the entire "Payout destination" section and the `PayoutForm` import. Replace the Earnings box so it shows referral-only numbers (no "Available to withdraw"), and add a CTA to the Payouts page. The earnings box becomes:
```tsx
{/* Earnings (referral) */}
<div className="space-y-4">
  <h2 className="text-lg font-semibold">Referral earnings</h2>
  <div className="rounded-lg border border-border p-5">
    <div className="grid grid-cols-2 gap-4">
      <div>
        <div className="text-xs text-muted-foreground">Total earned</div>
        <div className="mt-0.5 text-2xl font-bold tabular-nums">{money(data.earnedUsd)}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Pending (14-day hold)</div>
        <div className="mt-0.5 text-2xl font-bold tabular-nums">{money(data.pendingUsd)}</div>
      </div>
    </div>
    <a href="/dashboard/payouts" className="mt-4 inline-block text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
      Available to withdraw lives on your Payouts page →
    </a>
  </div>
</div>
```
Update the page's `ReferralData` interface to `{ code, termsAccepted, pendingUsd, earnedUsd, referrals }` (drop balance/payout fields) and remove the payout-destination state/handlers. Keep referral links, referrals table, and join/terms gate. Use plain hyphens only.

- [ ] **Step 4: Build dist + web typecheck.**
Run: `npx tsc -p packages/shared/tsconfig.json` then `npx tsc -p apps/web/tsconfig.json --noEmit` → CLEAN.

- [ ] **Step 5: Commit.**
```bash
git add apps/web/app/api/referrals "apps/web/app/(dashboard)/dashboard/referrals" apps/web/components/referrals
git commit -m "refactor(referral): drop payout destination, show referral-only earnings, link to payouts"
```

---

## Task 9: Final verification + migration cleanup grep

**Files:** none (verification); fix anything the grep finds.

- [ ] **Step 1: Grep for leftover old payout machinery.** Run from repo root:
```bash
grep -rnE "ReferralPayout|runPayoutBatch|PAYOUT_BATCH|payoutDestination|payoutMethod|PAYOUT_PENDING|validatePayoutDestination|setPayoutDestination|markPayoutPaid|approvePayout|rejectPayout|listPendingPayouts" \
  packages/shared/src apps --include=*.ts --include=*.tsx | grep -v node_modules | grep -v ".next" | grep -v dist
```
Expected: **no matches** (except possibly the design/plan docs, which are fine). Any code match is a leftover to remove.

- [ ] **Step 2: Grep for the removed bot command.** Run:
```bash
grep -rnE "/payout\b|handlePayout|payoutPrompt|payoutSaved|payoutInvalid" apps/bot/src | grep -v node_modules
```
Expected: no matches.

- [ ] **Step 3: Full unit suites.**
Run: `npx vitest run packages/shared/src apps/bot/src apps/worker/src` → all PASS.

- [ ] **Step 4: Full typecheck (all projects).**
Run: `npx tsc -p packages/shared/tsconfig.json` then `--noEmit` on shared, then `npx tsc -p apps/web/tsconfig.json --noEmit`, `apps/bot/tsconfig.json --noEmit`, `apps/worker/tsconfig.json --noEmit` → all CLEAN.

- [ ] **Step 5: Deploy the migration to running containers** (so the dev env works end-to-end). For `web`, `bot`, `worker-finalize`:
```bash
docker compose exec -T <svc> npx prisma generate --schema /app/prisma/schema.prisma
docker compose restart <svc>
```
Then probe the web pages: `/dashboard/payouts` and `/dashboard/referrals` should render 200 for an authenticated user; bot `/balance` should reply with the wallet balance.

- [ ] **Step 6: Commit any cleanup found by the greps** (if nothing, skip).
```bash
git add -A && git commit -m "chore(payouts): remove last references to legacy referral payout path"
```

---

## Self-Review (spec coverage)

- **Wallet ledger + derived balances** → Task 1 (schema), Task 3 (`getWalletBalance`/`getEarningsBySource`/`postWalletEntry`).
- **WithdrawalRequest + lifecycle (create serializable+retry, approve fee/coverage guards, idempotent markPaid debit, reject reason)** → Task 1 (model), Task 4.
- **Referral → wallet (credit on release, clawback debit, simplified statuses)** → Task 1 (enum), Task 5.
- **Retire ReferralPayout/runPayoutBatch/payout-batch job/User.payout*** → Task 1 (drop), Task 5 (queue/scheduler/service), Task 9 (grep gate).
- **Telegram CRM → withdrawals, wallet /balance, remove /payout, /referral** → Task 6.
- **Payouts page (chip grid, balance, history, active request) + sidebar + APIs** → Task 7.
- **Referrals page cleanup (no Available, referral-only earnings, CTA), referral API** → Task 8.
- **Wallet config (min, methods, retries)** → Task 2.
- **Tests** → Tasks 3, 4, 5 (+ bot Task 6).
- **Negative balance blocks withdrawals** → Task 4 create guard (`ledger <= 0 || available <= 0`, `amount > available`).
- **Clearing semantics + Float tech-debt** → surfaced in UI copy (Task 7) and config (Task 2); cents migration intentionally deferred.

**Known follow-ups (documented, not in this plan):** money as integer cents; non-crypto rails + saved methods; `CANCELLED` status; ad-partnership credit source. The referral FK `onDelete` audit concern from the prior plan is partly addressed here (wallet rows use `onDelete: Restrict`).
