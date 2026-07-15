# Tribute Shop API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Telegram/Tribute subscription payment path from the channel-subscription model to the Tribute Shop API - card-only, no Stars, no channel - preserving the existing subscription state machine.

**Architecture:** The bot creates a recurring Shop order via `POST /shop/orders` and shows a Pay button with the returned `webappPaymentUrl`. A new `TributeOrder` table maps `orderUuid -> user/plan/cycle`. The rewritten webhook handler dispatches `shopOrder*` events, maps by `orderUuid` only, and drives the same `User` fields as today. Refunds are audit-only.

**Tech Stack:** TypeScript, Prisma (PostgreSQL), Next.js API route (webhook ingress), a plain grammY-free polling bot, Vitest. Tests run **inside containers** (host Node 18 cannot run Vitest).

**Design spec:** `docs/superpowers/specs/2026-07-14-tribute-shop-api-migration-design.md`

**Branch:** `feat/tribute-shop-api-migration` (already checked out).

---

## Conventions for every commit

- Identity: `git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "..."`. No attribution trailer.
- Tests (shared): `docker compose exec -T -w /app/apps/web web npx vitest run --root ../.. <path>`
- Tests (bot): `docker compose exec -T -w /app/apps/bot bot npx vitest run <path>`
- Prisma generate is per-container: after schema changes run it in `web`, `bot`, and every `worker-*` container.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `TributeOrder` model, `TributeOrderStatus` enum, `User.tributeOrders` relation |
| `prisma/migrations/20260714120000_tribute_shop_orders/migration.sql` | Create | Hand-authored forward migration |
| `packages/shared/src/config/tribute-catalog.ts` | Create | EUR price catalog + plan options |
| `packages/shared/src/config/index.ts` | Modify | Export the catalog |
| `packages/shared/src/services/tribute-shop.service.ts` | Create | Outbound `createShopOrder` / `cancelShopOrder` |
| `packages/shared/src/services/__tests__/tribute-shop.service.test.ts` | Create | Client request-body tests |
| `packages/shared/src/services/tribute.service.ts` | Rewrite | Shop API webhook handler + dispatch |
| `packages/shared/src/services/__tests__/tribute.service.test.ts` | Rewrite | Webhook handler tests |
| `packages/shared/src/services/index.ts` | Modify | Export `tribute-shop.service` |
| `apps/web/app/api/payments/tribute/webhook/route.ts` | Modify | Call `processTributeEvent(envelope)` (no product index) |
| `apps/bot/src/i18n.ts` | Modify | EUR plan labels; add `payBtn`, `checkoutError`, `checkoutReady` |
| `apps/bot/src/handlers.ts` | Modify | Callback `plansKeyboard`; `sub:*` handler; remove `tributeUrls` |
| `apps/bot/src/index.ts` | Modify | Remove `tributeUrls` wiring |
| `apps/bot/src/__tests__/subscribe.test.ts` | Create | `parseSubCallback` + subscribe-flow tests |
| `.env.example` | Modify | Remove product vars; add `TRIBUTE_API_BASE` |
| `apps/worker/src/scripts/compensate-maxkornilo.ts` | Create | One-off cutover compensation |

---

## Task 1: Schema - `TributeOrder` model + migration

**Files:**
- Modify: `prisma/schema.prisma` (User model at 103-145; enums near 41; add new model + enum)
- Create: `prisma/migrations/20260714120000_tribute_shop_orders/migration.sql`

- [ ] **Step 1: Add the enum and model to `prisma/schema.prisma`**

Add after the `TributeWebhookEvent` model (near line 262):

```prisma
enum TributeOrderStatus {
  PENDING
  PAID
  DUNNING
  CANCELLED
  FAILED
}

model TributeOrder {
  id           String             @id @default(cuid())
  orderUuid    String             @unique
  userId       String
  telegramId   String
  plan         Plan
  billingCycle BillingCycle
  amount       Int
  currency     String
  payUrl       String
  status       TributeOrderStatus @default(PENDING)
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([userId, plan, billingCycle, status])
  @@map("tribute_orders")
}
```

- [ ] **Step 2: Add the relation field to `User`**

In the `User` model (after `withdrawalRequests  WithdrawalRequest[]` at line 142) add:

```prisma
  tributeOrders       TributeOrder[]
```

- [ ] **Step 3: Hand-author the migration SQL**

Create `prisma/migrations/20260714120000_tribute_shop_orders/migration.sql`:

```sql
CREATE TYPE "TributeOrderStatus" AS ENUM ('PENDING', 'PAID', 'DUNNING', 'CANCELLED', 'FAILED');

CREATE TABLE "tribute_orders" (
    "id" TEXT NOT NULL,
    "orderUuid" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "payUrl" TEXT NOT NULL,
    "status" "TributeOrderStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tribute_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tribute_orders_orderUuid_key" ON "tribute_orders"("orderUuid");
CREATE INDEX "tribute_orders_userId_idx" ON "tribute_orders"("userId");
CREATE INDEX "tribute_orders_userId_plan_billingCycle_status_idx" ON "tribute_orders"("userId", "plan", "billingCycle", "status");

ALTER TABLE "tribute_orders" ADD CONSTRAINT "tribute_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply the migration and regenerate the client**

Run:
```bash
docker compose exec -T web npx prisma migrate deploy --schema /app/prisma/schema.prisma
docker compose exec -T web npx prisma generate --schema /app/prisma/schema.prisma
docker compose exec -T bot npx prisma generate --schema /app/prisma/schema.prisma
docker compose exec -T worker-analyze npx prisma generate --schema /app/prisma/schema.prisma
docker compose exec -T worker-download npx prisma generate --schema /app/prisma/schema.prisma
docker compose exec -T worker-render npx prisma generate --schema /app/prisma/schema.prisma
docker compose exec -T worker-transcribe npx prisma generate --schema /app/prisma/schema.prisma
docker compose exec -T worker-finalize npx prisma generate --schema /app/prisma/schema.prisma
```
Expected: "Applied migration ... 20260714120000_tribute_shop_orders" then "Generated Prisma Client" for each container. `TributeOrder` and `TributeOrderStatus` are now exported from `@prisma/client`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260714120000_tribute_shop_orders/migration.sql
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(tribute): add TributeOrder model + migration"
```

---

## Task 2: EUR price catalog

**Files:**
- Create: `packages/shared/src/config/tribute-catalog.ts`
- Modify: `packages/shared/src/config/index.ts`

- [ ] **Step 1: Create the catalog**

Create `packages/shared/src/config/tribute-catalog.ts`:

```ts
import type { Plan, BillingCycle } from "@prisma/client";

export type TributePeriod = "weekly" | "monthly";

export interface TributeCatalogEntry {
  amount: number; // minor units (cents)
  currency: "eur";
  period: TributePeriod;
  title: string;
  description: string;
}

const DESCRIPTION = "ClipClap subscription";

// Prices mirror the current Tribute products (EUR). MAX is EUR 89.
const CATALOG: Partial<
  Record<Exclude<Plan, "NONE">, Partial<Record<BillingCycle, TributeCatalogEntry>>>
> = {
  STARTER: {
    WEEKLY: { amount: 300, currency: "eur", period: "weekly", title: "ClipClap Starter (weekly)", description: DESCRIPTION },
    MONTHLY: { amount: 900, currency: "eur", period: "monthly", title: "ClipClap Starter (monthly)", description: DESCRIPTION },
  },
  PLUS: {
    MONTHLY: { amount: 2900, currency: "eur", period: "monthly", title: "ClipClap Plus (monthly)", description: DESCRIPTION },
  },
  MAX: {
    MONTHLY: { amount: 8900, currency: "eur", period: "monthly", title: "ClipClap Max (monthly)", description: DESCRIPTION },
  },
};

export function getTributeCatalogEntry(
  plan: Exclude<Plan, "NONE">,
  cycle: BillingCycle
): TributeCatalogEntry {
  const entry = CATALOG[plan]?.[cycle];
  if (!entry) throw new Error(`No Tribute catalog entry for ${plan}/${cycle}`);
  return entry;
}

// The exact plan/cycle pairs offered in the bot (mirrors the current matrix).
export const TRIBUTE_PLAN_OPTIONS: ReadonlyArray<{
  plan: Exclude<Plan, "NONE">;
  cycle: BillingCycle;
}> = [
  { plan: "STARTER", cycle: "WEEKLY" },
  { plan: "STARTER", cycle: "MONTHLY" },
  { plan: "PLUS", cycle: "MONTHLY" },
  { plan: "MAX", cycle: "MONTHLY" },
];
```

- [ ] **Step 2: Export it from the config barrel**

In `packages/shared/src/config/index.ts` add at the end:

```ts
export { getTributeCatalogEntry, TRIBUTE_PLAN_OPTIONS } from "./tribute-catalog";
export type { TributeCatalogEntry, TributePeriod } from "./tribute-catalog";
```

- [ ] **Step 3: Typecheck the shared package**

Run:
```bash
docker compose exec -T web npm run build -w @clipclap/shared
```
Expected: build succeeds (no TS errors).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/config/tribute-catalog.ts packages/shared/src/config/index.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(tribute): add EUR price catalog"
```

---

## Task 3: Outbound Shop API client

**Files:**
- Create: `packages/shared/src/services/tribute-shop.service.ts`
- Create: `packages/shared/src/services/__tests__/tribute-shop.service.test.ts`
- Modify: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/tribute-shop.service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShopOrder, cancelShopOrder } from "../tribute-shop.service";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.TRIBUTE_API_KEY = "test-key";
  process.env.TRIBUTE_API_BASE = "https://tribute.tg/api/v1";
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("createShopOrder", () => {
  it("posts a card recurring order and returns uuid + webappPaymentUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ uuid: "ord-1", webappPaymentUrl: "https://t.me/tribute/app?startapp=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createShopOrder({
      plan: "MAX",
      billingCycle: "MONTHLY",
      telegramId: "42",
      checkoutIntentId: "ci-1",
    });

    expect(result).toEqual({ uuid: "ord-1", webappPaymentUrl: "https://t.me/tribute/app?startapp=x" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tribute.tg/api/v1/shop/orders");
    expect(init.headers["Api-Key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      currency: "eur",
      amount: 8900,
      period: "monthly",
      customerId: "42",
      comment: "clipclap-checkout:ci-1",
    });
    // Never sets starsAmount (guarantees a card order).
    expect("starsAmount" in body).toBe(false);
  });

  it("throws when the API returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad" }));
    await expect(
      createShopOrder({ plan: "STARTER", billingCycle: "WEEKLY", telegramId: "1", checkoutIntentId: "c" })
    ).rejects.toThrow(/400/);
  });
});

describe("cancelShopOrder", () => {
  it("posts to the cancel endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await cancelShopOrder("ord-9");
    expect(fetchMock.mock.calls[0][0]).toBe("https://tribute.tg/api/v1/shop/orders/ord-9/cancel");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
docker compose exec -T -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute-shop.service.test.ts
```
Expected: FAIL - cannot find module `../tribute-shop.service`.

- [ ] **Step 3: Implement the client**

Create `packages/shared/src/services/tribute-shop.service.ts`:

```ts
import type { Plan, BillingCycle } from "@prisma/client";
import { getTributeCatalogEntry } from "../config/tribute-catalog";

const DEFAULT_BASE = "https://tribute.tg/api/v1";

export interface CreateShopOrderInput {
  plan: Exclude<Plan, "NONE">;
  billingCycle: BillingCycle;
  telegramId: string;
  checkoutIntentId: string;
}

export interface ShopOrderResult {
  uuid: string;
  webappPaymentUrl: string;
}

function requireConfig(): { apiKey: string; base: string } {
  const apiKey = process.env.TRIBUTE_API_KEY;
  if (!apiKey) throw new Error("TRIBUTE_API_KEY is not configured");
  const base = process.env.TRIBUTE_API_BASE || DEFAULT_BASE;
  return { apiKey, base };
}

export async function createShopOrder(input: CreateShopOrderInput): Promise<ShopOrderResult> {
  const { apiKey, base } = requireConfig();
  const entry = getTributeCatalogEntry(input.plan, input.billingCycle);

  const body = {
    currency: entry.currency,
    amount: entry.amount,
    period: entry.period,
    title: entry.title,
    description: entry.description,
    customerId: input.telegramId,
    comment: `clipclap-checkout:${input.checkoutIntentId}`,
  };

  const res = await fetch(`${base}/shop/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tribute create order failed: ${res.status} ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { uuid?: unknown; webappPaymentUrl?: unknown };
  if (!data?.uuid || !data?.webappPaymentUrl) {
    throw new Error("Tribute order response missing uuid/webappPaymentUrl");
  }
  return { uuid: String(data.uuid), webappPaymentUrl: String(data.webappPaymentUrl) };
}

export async function cancelShopOrder(uuid: string): Promise<void> {
  const { apiKey, base } = requireConfig();
  const res = await fetch(`${base}/shop/orders/${uuid}/cancel`, {
    method: "POST",
    headers: { "Api-Key": apiKey },
  });
  if (!res.ok) throw new Error(`Tribute cancel order failed: ${res.status}`);
}
```

- [ ] **Step 4: Export from the services barrel**

In `packages/shared/src/services/index.ts`, add next to the other tribute lines:

```ts
export * as tributeShopService from "./tribute-shop.service";
export * from "./tribute-shop.service";
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
docker compose exec -T -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute-shop.service.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/tribute-shop.service.ts packages/shared/src/services/__tests__/tribute-shop.service.test.ts packages/shared/src/services/index.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(tribute): add Shop API client (createShopOrder/cancelShopOrder)"
```

---

## Task 4: Rewrite the webhook handler

This replaces the entire channel-model handler with the Shop API handler. Mapping is by `orderUuid` only; refunds are audit-only; `currentPeriodEnd` is assigned (never incremented).

**Files:**
- Rewrite: `packages/shared/src/services/tribute.service.ts`
- Rewrite: `packages/shared/src/services/__tests__/tribute.service.test.ts`

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `packages/shared/src/services/__tests__/tribute.service.test.ts` with:

```ts
import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.20.0",
  });
}

const mocks = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  eventFindUnique: vi.fn(),
  eventUpdateMany: vi.fn(),
  eventUpdate: vi.fn(),
  orderFindUnique: vi.fn(),
  orderUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  notify: vi.fn(),
  recordCommission: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tributeWebhookEvent: {
      create: mocks.eventCreate,
      findUnique: mocks.eventFindUnique,
      updateMany: mocks.eventUpdateMany,
      update: mocks.eventUpdate,
    },
    tributeOrder: {
      findUnique: mocks.orderFindUnique,
      update: mocks.orderUpdate,
    },
    user: {
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
    },
  },
}));

vi.mock("../telegram-notification.service", () => ({ notifyPaymentEvent: mocks.notify }));
vi.mock("../referral.service", () => ({ recordCommission: mocks.recordCommission }));

import {
  canonicalTributeEventName,
  dispatchTributeEvent,
  hashTributeEvent,
  processTributeEvent,
  verifyTributeSignature,
  type TributeShopWebhookEnvelope,
} from "../tribute.service";

const API_KEY = "shop-secret";

function envelope(
  name: string,
  payload: Partial<TributeShopWebhookEnvelope["payload"]> = {}
): TributeShopWebhookEnvelope {
  return {
    name,
    created_at: "2026-07-14T10:00:00.000Z",
    sent_at: "2026-07-14T10:00:01.000Z",
    payload: { uuid: "ord-1", ...payload },
  };
}

function signed(body: string): string {
  return createHmac("sha256", API_KEY).update(body).digest("hex");
}

const ORDER = {
  orderUuid: "ord-1",
  userId: "user-1",
  telegramId: "42",
  plan: "STARTER",
  billingCycle: "WEEKLY",
  amount: 300,
  currency: "eur",
  status: "PENDING",
};

beforeEach(() => {
  vi.clearAllMocks();
  // default inbox path: create succeeds, claim succeeds
  mocks.eventCreate.mockResolvedValue({});
  mocks.eventUpdateMany.mockResolvedValue({ count: 1 });
  mocks.eventUpdate.mockResolvedValue({});
});

describe("verifyTributeSignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify(envelope("shopOrder"));
    expect(verifyTributeSignature(body, signed(body), API_KEY)).toBe(true);
  });
  it("rejects a tampered body", () => {
    const body = JSON.stringify(envelope("shopOrder"));
    expect(verifyTributeSignature(body + " ", signed(body), API_KEY)).toBe(false);
  });
});

describe("canonicalTributeEventName", () => {
  it("normalizes snake_case and camelCase to the same token", () => {
    expect(canonicalTributeEventName("shop_order_charge_success")).toBe("shoporderchargesuccess");
    expect(canonicalTributeEventName("shopOrderChargeSuccess")).toBe("shoporderchargesuccess");
  });
});

describe("hashTributeEvent", () => {
  it("member events key on uuid + memberExpiresAt (dedups retries, distinguishes periods)", () => {
    const a = hashTributeEvent(envelope("shopOrderChargeSuccess", { memberExpiresAt: "2026-07-25T00:00:00Z" }));
    const aRetry = hashTributeEvent({ ...envelope("shopOrderChargeSuccess", { memberExpiresAt: "2026-07-25T00:00:00Z" }), sent_at: "later" });
    const b = hashTributeEvent(envelope("shopOrderChargeSuccess", { memberExpiresAt: "2026-08-01T00:00:00Z" }));
    expect(a).toBe(aRetry);
    expect(a).not.toBe(b);
  });
});

describe("dispatchTributeEvent - activation", () => {
  it("maps by uuid, sets ACTIVE with currentPeriodEnd = memberExpiresAt", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER });
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", currentPeriodEnd: null });
    mocks.userUpdate.mockResolvedValue({ id: "user-1" });

    const out = await dispatchTributeEvent(
      envelope("shopOrder", { memberExpiresAt: "2026-07-21T00:00:00.000Z" })
    );

    expect(out).toEqual({ status: "activated", userId: "user-1", plan: "STARTER" });
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          plan: "STARTER",
          subscriptionStatus: "ACTIVE",
          tributeSubscriptionId: "ord-1",
          currentPeriodEnd: new Date("2026-07-21T00:00:00.000Z"),
        }),
      })
    );
    expect(mocks.recordCommission).toHaveBeenCalled();
  });

  it("returns unknown_order when no TributeOrder exists", async () => {
    mocks.orderFindUnique.mockResolvedValue(null);
    const out = await dispatchTributeEvent(envelope("shopOrder", { memberExpiresAt: "2026-07-21T00:00:00Z" }));
    expect(out).toEqual({ status: "unknown_order", orderUuid: "ord-1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("does not regress currentPeriodEnd on an out-of-order older event", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER });
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", currentPeriodEnd: new Date("2026-08-01T00:00:00Z") });
    const out = await dispatchTributeEvent(envelope("shopOrderChargeSuccess", { memberExpiresAt: "2026-07-25T00:00:00Z" }));
    expect(out).toEqual({ status: "stale_order", orderUuid: "ord-1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe("dispatchTributeEvent - charge failed", () => {
  it("sets DUNNING on the active order and stamps dunningSince on transition", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PAID" });
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1", subscriptionStatus: "ACTIVE", tributeSubscriptionId: "ord-1", currentPeriodEnd: new Date("2026-07-25T00:00:00Z"),
    });
    const out = await dispatchTributeEvent(envelope("shopOrderChargeFailed", {}));
    expect(out).toEqual({ status: "dunning", userId: "user-1" });
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionStatus: "DUNNING" }) })
    );
    const data = mocks.userUpdate.mock.calls[0][0].data;
    expect(data.dunningSince).toBeInstanceOf(Date);
  });

  it("is audit-only (stale_order) when the order is not the user's active one", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PAID" });
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1", subscriptionStatus: "ACTIVE", tributeSubscriptionId: "ord-DIFFERENT", currentPeriodEnd: new Date("2026-07-25T00:00:00Z"),
    });
    const out = await dispatchTributeEvent(envelope("shopOrderChargeFailed", {}));
    expect(out).toEqual({ status: "stale_order", orderUuid: "ord-1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe("dispatchTributeEvent - cancellation", () => {
  it("sets CANCELED_GRACE while the paid period is still live", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PAID" });
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", tributeSubscriptionId: "ord-1" });
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const out = await dispatchTributeEvent(envelope("shopOrderCancelled", { memberExpiresAt: future }));
    expect(out).toEqual({ status: "cancelled", userId: "user-1" });
    expect(mocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionStatus: "CANCELED_GRACE" }) })
    );
  });
});

describe("dispatchTributeEvent - refund (audit-only)", () => {
  it("records but never changes User access or referral", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PAID" });
    const out = await dispatchTributeEvent(envelope("shopOrderRefunded", { transactionId: 555, amount: 300 }));
    expect(out).toEqual({ status: "refund_recorded", orderUuid: "ord-1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.orderUpdate).not.toHaveBeenCalled();
    expect(mocks.recordCommission).not.toHaveBeenCalled();
  });
});

describe("dispatchTributeEvent - payment failed", () => {
  it("marks a PENDING order FAILED and leaves User untouched", async () => {
    mocks.orderFindUnique.mockResolvedValue({ ...ORDER, status: "PENDING" });
    const out = await dispatchTributeEvent(envelope("shopOrderPaymentFailed", {}));
    expect(out).toEqual({ status: "payment_failed", orderUuid: "ord-1" });
    expect(mocks.orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED" } })
    );
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe("dispatchTributeEvent - legacy channel events", () => {
  it("ignores post-cutover legacy events", async () => {
    const out = await dispatchTributeEvent(envelope("new_subscription", {}));
    expect(out).toEqual({ status: "ignored_event", name: "new_subscription" });
  });
});

describe("processTributeEvent - idempotency", () => {
  it("treats an already-APPLIED event as a duplicate no-op", async () => {
    mocks.eventCreate.mockRejectedValue(p2002());
    mocks.eventFindUnique.mockResolvedValue({ status: "APPLIED" });
    const out = await processTributeEvent(envelope("shopOrder", { memberExpiresAt: "2026-07-21T00:00:00Z" }));
    expect(out).toEqual({ status: "duplicate" });
    expect(mocks.eventUpdateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
docker compose exec -T -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts
```
Expected: FAIL - old exports removed / new exports not defined yet.

- [ ] **Step 3: Rewrite the handler**

Replace the entire contents of `packages/shared/src/services/tribute.service.ts` with:

```ts
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../lib/prisma";
import { notifyPaymentEvent } from "./telegram-notification.service";
import type { Plan, TributeOrder, TributeWebhookStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";

export const TRIBUTE_SIGNATURE_HEADER = "trbt-signature";

export function canonicalTributeEventName(name: string): string {
  // "shop_order_charge_success" | "shopOrderChargeSuccess" -> "shoporderchargesuccess"
  return name.toLowerCase().replace(/[_\s-]/g, "");
}

export interface TributeShopPayload {
  uuid: string;
  status?: string;
  period?: string;
  memberStatus?: string;
  memberExpiresAt?: string;
  transactionId?: number | string;
  amount?: number;
  currency?: string;
  customerId?: string;
  cancelReason?: string;
  [key: string]: unknown;
}

export interface TributeShopWebhookEnvelope {
  name: string;
  created_at: string;
  sent_at: string;
  payload: TributeShopPayload;
}

export type TributeProcessOutcome =
  | { status: "duplicate" }
  | { status: "unknown_order"; orderUuid: string }
  | { status: "ignored_event"; name: string }
  | { status: "activated"; userId: string; plan: Plan }
  | { status: "renewed"; userId: string; plan: Plan }
  | { status: "dunning"; userId: string }
  | { status: "cancelled"; userId: string }
  | { status: "refund_recorded"; orderUuid: string }
  | { status: "payment_failed"; orderUuid: string }
  | { status: "stale_order"; orderUuid: string };

export function verifyTributeSignature(
  rawBody: string,
  signatureHeader: string | null,
  apiKey: string
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", apiKey).update(rawBody).digest("hex");
  const received = signatureHeader.trim().toLowerCase();
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}

export function hashTributeEvent(envelope: TributeShopWebhookEnvelope): string {
  const p = envelope.payload;
  const canon = canonicalTributeEventName(envelope.name);
  // Stable across delivery retries (excludes sent_at). Each key carries a
  // per-occurrence discriminator so two genuine events never collide.
  let discriminator: string;
  if (canon === "shoporderrefunded") {
    discriminator = `tx:${p.transactionId ?? ""}`;
  } else if (canon === "shoporderchargefailed" || canon === "shoporderpaymentfailed") {
    discriminator = `at:${envelope.created_at ?? ""}`;
  } else {
    discriminator = `exp:${p.memberExpiresAt ?? ""}`;
  }
  const key = [canon, String(p.uuid ?? ""), discriminator].join("|");
  return createHash("sha256").update(key).digest("hex");
}

// A PROCESSING row whose handler crashed mid-flight is reclaimable after this lease.
const PROCESSING_LEASE_MS = 15 * 60_000;

function terminalStatusFor(outcome: TributeProcessOutcome): TributeWebhookStatus {
  switch (outcome.status) {
    case "activated":
    case "renewed":
    case "dunning":
    case "cancelled":
    case "refund_recorded":
    case "payment_failed":
    case "stale_order":
      return "APPLIED";
    case "ignored_event":
      return "IGNORED";
    case "unknown_order":
    case "duplicate": // not reached here; kept for exhaustiveness
      return "FAILED";
  }
}

export async function processTributeEvent(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const eventHash = hashTributeEvent(envelope);

  let inserted = true;
  try {
    await prisma.tributeWebhookEvent.create({
      data: { eventHash, name: envelope.name, payload: envelope as unknown as object, status: "RECEIVED" },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      throw err;
    }
    inserted = false;
  }

  if (!inserted) {
    const existing = await prisma.tributeWebhookEvent.findUnique({ where: { eventHash } });
    if (!existing || existing.status === "APPLIED" || existing.status === "IGNORED") {
      return { status: "duplicate" };
    }
  }

  const staleCutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
  const claim = await prisma.tributeWebhookEvent.updateMany({
    where: {
      eventHash,
      OR: [
        { status: { in: ["RECEIVED", "FAILED"] } },
        { status: "PROCESSING", updatedAt: { lt: staleCutoff } },
      ],
    },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  if (claim.count !== 1) {
    return { status: "duplicate" };
  }

  let outcome: TributeProcessOutcome;
  try {
    outcome = await dispatchTributeEvent(envelope);
  } catch (err) {
    await prisma.tributeWebhookEvent.update({
      where: { eventHash },
      data: { status: "FAILED", lastError: err instanceof Error ? err.message : String(err) },
    });
    throw err; // route returns 5xx -> Tribute retries
  }

  const status = terminalStatusFor(outcome);
  await prisma.tributeWebhookEvent.update({
    where: { eventHash },
    data: {
      status,
      outcome: outcome.status,
      processedAt: status === "APPLIED" || status === "IGNORED" ? new Date() : null,
      lastError: status === "FAILED" ? `outcome=${outcome.status}` : null,
    },
  });

  return outcome;
}

async function accrueReferral(order: TributeOrder, expiresAt: Date): Promise<void> {
  // Non-critical: never let referral accrual fail an activation.
  try {
    if (order.amount > 0) {
      const currency = order.currency.toLowerCase();
      const externalPaymentId = `${order.orderUuid}:${expiresAt.toISOString()}`;
      const { recordCommission } = await import("./referral.service");
      const { exchangeRateToUsd, REFERRAL_CONFIG } = await import("../config/referral");
      const rate = exchangeRateToUsd(currency);
      const grossAmountUsd = (order.amount / 100) * rate;
      const feeRateBps = REFERRAL_CONFIG.feeRateBps.TRIBUTE ?? 0;
      const processorFeeUsd = (grossAmountUsd * feeRateBps) / 10000;
      await recordCommission({
        payerUserId: order.userId,
        source: "TRIBUTE",
        externalPaymentId,
        originalCurrency: currency,
        originalAmount: order.amount / 100,
        exchangeRateToUsd: rate,
        grossAmountUsd,
        processorFeeUsd,
        paidAt: new Date(),
      });
    }
  } catch (err) {
    console.error("[referral] accrual failed:", err);
  }
}

async function applyOrderPayment(
  envelope: TributeShopWebhookEnvelope,
  isRenewal: boolean
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "unknown_order", orderUuid };
  if (!p.memberExpiresAt) {
    throw new Error(`payment event for ${orderUuid} missing memberExpiresAt`);
  }
  const expiresAt = new Date(p.memberExpiresAt);

  const user = await prisma.user.findUnique({
    where: { id: order.userId },
    select: { id: true, currentPeriodEnd: true },
  });
  if (!user) return { status: "unknown_order", orderUuid };
  // Assign (never increment); reject an out-of-order older event.
  if (user.currentPeriodEnd && expiresAt < user.currentPeriodEnd) {
    return { status: "stale_order", orderUuid };
  }

  await prisma.user.update({
    where: { id: order.userId },
    data: {
      plan: order.plan,
      billingCycle: order.billingCycle,
      currentPeriodEnd: expiresAt,
      subscriptionStatus: "ACTIVE",
      tributeSubscriptionId: orderUuid,
      dunningSince: null,
      graceEndsAt: null,
    },
  });
  if (order.status !== "PAID") {
    await prisma.tributeOrder.update({ where: { orderUuid }, data: { status: "PAID" } });
  }

  await accrueReferral(order, expiresAt);

  try {
    await notifyPaymentEvent(order.userId, {
      kind: isRenewal ? "subscription_renewed" : "subscription_activated",
      plan: order.plan,
      periodEnd: expiresAt,
    });
  } catch (err) {
    console.warn("[tribute] notification failed (activation stands):", err instanceof Error ? err.message : err);
  }

  return { status: isRenewal ? "renewed" : "activated", userId: order.userId, plan: order.plan };
}

async function applyChargeFailed(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "unknown_order", orderUuid };
  const user = await prisma.user.findUnique({
    where: { id: order.userId },
    select: { id: true, subscriptionStatus: true, tributeSubscriptionId: true, currentPeriodEnd: true },
  });
  if (!user) return { status: "unknown_order", orderUuid };

  // Stale-order guard: only the user's active order affects access.
  if (user.tributeSubscriptionId !== orderUuid) return { status: "stale_order", orderUuid };
  // Out-of-order guard: a newer charge_success already advanced coverage.
  if (p.memberExpiresAt && user.currentPeriodEnd && new Date(p.memberExpiresAt) <= user.currentPeriodEnd) {
    return { status: "stale_order", orderUuid };
  }

  const data: { subscriptionStatus: "DUNNING"; dunningSince?: Date } = { subscriptionStatus: "DUNNING" };
  // DUNNING is a live phase (canSubmitJob keeps access until currentPeriodEnd);
  // stamp dunningSince on the transition only.
  if (user.subscriptionStatus !== "DUNNING") data.dunningSince = new Date();
  await prisma.user.update({ where: { id: order.userId }, data });
  if (order.status !== "DUNNING") {
    await prisma.tributeOrder.update({ where: { orderUuid }, data: { status: "DUNNING" } });
  }
  return { status: "dunning", userId: order.userId };
}

async function applyCancellation(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "unknown_order", orderUuid };
  const user = await prisma.user.findUnique({ where: { id: order.userId } });
  if (!user) return { status: "unknown_order", orderUuid };

  if (order.status !== "CANCELLED") {
    await prisma.tributeOrder.update({ where: { orderUuid }, data: { status: "CANCELLED" } });
  }
  // Stale-order guard: audit-only for a superseded order.
  if (user.tributeSubscriptionId !== orderUuid) return { status: "stale_order", orderUuid };

  const expiresAt = p.memberExpiresAt ? new Date(p.memberExpiresAt) : null;
  const stillActive = expiresAt ? expiresAt > new Date() : false;
  await prisma.user.update({
    where: { id: order.userId },
    data: {
      subscriptionStatus: stillActive ? "CANCELED_GRACE" : "CANCELED",
      graceEndsAt: stillActive ? expiresAt : null,
    },
  });

  try {
    await notifyPaymentEvent(order.userId, {
      kind: "subscription_canceled",
      graceEndsAt: stillActive ? expiresAt : null,
    });
  } catch (err) {
    console.warn("[tribute] cancel notification failed:", err instanceof Error ? err.message : err);
  }

  return { status: "cancelled", userId: order.userId };
}

async function recordRefund(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  // Audit-only: refunds are per-transaction; access + referral are NOT changed.
  console.warn("[tribute] refund received (audit-only, manual review required)", {
    orderUuid,
    transactionId: p.transactionId,
    amount: p.amount,
    currency: p.currency,
    known: Boolean(order),
  });
  if (!order) return { status: "ignored_event", name: envelope.name };
  return { status: "refund_recorded", orderUuid };
}

async function markPaymentFailed(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "ignored_event", name: envelope.name };
  if (order.status === "PENDING") {
    await prisma.tributeOrder.update({ where: { orderUuid }, data: { status: "FAILED" } });
  }
  return { status: "payment_failed", orderUuid };
}

export async function dispatchTributeEvent(
  envelope: TributeShopWebhookEnvelope
): Promise<TributeProcessOutcome> {
  switch (canonicalTributeEventName(envelope.name)) {
    case "shoporder":
    case "shoporderpaymentreceived":
      return applyOrderPayment(envelope, false);
    case "shoporderchargesuccess":
      return applyOrderPayment(envelope, true);
    case "shoporderchargefailed":
      return applyChargeFailed(envelope);
    case "shopordercancelled":
    case "shopordercanceled":
      return applyCancellation(envelope);
    case "shoporderrefunded":
      return recordRefund(envelope);
    case "shoporderpaymentfailed":
      return markPaymentFailed(envelope);
    case "newsubscription":
    case "renewedsubscription":
    case "cancelledsubscription":
      console.info("[tribute] legacy channel event ignored post-cutover", { name: envelope.name });
      return { status: "ignored_event", name: envelope.name };
    default:
      return { status: "ignored_event", name: envelope.name };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
docker compose exec -T -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts
```
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Build the shared package (catches type breakage in callers)**

Run:
```bash
docker compose exec -T web npm run build -w @clipclap/shared
```
Expected: build fails ONLY in `apps/web/.../route.ts` (fixed in Task 5). If shared itself fails to build, fix before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/tribute.service.ts packages/shared/src/services/__tests__/tribute.service.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(tribute): rewrite webhook handler for Shop API events"
```

---

## Task 5: Update the webhook route

**Files:**
- Modify: `apps/web/app/api/payments/tribute/webhook/route.ts`

- [ ] **Step 1: Replace the route body**

Replace the entire contents of `apps/web/app/api/payments/tribute/webhook/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  TRIBUTE_SIGNATURE_HEADER,
  processTributeEvent,
  verifyTributeSignature,
  type TributeShopWebhookEnvelope,
} from "@clipclap/shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const apiKey = process.env.TRIBUTE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Tribute is not configured" }, { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get(TRIBUTE_SIGNATURE_HEADER);

  console.log("[tribute-webhook] received", {
    bodyBytes: rawBody.length,
    signaturePresent: Boolean(signature),
  });

  if (!verifyTributeSignature(rawBody, signature, apiKey)) {
    console.warn("[tribute-webhook] signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let envelope: TributeShopWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !envelope ||
    typeof envelope.name !== "string" ||
    typeof envelope.payload !== "object" ||
    envelope.payload === null ||
    typeof envelope.payload.uuid !== "string"
  ) {
    console.warn("[tribute-webhook] malformed envelope", { raw: rawBody.slice(0, 400) });
    return NextResponse.json({ error: "Malformed envelope" }, { status: 400 });
  }

  console.log("[tribute-webhook] parsed", {
    name: envelope.name,
    uuid: envelope.payload.uuid,
    memberExpiresAt: envelope.payload.memberExpiresAt,
  });

  try {
    const outcome = await processTributeEvent(envelope);
    console.log("[tribute-webhook] outcome", outcome);
    // An unknown order is a mapping problem: return 5xx so Tribute retries
    // (the inbox row is FAILED and reprocessable once the order exists).
    const retryable = outcome.status === "unknown_order";
    return NextResponse.json({ ok: !retryable, outcome }, { status: retryable ? 500 : 200 });
  } catch (error) {
    console.error("[tribute-webhook] processing failed:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Build shared + typecheck web**

Run:
```bash
docker compose exec -T web npm run build -w @clipclap/shared
docker compose exec -T web npx tsc --noEmit -p apps/web/tsconfig.json
```
Expected: both succeed (no references to the deleted `loadTributeProductIndexFromEnv` remain).

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/payments/tribute/webhook/route.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(tribute): webhook route calls processTributeEvent without product index"
```

---

## Task 6: Bot - i18n strings + callback plans keyboard

**Files:**
- Modify: `apps/bot/src/i18n.ts` (Dict type ~34-90; en dict ~109-219; ru dict ~244-363)
- Modify: `apps/bot/src/handlers.ts` (`plansKeyboard` at 555-576; add `parseSubCallback`)
- Create: `apps/bot/src/__tests__/subscribe.test.ts`

- [ ] **Step 1: Write the failing test for `parseSubCallback`**

Create `apps/bot/src/__tests__/subscribe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSubCallback } from "../handlers";

describe("parseSubCallback", () => {
  it("parses supported plan/cycle pairs", () => {
    expect(parseSubCallback("sub:STARTER:WEEKLY")).toEqual({ plan: "STARTER", cycle: "WEEKLY" });
    expect(parseSubCallback("sub:MAX:MONTHLY")).toEqual({ plan: "MAX", cycle: "MONTHLY" });
  });
  it("rejects unsupported combos and junk", () => {
    expect(parseSubCallback("sub:PLUS:WEEKLY")).toBeNull();
    expect(parseSubCallback("sub:MAX:WEEKLY")).toBeNull();
    expect(parseSubCallback("sub:BOGUS:MONTHLY")).toBeNull();
    expect(parseSubCallback("lang_en")).toBeNull();
    expect(parseSubCallback(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
docker compose exec -T -w /app/apps/bot bot npx vitest run src/__tests__/subscribe.test.ts
```
Expected: FAIL - `parseSubCallback` is not exported.

- [ ] **Step 3: Update the i18n plan labels + add keys**

In `apps/bot/src/i18n.ts`, in the `Dict` type block add (near `manageSubscriptionBtn` at line 87):

```ts
  payBtn: string;
  checkoutReady: string;
  checkoutError: string;
```

In the **en** dict replace lines 144-147 with:

```ts
  planStarterWeeklyBtn: "🌱 Starter - €3 / week",
  planStarterBtn: "💎 Starter - €9 / month",
  planPlusBtn: "🚀 Plus - €29 / month",
  planMaxBtn: "👑 Max - €89 / month",
```

and add (near `manageSubscriptionBtn` at line 219):

```ts
  payBtn: "💳 Pay",
  checkoutReady: "Tap Pay to complete your subscription. You'll return to the bot after payment.",
  checkoutError: "Could not start checkout. Please try again in a moment.",
```

In the **ru** dict replace lines 281-284 with:

```ts
  planStarterWeeklyBtn: "🌱 Starter - €3 / неделя",
  planStarterBtn: "💎 Starter - €9 / мес",
  planPlusBtn: "🚀 Plus - €29 / мес",
  planMaxBtn: "👑 Max - €89 / мес",
```

and add (near `manageSubscriptionBtn` at line 363):

```ts
  payBtn: "💳 Оплатить",
  checkoutReady: "Нажми «Оплатить», чтобы оформить подписку. После оплаты вернёшься в бота.",
  checkoutError: "Не удалось начать оплату. Попробуй ещё раз через минуту.",
```

- [ ] **Step 4: Replace `plansKeyboard` and add `parseSubCallback` in `handlers.ts`**

Replace `plansKeyboard` (lines 555-576) with:

```ts
export function plansKeyboard(dict: Dict): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.planStarterWeeklyBtn, callback_data: "sub:STARTER:WEEKLY" }],
      [{ text: dict.planStarterBtn, callback_data: "sub:STARTER:MONTHLY" }],
      [{ text: dict.planPlusBtn, callback_data: "sub:PLUS:MONTHLY" }],
      [{ text: dict.planMaxBtn, callback_data: "sub:MAX:MONTHLY" }],
    ],
  };
}

export type SubPlan = "STARTER" | "PLUS" | "MAX";
export type SubCycle = "WEEKLY" | "MONTHLY";

export function parseSubCallback(
  data: string | undefined
): { plan: SubPlan; cycle: SubCycle } | null {
  if (!data || !data.startsWith("sub:")) return null;
  const [, plan, cycle] = data.split(":");
  const isPlan = plan === "STARTER" || plan === "PLUS" || plan === "MAX";
  const isCycle = cycle === "WEEKLY" || cycle === "MONTHLY";
  if (!isPlan || !isCycle) return null;
  // Only STARTER offers weekly; PLUS/MAX are monthly-only.
  if (cycle === "WEEKLY" && plan !== "STARTER") return null;
  return { plan: plan as SubPlan, cycle: cycle as SubCycle };
}
```

- [ ] **Step 5: Fix the three `plansKeyboard(dict, config)` call sites**

`plansKeyboard` no longer takes `config`. Update:
- Line 265: `const keyboard = plansKeyboard(dict);`
- Line 307: `const keyboard = plansKeyboard(dict);`
- Line 488: `const keyboard = plansKeyboard(dict);`

(The `keyboard ? { replyMarkup: keyboard } : undefined` wrappers still compile; `plansKeyboard` now always returns a value.)

- [ ] **Step 6: Run the `parseSubCallback` test to verify it passes**

Run:
```bash
docker compose exec -T -w /app/apps/bot bot npx vitest run src/__tests__/subscribe.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/i18n.ts apps/bot/src/handlers.ts apps/bot/src/__tests__/subscribe.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): callback plans keyboard + parseSubCallback + EUR labels"
```

---

## Task 7: Bot - subscribe callback handler

**Files:**
- Modify: `apps/bot/src/handlers.ts` (imports at 4-20; `handleCallbackQuery` at 464-534; add `handleSubscribeCallback`)
- Modify: `apps/bot/src/__tests__/subscribe.test.ts` (add flow tests)

- [ ] **Step 1: Add the failing flow test**

Append to `apps/bot/src/__tests__/subscribe.test.ts`:

```ts
import { beforeEach, vi } from "vitest";

const flowMocks = vi.hoisted(() => ({
  createShopOrder: vi.fn(),
  cancelShopOrder: vi.fn(),
  getTributeCatalogEntry: vi.fn(),
  resolveTelegramUser: vi.fn(),
  orderFindFirst: vi.fn(),
  orderCreate: vi.fn(),
}));

vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createShopOrder: flowMocks.createShopOrder,
    cancelShopOrder: flowMocks.cancelShopOrder,
    getTributeCatalogEntry: flowMocks.getTributeCatalogEntry,
    prisma: { tributeOrder: { findFirst: flowMocks.orderFindFirst, create: flowMocks.orderCreate }, user: { findUnique: vi.fn() } },
  };
});

import { handleSubscribeCallback } from "../handlers";
import { t } from "../i18n";

function fakeClient() {
  return {
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe("handleSubscribeCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flowMocks.getTributeCatalogEntry.mockReturnValue({ amount: 8900, currency: "eur", period: "monthly", title: "t", description: "d" });
    flowMocks.resolveTelegramUser.mockResolvedValue({ id: "user-1" });
    flowMocks.orderFindFirst.mockResolvedValue(null);
  });

  it("creates an order, persists it, and shows the Pay button", async () => {
    flowMocks.createShopOrder.mockResolvedValue({ uuid: "ord-1", webappPaymentUrl: "https://pay" });
    flowMocks.orderCreate.mockResolvedValue({});
    const client = fakeClient();
    const query = { id: "q", from: { id: 42 }, message: { chat: { id: 7 }, message_id: 3 }, data: "sub:MAX:MONTHLY" };

    await handleSubscribeCallback(client, query as never, t("en"), { id: "user-1" } as never);

    expect(flowMocks.createShopOrder).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "MAX", billingCycle: "MONTHLY", telegramId: "42" })
    );
    expect(flowMocks.orderCreate).toHaveBeenCalled();
    const editArgs = (client as unknown as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText.mock.calls[0];
    expect(JSON.stringify(editArgs)).toContain("https://pay");
  });

  it("best-effort cancels the remote order when the local insert fails", async () => {
    flowMocks.createShopOrder.mockResolvedValue({ uuid: "ord-2", webappPaymentUrl: "https://pay" });
    flowMocks.orderCreate.mockRejectedValue(new Error("db down"));
    const client = fakeClient();
    const query = { id: "q", from: { id: 42 }, message: { chat: { id: 7 }, message_id: 3 }, data: "sub:MAX:MONTHLY" };

    await handleSubscribeCallback(client, query as never, t("en"), { id: "user-1" } as never);

    expect(flowMocks.cancelShopOrder).toHaveBeenCalledWith("ord-2");
    expect((client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
docker compose exec -T -w /app/apps/bot bot npx vitest run src/__tests__/subscribe.test.ts
```
Expected: FAIL - `handleSubscribeCallback` not exported.

- [ ] **Step 3: Add imports to `handlers.ts`**

In the `@clipclap/shared` import block (lines 4-20) add:

```ts
  cancelShopOrder,
  createShopOrder,
  getTributeCatalogEntry,
```

At the top of the file (after line 3) add:

```ts
import { randomUUID } from "crypto";
```

- [ ] **Step 4: Add `handleSubscribeCallback` and its lock**

Add after `plansKeyboard`/`parseSubCallback` (after the code added in Task 6):

```ts
// In-memory per-user lock: prevents a double-tap from minting two orders.
const subscribeLocks = new Set<string>();

export async function handleSubscribeCallback(
  client: TelegramClient,
  query: TelegramCallbackQuery,
  dict: Dict,
  user: { id: string }
): Promise<void> {
  const parsed = parseSubCallback(query.data);
  if (!parsed || !query.message || !query.from) return;

  const telegramId = String(query.from.id);
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (subscribeLocks.has(telegramId)) return;
  subscribeLocks.add(telegramId);
  try {
    const entry = getTributeCatalogEntry(parsed.plan, parsed.cycle);

    // Reuse a fresh PENDING order for the same user+plan+cycle (avoids a second order).
    const fresh = await prisma.tributeOrder.findFirst({
      where: {
        userId: user.id,
        plan: parsed.plan,
        billingCycle: parsed.cycle,
        status: "PENDING",
        createdAt: { gt: new Date(Date.now() - 15 * 60_000) },
      },
      orderBy: { createdAt: "desc" },
    });

    let payUrl: string;
    if (fresh) {
      payUrl = fresh.payUrl;
    } else {
      const checkoutIntentId = randomUUID();
      let result: { uuid: string; webappPaymentUrl: string };
      try {
        result = await createShopOrder({
          plan: parsed.plan,
          billingCycle: parsed.cycle,
          telegramId,
          checkoutIntentId,
        });
      } catch (err) {
        console.error("[tribute] createShopOrder failed", { telegramId, checkoutIntentId, err });
        await client.sendMessage(chatId, dict.checkoutError).catch(() => undefined);
        return;
      }

      try {
        await prisma.tributeOrder.create({
          data: {
            orderUuid: result.uuid,
            userId: user.id,
            telegramId,
            plan: parsed.plan,
            billingCycle: parsed.cycle,
            amount: entry.amount,
            currency: entry.currency,
            payUrl: result.webappPaymentUrl,
            status: "PENDING",
          },
        });
      } catch (err) {
        // Remote order exists but we could not record it: cancel it so the user
        // is never handed an order we cannot track, then ask them to retry.
        console.error("[tribute] order insert failed; cancelling remote order", {
          checkoutIntentId,
          uuid: result.uuid,
          err,
        });
        await cancelShopOrder(result.uuid).catch(() => undefined);
        await client.sendMessage(chatId, dict.checkoutError).catch(() => undefined);
        return;
      }
      payUrl = result.webappPaymentUrl;
    }

    await client
      .editMessageText(chatId, messageId, dict.checkoutReady, {
        replyMarkup: { inline_keyboard: [[{ text: dict.payBtn, url: payUrl }]] },
      })
      .catch(() => undefined);
  } finally {
    subscribeLocks.delete(telegramId);
  }
}
```

- [ ] **Step 5: Wire it into `handleCallbackQuery`**

In `handleCallbackQuery`, immediately after the `answerCallbackQuery` call (line 483) and before the `switch (query.data)` (line 485) insert:

```ts
  if (query.data.startsWith("sub:")) {
    const user = await resolveTelegramUser(query.from);
    await handleSubscribeCallback(client, query, dict, user);
    return;
  }
```

- [ ] **Step 6: Run to verify it passes**

Run:
```bash
docker compose exec -T -w /app/apps/bot bot npx vitest run src/__tests__/subscribe.test.ts
```
Expected: PASS (all subscribe tests).

- [ ] **Step 7: Typecheck the bot**

Run:
```bash
docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/__tests__/subscribe.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): subscribe callback creates Shop order + shows Pay button"
```

---

## Task 8: Bot - remove `tributeUrls` wiring

**Files:**
- Modify: `apps/bot/src/index.ts` (lines 12-17, 42)
- Modify: `apps/bot/src/handlers.ts` (`BotRuntimeConfig` at 103-111)

- [ ] **Step 1: Remove `tributeUrls` from `BotRuntimeConfig`**

In `apps/bot/src/handlers.ts` replace the `BotRuntimeConfig` interface (103-111) with:

```ts
export interface BotRuntimeConfig {
  appUrl: string;
}
```

- [ ] **Step 2: Remove the env wiring in `index.ts`**

In `apps/bot/src/index.ts` delete the `tributeUrls` block (lines 12-17) and change the `handleUpdate` call (line 42) to:

```ts
        await handleUpdate(client, update, { appUrl });
```

- [ ] **Step 3: Typecheck the bot**

Run:
```bash
docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit
```
Expected: no errors (no remaining references to `config.tributeUrls`).

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/index.ts apps/bot/src/handlers.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "refactor(bot): drop static tributeUrls config"
```

---

## Task 9: `.env.example` cleanup

**Files:**
- Modify: `.env.example` (lines 83-97)

- [ ] **Step 1: Replace the Tribute env block**

Replace lines 83-97 with:

```bash
TRIBUTE_API_KEY=
# Base URL for the Tribute Shop API (override only for testing)
TRIBUTE_API_BASE=https://tribute.tg/api/v1
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "chore(tribute): replace product env vars with TRIBUTE_API_BASE"
```

> Deployment note (not a code step): remove the now-unused `TRIBUTE_PRODUCT_*`
> vars from the server `.env`, add `TRIBUTE_API_BASE`, set the Shop webhook URL +
> `Api-Key` in Tribute, and enable recurring payments. Pre-flight `GET /shop`:
> `recurrent == true`, `onlyStars == false`, `status == 1`.

---

## Task 10: Cutover compensation script (@Maxkornilo)

**Files:**
- Create: `apps/worker/src/scripts/compensate-maxkornilo.ts`

- [ ] **Step 1: Write the one-off script**

Create `apps/worker/src/scripts/compensate-maxkornilo.ts`:

```ts
// One-off cutover compensation: the single live channel-model subscriber
// (@Maxkornilo, telegram_user_id 332548055, Starter Weekly) keeps access
// through a manually extended period after the hard cutover. Run once.
//   docker compose exec -T worker-finalize npx tsx apps/worker/src/scripts/compensate-maxkornilo.ts --apply
import { prisma } from "@clipclap/shared";

const TELEGRAM_ID = "332548055";
const EXTEND_DAYS = 7;

async function main() {
  const apply = process.argv.includes("--apply");
  const user = await prisma.user.findUnique({ where: { telegramId: TELEGRAM_ID } });
  if (!user) throw new Error(`user telegramId=${TELEGRAM_ID} not found`);

  const base = user.currentPeriodEnd && user.currentPeriodEnd > new Date() ? user.currentPeriodEnd : new Date();
  const newEnd = new Date(base.getTime() + EXTEND_DAYS * 86_400_000);

  console.log(`[compensate] user=${user.id} plan=${user.plan} status=${user.subscriptionStatus}`);
  console.log(`[compensate] currentPeriodEnd ${user.currentPeriodEnd?.toISOString() ?? "null"} -> ${newEnd.toISOString()}`);

  if (!apply) {
    console.log("[compensate] dry run - pass --apply to persist");
    return;
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { plan: "STARTER", billingCycle: "WEEKLY", subscriptionStatus: "ACTIVE", currentPeriodEnd: newEnd, graceEndsAt: null, dunningSince: null },
  });
  console.log("[compensate] applied");
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Dry-run it**

Run:
```bash
docker compose exec -T worker-finalize npx tsx apps/worker/src/scripts/compensate-maxkornilo.ts
```
Expected: prints the planned extension; makes no change.

- [ ] **Step 3: Commit (do NOT run --apply until deploy)**

```bash
git add apps/worker/src/scripts/compensate-maxkornilo.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "chore(tribute): one-off cutover compensation script"
```

> Run `--apply` once, at deploy time (Rollout step 3 in the spec), then cancel
> @Maxkornilo's old channel subscription in the Tribute dashboard.

---

## Task 11: Full verification

- [ ] **Step 1: Run the full shared + bot test suites**

Run:
```bash
docker compose exec -T -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts packages/shared/src/services/__tests__/tribute-shop.service.test.ts
docker compose exec -T -w /app/apps/bot bot npx vitest run src/__tests__/subscribe.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Typecheck web + bot and build shared**

Run:
```bash
docker compose exec -T web npm run build -w @clipclap/shared
docker compose exec -T web npx tsc --noEmit -p apps/web/tsconfig.json
docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit
```
Expected: all succeed.

- [ ] **Step 3: Grep for leftovers from the channel model**

Run:
```bash
grep -rnE "tributeUrls|TRIBUTE_PRODUCT_|resolveProductBinding|loadTributeProductIndexFromEnv|extractStartapp|new_subscription" apps packages --include=*.ts | grep -v "__tests__" | grep -v "legacy channel event"
```
Expected: no matches (all channel-model references removed; the only allowed `new_subscription` reference is the legacy no-op `case` labels in `tribute.service.ts`).

- [ ] **Step 4: Restart the bot + web to load the new code**

Run:
```bash
docker compose restart bot web
docker compose logs --tail=20 bot web
```
Expected: both start cleanly; bot logs "ClipClap Telegram bot starting".

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Outbound client -> Task 3. Price catalog -> Task 2. `TributeOrder` (uuid-only map) -> Task 1 + used in Task 4/7. Webhook rewrite (6 events, canonicalization, per-event hash keys, stale/out-of-order guards, assign-not-increment, FAILED split) -> Task 4. Refund audit-only -> Task 4. Route -> Task 5. Bot callback flow (lock, reuse fresh PENDING, best-effort cancel, Pay button) -> Task 6/7. Remove `tributeUrls`/env -> Task 8/9. Legacy no-op 200 -> Task 4 dispatch. Hard-cutover compensation -> Task 10. Testing (all handler cases + client + bot) -> Tasks 3/4/6/7/11. Preserved inbox/signature/gating/reconcile -> reused unchanged in Task 4 + route. `DUNNING` stays live -> asserted in Task 4 tests + code comment.
- Deferred (Non-goals) correctly NOT implemented: transaction ledger, refund auto-handling, referral void, durable orphan recovery.

**Placeholder scan:** none - every code and test step contains complete code and exact commands.

**Type consistency:** `TributeShopWebhookEnvelope`/`TributeShopPayload`/`TributeProcessOutcome` used identically across Task 4 handler + tests + Task 5 route. `createShopOrder`/`ShopOrderResult` shape matches between Task 3 and Task 7. `parseSubCallback` return shape (`{plan, cycle}`) matches its use in `handleSubscribeCallback`. `plansKeyboard(dict)` single-arg signature updated at all three call sites (Task 6 Step 5).

**Note (added during planning):** `TributeOrder.payUrl` was added to the model (beyond the spec's field list) so a reused fresh PENDING order can re-show its Pay button without re-hitting the Shop API. This is consistent with the spec's "reuse fresh PENDING" decision.
