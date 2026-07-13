# Tribute Webhook Fix + Subscriber Compensation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tribute subscription webhooks actually activate plans (fix event-name and product-mapping bugs), give the webhook a durable, retry-safe inbox, add stale/out-of-order guards, and compensate the one affected paying user (@Maxkornilo) with a safe idempotent replay + a 7-day extension.

**Architecture:** Split `processTributeEvent` into an **ingress state-machine** (dedup + `RECEIVED→PROCESSING→APPLIED/IGNORED/FAILED`) and a pure `dispatchTributeEvent` (normalize + map + business handlers). Product mapping resolves the stable product code from `web_app_link` with a `subscription_name` fallback via a two-index config. A one-off `tsx` script replays the stored event through `dispatchTributeEvent` for compensation.

**Tech Stack:** TypeScript, Prisma 5.20 (PostgreSQL), Next.js 15 API route, Vitest 3, `tsx` (worker scripts), Docker Compose. Migrations run in-container via `migrate deploy`; tests via `vitest` in the web/worker container.

**Design reference:** `docs/superpowers/specs/2026-07-13-tribute-webhook-fix-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `prisma/schema.prisma` | `TributeWebhookStatus` enum + inbox columns on `TributeWebhookEvent` | Modify |
| `prisma/migrations/20260713120000_tribute_webhook_inbox/migration.sql` | Hand-authored forward migration | Create |
| `packages/shared/src/services/tribute.service.ts` | All Tribute logic: normalization, hashing, product index, dispatch, ingress state-machine, handlers | Modify (major) |
| `packages/shared/src/services/__tests__/tribute.service.test.ts` | Unit tests against the real payload contract | Rewrite |
| `apps/web/app/api/payments/tribute/webhook/route.ts` | HTTP ingress; maps outcome → status code | Modify |
| `apps/worker/src/scripts/replay-tribute-event.ts` | Idempotent compensation replay (`--dry-run`/`--apply`) | Create |
| `.env.example` | Document `TRIBUTE_PRODUCT_*_NAME` vars | Modify |

**Conventions used below**
- Run tests in the web container: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
  (the web container has `@clipclap/shared` and `vitest`; `-w /app` sets the repo root).
- Commit identity is the repo default (`Trowgar <trowgar@yahoo.com>`); do **not** add a Claude attribution trailer.
- All work happens on the current branch `fix/tribute-webhook-activation`.

---

## Task 1: Prisma schema + inbox migration

**Files:**
- Modify: `prisma/schema.prisma` (the `TributeWebhookEvent` model, currently lines 227-236)
- Create: `prisma/migrations/20260713120000_tribute_webhook_inbox/migration.sql`

- [ ] **Step 1: Replace the `TributeWebhookEvent` model**

Replace the existing model (lines 227-236) with:

```prisma
enum TributeWebhookStatus {
  RECEIVED
  PROCESSING
  APPLIED
  IGNORED
  FAILED
}

model TributeWebhookEvent {
  id          String               @id @default(cuid())
  eventHash   String               @unique
  name        String
  payload     Json
  status      TributeWebhookStatus @default(RECEIVED)
  outcome     String?
  attempts    Int                  @default(0)
  lastError   String?
  processedAt DateTime?
  createdAt   DateTime             @default(now())
  updatedAt   DateTime             @updatedAt

  @@index([name, createdAt])
  @@index([status])
  @@map("tribute_webhook_events")
}
```

- [ ] **Step 2: Hand-author the forward migration**

Create `prisma/migrations/20260713120000_tribute_webhook_inbox/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "TributeWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'APPLIED', 'IGNORED', 'FAILED');

-- AlterTable
ALTER TABLE "tribute_webhook_events"
  ADD COLUMN "status" "TributeWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "outcome" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "processedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "tribute_webhook_events_status_idx" ON "tribute_webhook_events"("status");
```

Note: `updatedAt` carries a SQL `DEFAULT CURRENT_TIMESTAMP` so the one existing prod row backfills cleanly; Prisma manages the value on subsequent writes. The lone existing row stays `status=RECEIVED` and is settled by the compensation script in Task 7.

- [ ] **Step 3: Regenerate the Prisma client (in-container)**

Run: `docker compose exec -w /app web npx prisma generate`
Expected: "Generated Prisma Client" success; `TributeWebhookStatus` is now an exported type from `@prisma/client`.

Do **not** run `migrate deploy` yet — the DB migration is applied at deployment time (Task 8) after the code that depends on the new columns is in place. `generate` only updates the client types locally so the service compiles.

- [ ] **Step 4: Typecheck**

Run: `docker compose exec -w /app web npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS (no references to the new columns yet; this confirms the schema/generate step is clean).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260713120000_tribute_webhook_inbox/migration.sql
git commit -m "feat(tribute): add webhook inbox state-machine schema + migration"
```

---

## Task 2: Event-name normalization + stable idempotency hash

This task rewrites the test file header (new mocks) and the first pure helpers. The old tests are replaced because they assert a fictional camelCase contract and `sent_at`-based dedup.

**Files:**
- Modify: `packages/shared/src/services/tribute.service.ts`
- Rewrite: `packages/shared/src/services/__tests__/tribute.service.test.ts`

- [ ] **Step 1: Write the new test file (header + normalization + hash)**

Replace the entire contents of `tribute.service.test.ts` with:

```ts
import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  eventFindUnique: vi.fn(),
  eventUpdateMany: vi.fn(),
  eventUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpsert: vi.fn(),
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
    user: {
      findUnique: mocks.userFindUnique,
      upsert: mocks.userUpsert,
      update: mocks.userUpdate,
    },
  },
}));

vi.mock("../telegram-notification.service", () => ({
  notifyPaymentEvent: mocks.notify,
}));

vi.mock("../referral.service", () => ({
  recordCommission: mocks.recordCommission,
}));

import {
  canonicalTributeEventName,
  hashTributeEvent,
  verifyTributeSignature,
  type TributeWebhookEnvelope,
} from "../tribute.service";

const API_KEY = "tribute-secret";

function signedBody(body: string): string {
  return createHmac("sha256", API_KEY).update(body).digest("hex");
}

// Mirrors the real production payload shape (snake_case names, web_app_link).
function makeEnvelope(
  partial: Partial<TributeWebhookEnvelope> = {}
): TributeWebhookEnvelope {
  return {
    name: "new_subscription",
    created_at: "2026-07-11T12:44:17.787225Z",
    sent_at: "2026-07-11T12:44:17.888898Z",
    payload: {
      type: "regular",
      subscription_name: "Starter Weekly",
      subscription_id: "219056",
      period_id: "396297",
      period: "weekly",
      price: 300,
      amount: 210,
      currency: "eur",
      channel_id: "479363",
      channel_name: "ClipCliap News",
      web_app_link: "https://t.me/tribute/app?startapp=sUZa",
      telegram_user_id: 332548055,
      telegram_username: "Maxkornilo",
      expires_at: "2026-07-18T12:44:17.751630949Z",
    },
    ...partial,
  };
}

describe("tribute.service signature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"hello":"world"}';
    expect(verifyTributeSignature(body, signedBody(body), API_KEY)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"hello":"world"}';
    const tampered = '{"hello":"tampered"}';
    expect(verifyTributeSignature(tampered, signedBody(body), API_KEY)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyTributeSignature("{}", null, API_KEY)).toBe(false);
  });

  it("accepts uppercase hex signatures (case-insensitive normalize)", () => {
    const body = '{"a":1}';
    expect(verifyTributeSignature(body, signedBody(body).toUpperCase(), API_KEY)).toBe(true);
  });
});

describe("canonicalTributeEventName", () => {
  it("normalizes snake_case, camelCase, and punctuation to one form", () => {
    expect(canonicalTributeEventName("new_subscription")).toBe("newsubscription");
    expect(canonicalTributeEventName("newSubscription")).toBe("newsubscription");
    expect(canonicalTributeEventName("New-Subscription")).toBe("newsubscription");
    expect(canonicalTributeEventName("cancelled_subscription")).toBe("cancelledsubscription");
  });
});

describe("hashTributeEvent", () => {
  it("is identical across retries with a different sent_at", () => {
    const a = makeEnvelope({ sent_at: "2026-07-11T12:44:17.888Z" });
    const b = makeEnvelope({ sent_at: "2026-07-11T12:49:17.100Z" }); // retry, new sent_at
    expect(hashTributeEvent(a)).toBe(hashTributeEvent(b));
  });

  it("is identical for snake_case and camelCase of the same event", () => {
    const a = makeEnvelope({ name: "new_subscription" });
    const b = makeEnvelope({ name: "newSubscription" });
    expect(hashTributeEvent(a)).toBe(hashTributeEvent(b));
  });

  it("differs across distinct periods of the same subscription", () => {
    const a = makeEnvelope();
    const b = makeEnvelope({ payload: { ...makeEnvelope().payload, period_id: "396298" } });
    expect(hashTributeEvent(a)).not.toBe(hashTributeEvent(b));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: FAIL — `canonicalTributeEventName` is not exported, and `hashTributeEvent` still includes `sent_at`.

- [ ] **Step 3: Add `canonicalTributeEventName` and rewrite `hashTributeEvent`**

In `tribute.service.ts`, add the helper near the top (after the `TRIBUTE_SIGNATURE_HEADER` const) and replace the existing `hashTributeEvent` (lines 71-80):

```ts
export function canonicalTributeEventName(name: string): string {
  // "new_subscription" | "newSubscription" | "New-Subscription" -> "newsubscription"
  return name.toLowerCase().replace(/[_\s-]/g, "");
}

export function hashTributeEvent(envelope: TributeWebhookEnvelope): string {
  const p = envelope.payload;
  // Stable across Tribute retries: excludes sent_at (which changes per retry),
  // keyed on the canonical event + subscriber + period + event creation time.
  const key = [
    canonicalTributeEventName(envelope.name),
    p.telegram_user_id ?? "",
    p.subscription_id ?? "",
    p.period_id ?? "",
    envelope.created_at ?? "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}
```

- [ ] **Step 4: Run the tests to verify signature/normalization/hash pass**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: the `signature`, `canonicalTributeEventName`, and `hashTributeEvent` describes PASS. (Other imports referenced later don't exist yet, but this file currently imports only the four symbols above, so the run is green.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/tribute.service.ts packages/shared/src/services/__tests__/tribute.service.test.ts
git commit -m "feat(tribute): canonical event-name normalization + retry-stable hash"
```

---

## Task 3: Product index (startapp + subscription_name), collision-safe env loader

**Files:**
- Modify: `packages/shared/src/services/tribute.service.ts`
- Modify: `packages/shared/src/services/__tests__/tribute.service.test.ts` (append)
- Modify: `.env.example`

- [ ] **Step 1: Append product-index tests**

Add to `tribute.service.test.ts`. First extend the import line to add the new symbols:

```ts
import {
  canonicalTributeEventName,
  extractStartapp,
  hashTributeEvent,
  loadTributeProductIndexFromEnv,
  normalizeProductName,
  resolveProductBinding,
  verifyTributeSignature,
  type TributeProductIndex,
  type TributeWebhookEnvelope,
} from "../tribute.service";
```

Then append these describes at the end of the file:

```ts
const FULL_ENV = {
  TRIBUTE_PRODUCT_STARTER_WEEKLY_ID: "UZa",
  TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME: "Starter Weekly",
  TRIBUTE_PRODUCT_STARTER_MONTHLY_ID: "UZd",
  TRIBUTE_PRODUCT_STARTER_MONTHLY_NAME: "Starter Monthly",
  TRIBUTE_PRODUCT_PLUS_MONTHLY_ID: "UZh",
  TRIBUTE_PRODUCT_PLUS_MONTHLY_NAME: "Plus Monthly",
  TRIBUTE_PRODUCT_MAX_MONTHLY_ID: "UZi",
  TRIBUTE_PRODUCT_MAX_MONTHLY_NAME: "Max Monthly",
} as unknown as NodeJS.ProcessEnv;

describe("extractStartapp", () => {
  it("returns the startapp param", () => {
    expect(extractStartapp("https://t.me/tribute/app?startapp=sUZa")).toBe("sUZa");
  });
  it("returns undefined for missing/empty/malformed links", () => {
    expect(extractStartapp(undefined)).toBeUndefined();
    expect(extractStartapp("")).toBeUndefined();
    expect(extractStartapp("https://t.me/tribute/app?startapp=")).toBeUndefined();
    expect(extractStartapp("not a url")).toBeUndefined();
  });
});

describe("normalizeProductName", () => {
  it("lowercases and strips punctuation/whitespace, keeping unicode letters", () => {
    expect(normalizeProductName("Starter Weekly")).toBe("starterweekly");
    expect(normalizeProductName("  Plus-Monthly ")).toBe("plusmonthly");
    expect(normalizeProductName("Стартер Недельный")).toBe("стартернедельный");
  });
});

describe("loadTributeProductIndexFromEnv", () => {
  it("indexes each tier by startapp id and normalized name", () => {
    const index = loadTributeProductIndexFromEnv(FULL_ENV);
    expect(index.byStartappId.get("UZa")).toEqual({ plan: "STARTER", billingCycle: "WEEKLY" });
    expect(index.byNormalizedName.get("startermonthly")).toEqual({ plan: "STARTER", billingCycle: "MONTHLY" });
  });

  it("throws when two tiers collide on the same id", () => {
    expect(() =>
      loadTributeProductIndexFromEnv({
        ...FULL_ENV,
        TRIBUTE_PRODUCT_PLUS_MONTHLY_ID: "UZa", // collides with STARTER_WEEKLY
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/duplicate/i);
  });

  it("throws in production when a configured tier is missing its _NAME", () => {
    const env = { ...FULL_ENV, NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    delete (env as Record<string, unknown>).TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME;
    expect(() => loadTributeProductIndexFromEnv(env)).toThrow(/production/i);
  });
});

describe("resolveProductBinding", () => {
  const index = loadTributeProductIndexFromEnv(FULL_ENV);
  const base = makeEnvelope().payload;

  it("resolves via the s-stripped startapp code", () => {
    expect(resolveProductBinding(base, index)).toEqual({
      binding: { plan: "STARTER", billingCycle: "WEEKLY" },
      resolvedBy: "startapp_stripped",
    });
  });

  it("resolves via an exact (non-prefixed) startapp code", () => {
    const payload = { ...base, web_app_link: "https://t.me/tribute/app?startapp=UZd" };
    expect(resolveProductBinding(payload, index)?.resolvedBy).toBe("startapp_exact");
  });

  it("falls back to subscription_name when web_app_link is absent", () => {
    const payload = { ...base, web_app_link: undefined, subscription_name: "Plus Monthly" };
    expect(resolveProductBinding(payload, index)).toEqual({
      binding: { plan: "PLUS", billingCycle: "MONTHLY" },
      resolvedBy: "subscription_name",
    });
  });

  it("falls back to subscription_name when web_app_link is malformed", () => {
    const payload = { ...base, web_app_link: "not a url", subscription_name: "Max Monthly" };
    expect(resolveProductBinding(payload, index)?.binding).toEqual({ plan: "MAX", billingCycle: "MONTHLY" });
  });

  it("is case-sensitive on the startapp id and returns undefined when nothing matches", () => {
    const payload = { ...base, web_app_link: "https://t.me/tribute/app?startapp=uza", subscription_name: "Unknown" };
    expect(resolveProductBinding(payload, index)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: FAIL — `extractStartapp`, `normalizeProductName`, `loadTributeProductIndexFromEnv`, `resolveProductBinding`, `TributeProductIndex` are undefined.

- [ ] **Step 3: Implement the product index**

In `tribute.service.ts`: (a) keep `TributePlanBinding`; (b) replace the `TributeProductMap` type and `loadTributeProductMapFromEnv` (lines 46, 240-255) with the index below; (c) add the helpers.

```ts
export interface TributeProductIndex {
  byStartappId: Map<string, TributePlanBinding>;
  byNormalizedName: Map<string, TributePlanBinding>;
}

export type ProductResolvedBy = "startapp_exact" | "startapp_stripped" | "subscription_name";

export function extractStartapp(webAppLink?: string | null): string | undefined {
  if (!webAppLink?.trim()) return undefined;
  try {
    return new URL(webAppLink).searchParams.get("startapp")?.trim() || undefined;
  } catch {
    return undefined; // malformed URL -> caller falls back to subscription_name
  }
}

export function normalizeProductName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const TRIBUTE_TIERS: Array<{ idKey: string; nameKey: string; plan: Plan; billingCycle: BillingCycle }> = [
  { idKey: "TRIBUTE_PRODUCT_STARTER_WEEKLY_ID", nameKey: "TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME", plan: "STARTER", billingCycle: "WEEKLY" },
  { idKey: "TRIBUTE_PRODUCT_STARTER_MONTHLY_ID", nameKey: "TRIBUTE_PRODUCT_STARTER_MONTHLY_NAME", plan: "STARTER", billingCycle: "MONTHLY" },
  { idKey: "TRIBUTE_PRODUCT_PLUS_MONTHLY_ID", nameKey: "TRIBUTE_PRODUCT_PLUS_MONTHLY_NAME", plan: "PLUS", billingCycle: "MONTHLY" },
  { idKey: "TRIBUTE_PRODUCT_MAX_MONTHLY_ID", nameKey: "TRIBUTE_PRODUCT_MAX_MONTHLY_NAME", plan: "MAX", billingCycle: "MONTHLY" },
];

export function loadTributeProductIndexFromEnv(env: NodeJS.ProcessEnv): TributeProductIndex {
  const byStartappId = new Map<string, TributePlanBinding>();
  const byNormalizedName = new Map<string, TributePlanBinding>();
  const isProd = env.NODE_ENV === "production";

  const add = (map: Map<string, TributePlanBinding>, key: string, binding: TributePlanBinding, label: string) => {
    const existing = map.get(key);
    if (existing && (existing.plan !== binding.plan || existing.billingCycle !== binding.billingCycle)) {
      throw new Error(`Duplicate Tribute product mapping key "${key}" (${label})`);
    }
    map.set(key, binding);
  };

  for (const tier of TRIBUTE_TIERS) {
    const id = env[tier.idKey]?.trim();
    const name = env[tier.nameKey]?.trim();
    if (!id) continue; // tier not configured
    const binding: TributePlanBinding = { plan: tier.plan, billingCycle: tier.billingCycle };
    add(byStartappId, id, binding, `${tier.plan}/${tier.billingCycle}`);
    if (name) {
      add(byNormalizedName, normalizeProductName(name), binding, `${tier.plan}/${tier.billingCycle}`);
    } else if (isProd) {
      throw new Error(`Tribute product ${tier.plan}/${tier.billingCycle} is missing ${tier.nameKey} (required in production)`);
    }
  }

  return { byStartappId, byNormalizedName };
}

export function resolveProductBinding(
  payload: TributeSubscriptionPayload,
  index: TributeProductIndex
): { binding: TributePlanBinding; resolvedBy: ProductResolvedBy } | undefined {
  const startapp = extractStartapp(payload.web_app_link);
  if (startapp) {
    const exact = index.byStartappId.get(startapp);
    if (exact) return { binding: exact, resolvedBy: "startapp_exact" };
    if (startapp.startsWith("s")) {
      const stripped = index.byStartappId.get(startapp.slice(1));
      if (stripped) return { binding: stripped, resolvedBy: "startapp_stripped" };
    }
  }
  if (payload.subscription_name) {
    const byName = index.byNormalizedName.get(normalizeProductName(payload.subscription_name));
    if (byName) return { binding: byName, resolvedBy: "subscription_name" };
  }
  return undefined;
}
```

Also delete the now-unused `TributeProductMap` export and any remaining references to it in this file (the `applySubscription` signature is rewritten in Task 4).

- [ ] **Step 4: Run to verify pass**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: all currently-defined describes PASS. (The file does not yet import `processTributeEvent`/`dispatchTributeEvent`, added in Tasks 4-5.)

- [ ] **Step 5: Document the env vars**

In `.env.example`, directly below the existing `TRIBUTE_PRODUCT_*_ID` lines, add:

```
# Human-readable product names — fallback mapping when web_app_link is absent.
# REQUIRED in production (startup validation fails without them).
TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME=Starter Weekly
TRIBUTE_PRODUCT_STARTER_MONTHLY_NAME=Starter Monthly
TRIBUTE_PRODUCT_PLUS_MONTHLY_NAME=Plus Monthly
TRIBUTE_PRODUCT_MAX_MONTHLY_NAME=Max Monthly
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/tribute.service.ts packages/shared/src/services/__tests__/tribute.service.test.ts .env.example
git commit -m "feat(tribute): collision-safe product index via web_app_link + subscription_name"
```

---

## Task 4: Handlers + `dispatchTributeEvent` (stale guards, best-effort notify)

**Files:**
- Modify: `packages/shared/src/services/tribute.service.ts`
- Modify: `packages/shared/src/services/__tests__/tribute.service.test.ts` (append)

- [ ] **Step 1: Append dispatch/handler tests**

Add `dispatchTributeEvent` to the import block, then append:

```ts
describe("dispatchTributeEvent", () => {
  const index = loadTributeProductIndexFromEnv(FULL_ENV);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notify.mockResolvedValue(undefined);
    mocks.recordCommission.mockResolvedValue(undefined);
  });

  it("activates the plan on new_subscription and asserts full-ms period end", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    const outcome = await dispatchTributeEvent(makeEnvelope(), index);
    expect(outcome).toEqual({ status: "applied", userId: "user_1", plan: "STARTER", eventName: "new_subscription" });
    expect(mocks.userUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { telegramId: "332548055" },
        update: expect.objectContaining({
          plan: "STARTER",
          billingCycle: "WEEKLY",
          currentPeriodEnd: new Date("2026-07-18T12:44:17.751Z"),
          subscriptionStatus: "ACTIVE",
          tributeSubscriptionId: "219056",
        }),
      })
    );
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("activates via subscription_name when web_app_link is missing", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    const env = makeEnvelope();
    const outcome = await dispatchTributeEvent(
      { ...env, payload: { ...env.payload, web_app_link: undefined } },
      index
    );
    expect(outcome).toMatchObject({ status: "applied", plan: "STARTER" });
  });

  it("returns unmapped_subscription and does not upsert when nothing matches", async () => {
    const env = makeEnvelope();
    const outcome = await dispatchTributeEvent(
      { ...env, payload: { ...env.payload, web_app_link: "https://t.me/tribute/app?startapp=zzz", subscription_name: "Nope" } },
      index
    );
    expect(outcome).toEqual({ status: "unmapped_subscription", subscriptionId: "219056" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });

  it("does not shrink currentPeriodEnd (stale renewal)", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user_1", currentPeriodEnd: new Date("2026-08-01T00:00:00Z") });
    const outcome = await dispatchTributeEvent(makeEnvelope({ name: "renewed_subscription" }), index);
    expect(outcome).toEqual({ status: "stale_event", userId: "user_1" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });

  it("does not roll back activation when the notification throws", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    mocks.userUpsert.mockResolvedValueOnce({ id: "user_1" });
    mocks.notify.mockRejectedValueOnce(new Error("telegram down"));
    const outcome = await dispatchTributeEvent(makeEnvelope(), index);
    expect(outcome).toMatchObject({ status: "applied" });
  });

  it("cancels with grace when expires_at is in the future and the subscription matches", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user_1", tributeSubscriptionId: "219056" });
    mocks.userUpdate.mockResolvedValueOnce({});
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const env = makeEnvelope({ name: "cancelled_subscription" });
    const outcome = await dispatchTributeEvent(
      { ...env, payload: { ...env.payload, expires_at: future } },
      index
    );
    expect(outcome).toEqual({ status: "cancelled", userId: "user_1", eventName: "cancelled_subscription" });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: expect.objectContaining({ subscriptionStatus: "CANCELED_GRACE" }),
    });
  });

  it("ignores a cancellation for a different subscription (stale)", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user_1", tributeSubscriptionId: "999999" });
    const outcome = await dispatchTributeEvent(makeEnvelope({ name: "cancelled_subscription" }), index);
    expect(outcome).toEqual({ status: "stale_cancellation", userId: "user_1" });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("ignores unrecognized event names", async () => {
    const outcome = await dispatchTributeEvent(makeEnvelope({ name: "physical_order_shipped" }), index);
    expect(outcome).toEqual({ status: "ignored_event", name: "physical_order_shipped" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: FAIL — `dispatchTributeEvent` is undefined.

- [ ] **Step 3: Extend the outcome type and rewrite handlers + dispatch**

In `tribute.service.ts`, extend `TributeProcessOutcome`:

```ts
export type TributeProcessOutcome =
  | { status: "duplicate" }
  | { status: "unmapped_subscription"; subscriptionId: string }
  | { status: "ignored_event"; name: string }
  | { status: "applied"; userId: string; plan: Plan; eventName: string }
  | { status: "cancelled"; userId: string; eventName: string }
  | { status: "stale_event"; userId: string }
  | { status: "stale_cancellation"; userId: string };
```

Rewrite `applySubscription` (old lines 118-204) to take the index, read the user first for the stale guard, use the resolver, and wrap the notification:

```ts
async function applySubscription(
  envelope: TributeWebhookEnvelope,
  index: TributeProductIndex
): Promise<TributeProcessOutcome> {
  const payload = envelope.payload;
  const resolved = resolveProductBinding(payload, index);
  if (!resolved) {
    console.error("[tribute] product mapping failed", {
      eventName: envelope.name,
      telegramUserId: payload.telegram_user_id,
      subscriptionId: payload.subscription_id,
      periodId: payload.period_id,
      channelId: payload.channel_id,
      subscriptionName: payload.subscription_name,
      startapp: extractStartapp(payload.web_app_link),
    });
    return { status: "unmapped_subscription", subscriptionId: String(payload.subscription_id) };
  }
  const { binding, resolvedBy } = resolved;
  if (resolvedBy === "subscription_name") {
    console.info("[tribute] product resolved via subscription_name (startapp mapping missed)", {
      subscriptionName: payload.subscription_name,
    });
  }

  const telegramId = String(payload.telegram_user_id);
  const expiresAt = new Date(payload.expires_at);
  const tributeSubscriptionId = String(payload.subscription_id);

  const existing = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, currentPeriodEnd: true },
  });
  if (existing?.currentPeriodEnd && expiresAt < existing.currentPeriodEnd) {
    return { status: "stale_event", userId: existing.id };
  }

  const user = await prisma.user.upsert({
    where: { telegramId },
    update: {
      plan: binding.plan,
      billingCycle: binding.billingCycle,
      currentPeriodEnd: expiresAt,
      subscriptionStatus: "ACTIVE",
      tributeSubscriptionId,
      dunningSince: null,
      graceEndsAt: null,
    },
    create: {
      telegramId,
      name: payload.telegram_username ?? `Telegram ${telegramId}`,
      plan: binding.plan,
      billingCycle: binding.billingCycle,
      currentPeriodEnd: expiresAt,
      subscriptionStatus: "ACTIVE",
      tributeSubscriptionId,
    },
  });

  // Referral accrual is non-critical: never let it fail the activation.
  try {
    const amount = payload.amount ?? payload.price ?? 0;
    if (amount > 0) {
      const currency = (payload.currency ?? "usd").toLowerCase();
      const externalPaymentId = payload.period_id ?? `${tributeSubscriptionId}:${payload.expires_at}`;
      const { recordCommission } = await import("./referral.service");
      const { exchangeRateToUsd, REFERRAL_CONFIG } = await import("../config/referral");
      const rate = exchangeRateToUsd(currency);
      const grossAmountUsd = (amount / 100) * rate;
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
  } catch (err) {
    console.error("[referral] accrual failed:", err);
  }

  // Notification is best-effort: a Telegram failure must NOT roll back paid access.
  try {
    await notifyPaymentEvent(user.id, {
      kind: envelope.name && canonicalTributeEventName(envelope.name) === "newsubscription"
        ? "subscription_activated"
        : "subscription_renewed",
      plan: binding.plan,
      periodEnd: expiresAt,
    });
  } catch (err) {
    console.warn("[tribute] notification failed (activation stands):", err instanceof Error ? err.message : err);
  }

  return { status: "applied", userId: user.id, plan: binding.plan, eventName: envelope.name };
}
```

Rewrite `applyCancellation` (old lines 206-238) to add the subscription-match guard:

```ts
async function applyCancellation(
  envelope: TributeWebhookEnvelope
): Promise<TributeProcessOutcome> {
  const payload = envelope.payload;
  const telegramId = String(payload.telegram_user_id);
  const expiresAt = new Date(payload.expires_at);

  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    return { status: "ignored_event", name: envelope.name };
  }
  // A late cancellation for a superseded subscription must not cancel a newer one.
  if (
    user.tributeSubscriptionId &&
    String(user.tributeSubscriptionId) !== String(payload.subscription_id)
  ) {
    return { status: "stale_cancellation", userId: user.id };
  }

  const stillActive = expiresAt > new Date();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: stillActive ? "CANCELED_GRACE" : "CANCELED",
      graceEndsAt: stillActive ? expiresAt : null,
    },
  });

  try {
    await notifyPaymentEvent(user.id, {
      kind: "subscription_canceled",
      graceEndsAt: stillActive ? expiresAt : null,
    });
  } catch (err) {
    console.warn("[tribute] cancel notification failed:", err instanceof Error ? err.message : err);
  }

  return { status: "cancelled", userId: user.id, eventName: envelope.name };
}
```

Add the pure dispatcher (this is what the ingress state-machine and the replay script both call):

```ts
export async function dispatchTributeEvent(
  envelope: TributeWebhookEnvelope,
  index: TributeProductIndex
): Promise<TributeProcessOutcome> {
  switch (canonicalTributeEventName(envelope.name)) {
    case "newsubscription":
    case "renewedsubscription":
      return applySubscription(envelope, index);
    case "cancelledsubscription":
    case "canceledsubscription":
      return applyCancellation(envelope);
    default:
      return { status: "ignored_event", name: envelope.name };
  }
}
```

Note: the top-of-file import `import { notifyPaymentEvent } from "./telegram-notification.service";` already exists (line 3) — keep it; the tests mock that module.

- [ ] **Step 4: Run to verify pass**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: the `dispatchTributeEvent` describe PASSES along with all prior describes.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/tribute.service.ts packages/shared/src/services/__tests__/tribute.service.test.ts
git commit -m "feat(tribute): dispatch layer with stale guards and best-effort notifications"
```

---

## Task 5: Ingress state-machine `processTributeEvent`

**Files:**
- Modify: `packages/shared/src/services/tribute.service.ts`
- Modify: `packages/shared/src/services/__tests__/tribute.service.test.ts` (append)

- [ ] **Step 1: Append inbox tests**

Add `processTributeEvent` to the import block, then append:

```ts
describe("processTributeEvent (inbox state-machine)", () => {
  const index = loadTributeProductIndexFromEnv(FULL_ENV);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notify.mockResolvedValue(undefined);
    mocks.recordCommission.mockResolvedValue(undefined);
    mocks.eventCreate.mockResolvedValue({}); // fresh RECEIVED row inserted
    mocks.eventUpdateMany.mockResolvedValue({ count: 1 }); // claim succeeds
    mocks.eventUpdate.mockResolvedValue({});
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userUpsert.mockResolvedValue({ id: "user_1" });
  });

  it("claims a fresh event, applies it, and marks the row APPLIED", async () => {
    const outcome = await processTributeEvent(makeEnvelope(), index);
    expect(outcome).toMatchObject({ status: "applied", plan: "STARTER" });
    expect(mocks.eventUpdateMany).toHaveBeenCalledWith({
      where: { eventHash: expect.any(String), status: { in: ["RECEIVED", "FAILED"] } },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
    expect(mocks.eventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) })
    );
  });

  it("returns duplicate for an already-APPLIED event and does not re-apply", async () => {
    mocks.eventCreate.mockRejectedValueOnce(new Error("P2002 unique"));
    mocks.eventFindUnique.mockResolvedValueOnce({ status: "APPLIED" });
    const outcome = await processTributeEvent(makeEnvelope(), index);
    expect(outcome).toEqual({ status: "duplicate" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("returns duplicate when another worker holds the claim (updateMany count 0)", async () => {
    mocks.eventCreate.mockRejectedValueOnce(new Error("P2002 unique"));
    mocks.eventFindUnique.mockResolvedValueOnce({ status: "RECEIVED" });
    mocks.eventUpdateMany.mockResolvedValueOnce({ count: 0 });
    const outcome = await processTributeEvent(makeEnvelope(), index);
    expect(outcome).toEqual({ status: "duplicate" });
    expect(mocks.userUpsert).not.toHaveBeenCalled();
  });

  it("re-processes a previously FAILED event once config is fixed", async () => {
    mocks.eventCreate.mockRejectedValueOnce(new Error("P2002 unique"));
    mocks.eventFindUnique.mockResolvedValueOnce({ status: "FAILED" });
    const outcome = await processTributeEvent(makeEnvelope(), index);
    expect(outcome).toMatchObject({ status: "applied" });
  });

  it("marks the row FAILED on an unmapped event", async () => {
    const env = makeEnvelope();
    const outcome = await processTributeEvent(
      { ...env, payload: { ...env.payload, web_app_link: "https://t.me/tribute/app?startapp=zzz", subscription_name: "Nope" } },
      index
    );
    expect(outcome).toMatchObject({ status: "unmapped_subscription" });
    expect(mocks.eventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("marks the row IGNORED on an unrecognized event", async () => {
    const outcome = await processTributeEvent(makeEnvelope({ name: "physical_order_shipped" }), index);
    expect(outcome).toMatchObject({ status: "ignored_event" });
    expect(mocks.eventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "IGNORED" }) })
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: FAIL — the rewritten `processTributeEvent` doesn't exist yet (old one referenced `productMap`/removed types).

- [ ] **Step 3: Rewrite `processTributeEvent`**

Replace the old `processTributeEvent` (old lines 82-116) with the state-machine below. Keep the `import { createHash, createHmac, timingSafeEqual } from "crypto";` line and add `TributeWebhookStatus` to the `@prisma/client` import at the top:

```ts
import type { Plan, BillingCycle, TributeWebhookStatus } from "@prisma/client";
```

```ts
function terminalStatusFor(outcome: TributeProcessOutcome): TributeWebhookStatus {
  switch (outcome.status) {
    case "applied":
    case "cancelled":
    case "stale_event":
    case "stale_cancellation":
      return "APPLIED";
    case "ignored_event":
      return "IGNORED";
    case "unmapped_subscription":
    case "duplicate": // not reachable here; kept for exhaustiveness
      return "FAILED";
  }
}

export async function processTributeEvent(
  envelope: TributeWebhookEnvelope,
  index: TributeProductIndex
): Promise<TributeProcessOutcome> {
  const eventHash = hashTributeEvent(envelope);

  // 1. Ensure an inbox row exists (status RECEIVED). Insert; on unique conflict, inspect.
  let inserted = true;
  try {
    await prisma.tributeWebhookEvent.create({
      data: { eventHash, name: envelope.name, payload: envelope as unknown as object, status: "RECEIVED" },
    });
  } catch {
    inserted = false;
  }

  if (!inserted) {
    const existing = await prisma.tributeWebhookEvent.findUnique({ where: { eventHash } });
    // Terminal or in-flight -> idempotent no-op. Only RECEIVED/FAILED are (re)claimable.
    if (!existing || existing.status === "APPLIED" || existing.status === "IGNORED" || existing.status === "PROCESSING") {
      return { status: "duplicate" };
    }
  }

  // 2. Atomically claim: RECEIVED/FAILED -> PROCESSING (and bump attempts).
  const claim = await prisma.tributeWebhookEvent.updateMany({
    where: { eventHash, status: { in: ["RECEIVED", "FAILED"] } },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  if (claim.count !== 1) {
    return { status: "duplicate" }; // another delivery claimed it first
  }

  // 3. Dispatch to business handlers.
  let outcome: TributeProcessOutcome;
  try {
    outcome = await dispatchTributeEvent(envelope, index);
  } catch (err) {
    await prisma.tributeWebhookEvent.update({
      where: { eventHash },
      data: { status: "FAILED", lastError: err instanceof Error ? err.message : String(err) },
    });
    throw err; // route returns 5xx -> Tribute retries
  }

  // 4. Persist terminal status.
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
```

- [ ] **Step 4: Run to verify pass**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: ALL describes PASS.

- [ ] **Step 5: Typecheck the shared package**

Run: `docker compose exec -w /app web npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS. If it flags a leftover reference to `TributeProductMap`/`loadTributeProductMapFromEnv`, remove it (the only remaining consumer is the route, fixed in Task 6).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/tribute.service.ts packages/shared/src/services/__tests__/tribute.service.test.ts
git commit -m "feat(tribute): durable webhook inbox state-machine with retryable failures"
```

---

## Task 6: Web route — load index + map outcome to HTTP status

**Files:**
- Modify: `apps/web/app/api/payments/tribute/webhook/route.ts`

- [ ] **Step 1: Update imports and processing block**

Replace the import of `loadTributeProductMapFromEnv` with `loadTributeProductIndexFromEnv`, and replace the `try { const outcome = ... }` block (lines 62-74) so failures return a retryable 5xx:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  TRIBUTE_SIGNATURE_HEADER,
  loadTributeProductIndexFromEnv,
  processTributeEvent,
  verifyTributeSignature,
  type TributeWebhookEnvelope,
} from "@clipclap/shared";
```

```ts
  const index = loadTributeProductIndexFromEnv(process.env);

  try {
    const outcome = await processTributeEvent(envelope, index);
    console.log("[tribute-webhook] outcome", outcome);
    // Unmapped events are a config problem, not a client error: return 5xx so
    // Tribute retries (the inbox row is FAILED and reprocessable after a fix).
    const retryable = outcome.status === "unmapped_subscription";
    return NextResponse.json({ ok: !retryable, outcome }, { status: retryable ? 500 : 200 });
  } catch (error) {
    console.error("[tribute-webhook] processing failed:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
```

- [ ] **Step 2: Typecheck the web app**

Run: `docker compose exec -w /app web npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/payments/tribute/webhook/route.ts
git commit -m "feat(tribute): route loads product index and returns retryable 5xx on unmapped events"
```

---

## Task 7: Compensation replay script

**Files:**
- Create: `apps/worker/src/scripts/replay-tribute-event.ts`

This script is run manually inside a worker container (which has `tsx`, `@clipclap/shared`, and the `TRIBUTE_*`/`TELEGRAM_*` env). It never deletes the stored event, is idempotent, and applies the decided compensation (full 7 days from the activation instant).

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/replay-tribute-event.ts`:

```ts
/**
 * Replay a stored Tribute webhook event to activate a subscription that a bug
 * dropped, and compensate the user for lost access.
 *
 * Idempotent and non-destructive: it never deletes the stored inbox row, and a
 * second run is a no-op once the user already holds the expected subscription.
 *
 * Usage (inside a worker container, which has tsx + the TRIBUTE_/TELEGRAM_ env):
 *   docker compose exec -w /app/apps/worker worker-render \
 *     npx tsx src/scripts/replay-tribute-event.ts --event-hash=<hash> --dry-run
 *   docker compose exec -w /app/apps/worker worker-render \
 *     npx tsx src/scripts/replay-tribute-event.ts --event-hash=<hash> --apply
 */
import {
  prisma,
  dispatchTributeEvent,
  loadTributeProductIndexFromEnv,
  resolveProductBinding,
  type TributeWebhookEnvelope,
} from "@clipclap/shared";

const COMPENSATION_DAYS = 7;
const DAY_MS = 86_400_000;

function getFlag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const eventHash = getFlag("event-hash");
  const apply = hasFlag("apply");
  const dryRun = hasFlag("dry-run") || !apply;
  if (!eventHash) throw new Error("Missing --event-hash=<hash>");

  const row = await prisma.tributeWebhookEvent.findUnique({ where: { eventHash } });
  if (!row) throw new Error(`No stored event with eventHash=${eventHash}`);

  const envelope = row.payload as unknown as TributeWebhookEnvelope;
  const payload = envelope.payload;
  const telegramId = String(payload.telegram_user_id);
  const index = loadTributeProductIndexFromEnv(process.env);
  const resolved = resolveProductBinding(payload, index);

  const before = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, plan: true, subscriptionStatus: true, currentPeriodEnd: true, tributeSubscriptionId: true },
  });

  const incomingExpiresAt = new Date(payload.expires_at);
  console.log("[replay] event", { eventHash, name: envelope.name, status: row.status, telegramId, subscriptionId: payload.subscription_id });
  console.log("[replay] resolved binding", resolved ?? "UNMAPPED");
  console.log("[replay] user before", before ?? "NO USER ROW");

  if (!resolved) throw new Error("Cannot replay: product binding did not resolve. Fix env config first.");

  // Idempotency guard: already has an equal-or-newer active subscription.
  if (
    before?.subscriptionStatus === "ACTIVE" &&
    before.plan !== "NONE" &&
    before.currentPeriodEnd &&
    before.currentPeriodEnd >= incomingExpiresAt
  ) {
    console.log("Event already applied and user already has the expected subscription. No action taken.");
    return;
  }

  const activationInstant = new Date();
  const compensatedEnd = new Date(activationInstant.getTime() + COMPENSATION_DAYS * DAY_MS);
  console.log("[replay] would set currentPeriodEnd (compensation)", compensatedEnd.toISOString());

  if (dryRun) {
    console.log("[replay] DRY RUN — no writes performed. Re-run with --apply to execute.");
    return;
  }

  // Activate via the real handler path (sets plan/status/subscriptionId, sends notification).
  const outcome = await dispatchTributeEvent(envelope, index);
  console.log("[replay] dispatch outcome", outcome);
  if (outcome.status !== "applied") {
    console.log("[replay] activation not performed (non-applied outcome); no compensation written.");
    return;
  }

  // Explicit, auditable compensation override on top of the pure handler.
  await prisma.user.update({
    where: { telegramId },
    data: { currentPeriodEnd: compensatedEnd },
  });
  await prisma.tributeWebhookEvent.update({
    where: { eventHash },
    data: { status: "APPLIED", outcome: "applied_with_compensation", processedAt: new Date() },
  });

  const after = await prisma.user.findUnique({
    where: { telegramId },
    select: { plan: true, billingCycle: true, subscriptionStatus: true, currentPeriodEnd: true, tributeSubscriptionId: true },
  });
  console.log("[replay] user after", after);
  console.log("[replay] done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[replay] failed:", err);
    process.exit(1);
  });
```

- [ ] **Step 2: Typecheck the worker**

Run: `docker compose exec -w /app web npx tsc -p apps/worker/tsconfig.typecheck.json --noEmit`
Expected: PASS. (Confirms `dispatchTributeEvent`, `resolveProductBinding`, and `loadTributeProductIndexFromEnv` are exported from `@clipclap/shared` and the script is well-typed. If `@clipclap/shared` does not re-export these, add them — the service already `export`s each; `packages/shared/src/services/index.ts` re-exports the whole module via `export * from "./tribute.service"`, so no barrel change is needed.)

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/scripts/replay-tribute-event.ts
git commit -m "feat(tribute): idempotent replay/compensation script for dropped events"
```

---

## Task 8: Full verification + deployment runbook

No code changes — this task applies the migration, runs the full suite, and executes the compensation. Run each step and confirm the stated output before moving on.

- [ ] **Step 1: Full test suite (shared)**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src`
Expected: PASS, including all `tribute.service.test.ts` describes.

- [ ] **Step 2: Typecheck shared + web + worker**

Run:
```bash
docker compose exec -w /app web npx tsc -p packages/shared/tsconfig.json --noEmit
docker compose exec -w /app web npx tsc -p apps/web/tsconfig.json --noEmit
docker compose exec -w /app web npx tsc -p apps/worker/tsconfig.typecheck.json --noEmit
```
Expected: all PASS.

- [ ] **Step 3: Confirm the production `_NAME` env vars are present**

Run: `docker compose exec -T web sh -lc 'for v in STARTER_WEEKLY STARTER_MONTHLY PLUS_MONTHLY MAX_MONTHLY; do eval echo $v=\${TRIBUTE_PRODUCT_${v}_NAME:-MISSING}; done'`
Expected: all four print a name, none `MISSING`. If any are missing, add them to `/srv/dev/clipclap.io/.env` and `docker compose up -d web worker-*` before continuing (startup validation in `loadTributeProductIndexFromEnv` will otherwise throw in production).

- [ ] **Step 4: Apply the migration**

Run: `docker compose exec -w /app web npx prisma migrate deploy`
Expected: "1 migration applied" (`20260713120000_tribute_webhook_inbox`).

Verify the columns exist:
Run: `docker compose exec -T postgres psql -U clipclap -d clipclap -c "\d tribute_webhook_events"`
Expected: `status`, `outcome`, `attempts`, `lastError`, `processedAt`, `updatedAt` columns present.

- [ ] **Step 5: Rebuild/restart the services so the new code is live**

Per the dev-workflow note, source is bind-mounted and hot-reloads; restart to be safe and to re-run startup env validation:
Run: `docker compose restart web worker-download worker-transcribe worker-analyze worker-render worker-finalize`
Expected: containers healthy (`docker compose ps` all `running`). Check `docker compose logs --tail=30 web` shows no Tribute config error.

- [ ] **Step 6: Find the stored event hash for @Maxkornilo**

Run: `docker compose exec -T postgres psql -U clipclap -d clipclap -c "SELECT \"eventHash\", name, status FROM tribute_webhook_events;"`
Expected: one row, `name=new_subscription`. Copy its `eventHash`.

- [ ] **Step 7: Compensation dry-run**

Run: `docker compose exec -w /app/apps/worker worker-render npx tsx src/scripts/replay-tribute-event.ts --event-hash=<hash> --dry-run`
Expected: prints resolved binding `{ plan: STARTER, billingCycle: WEEKLY, resolvedBy: startapp_stripped }`, `user before` with `plan=NONE`, and a `would set currentPeriodEnd` ~7 days out. No writes.

- [ ] **Step 8: Compensation apply**

Run: `docker compose exec -w /app/apps/worker worker-render npx tsx src/scripts/replay-tribute-event.ts --event-hash=<hash> --apply`
Expected: `dispatch outcome { status: "applied", plan: "STARTER" }`, and `user after` shows `plan=STARTER`, `billingCycle=WEEKLY`, `subscriptionStatus=ACTIVE`, `currentPeriodEnd` ≈ now + 7 days, `tributeSubscriptionId=219056`. The user receives a `subscription_activated` Telegram message (send call logged; delivery to the user is not asserted here).

- [ ] **Step 9: Verify idempotency**

Run the same `--apply` command again.
Expected: `Event already applied and user already has the expected subscription. No action taken.` No further writes; user state unchanged.

- [ ] **Step 10: Safe production smoke (no fresh sent_at)**

Confirm the compensated row is settled:
Run: `docker compose exec -T postgres psql -U clipclap -d clipclap -c "SELECT status, outcome, attempts FROM tribute_webhook_events;"`
Expected: `status=APPLIED`, `outcome=applied_with_compensation`.

Two distinct re-send safety properties:
- **Future events** (hashed by the new algorithm): a Tribute retry produces the *same* `eventHash`, hits the terminal `APPLIED`/`IGNORED` row, and returns `duplicate` — no second activation or notification.
- **This one legacy event** (its stored `eventHash` predates the fix, so a re-send would compute a different hash and create a fresh row): the **stale-event guard** is the backstop — `applySubscription` sees the incoming `expires_at` (2026-07-18) is earlier than the compensated `currentPeriodEnd` (~now+7d) and returns `stale_event` *before* any upsert or notification. Safe either way; no fresh-`sent_at` replay is ever sent against production.

- [ ] **Step 11: Final commit (if any doc/notes changed)**

If verification surfaced any tweak, commit it. Otherwise the feature is complete on `fix/tribute-webhook-activation`; open a PR or merge per your workflow.

---

## Self-Review Notes (author)

- **Spec coverage:** event-name normalization (Task 2), correct product mapping w/ startapp+name fallback (Task 3), inbox state-machine + stable hash + retryable failures (Tasks 2,5), route status mapping (Task 6), stale/out-of-order guards (Task 4), PII-safe logging (Task 4), best-effort notifications (Task 4), env `_NAME` required in prod (Tasks 3,8), rewritten tests incl. all 18 spec cases (Tasks 2-5), safe replay + 7-day compensation (Task 7), deployment order env→migrate→code→replay (Task 8). All spec sections map to a task.
- **Type consistency:** `dispatchTributeEvent`, `processTributeEvent`, `loadTributeProductIndexFromEnv`, `resolveProductBinding`, `extractStartapp`, `normalizeProductName`, `canonicalTributeEventName`, `TributeProductIndex`, and the extended `TributeProcessOutcome` are used with identical names/signatures across tasks and the replay script.
- **The 18 spec test cases** are covered across Tasks 2-5 (some grouped into one `it`): 1,2 (Task 4 activation + full-ms assert; Task 2 normalization), 3 (Task 3/4 startapp), 4 (Task 3/4 name fallback), 5,6 (Task 3 malformed/empty startapp), 7 (Task 3 case-sensitivity), 8,9 (Task 3 collision/prod-missing-name), 10,11 (Task 5 FAILED + reprocess), 12 (Task 5 APPLIED duplicate, no second notify), 13 (Task 5 claim race), 14 (Task 4 stale renewal), 15 (Task 4 stale cancellation), 16 (Task 4 notify failure), 17,18 (Task 4 renewal/cancel grace).
