# Billing Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subscription access state self-correcting so it cannot silently drift from the payment provider, and make Stripe webhook processing idempotent against redelivery.

**Architecture:** Defense-in-depth on top of webhooks: (1) a single runtime guard (`canSubmitJob`) that blocks once the billing period has lapsed past a grace buffer, (2) an hourly BullMQ reconcile job that pulls truth from Stripe (and date-expires Tribute), (3) a `StripeWebhookEvent` dedup table, (4) a stored `currentPeriodStart` so the usage window comes from the provider, and (5) status-aware `customer.subscription.updated`.

**Tech Stack:** TypeScript, Prisma (PostgreSQL), Stripe SDK, BullMQ (Redis), Next.js API routes, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-30-billing-hardening-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `prisma/schema.prisma` | `User.currentPeriodStart` field + `StripeWebhookEvent` model | Modify |
| `packages/shared/src/config/billing.ts` | `SUBSCRIPTION_GRACE_BUFFER_DAYS` constant | Create |
| `packages/shared/src/config/index.ts` | Export the new constant | Modify |
| `packages/shared/src/services/usage.service.ts` | `getPeriodStart` (3-arg, calendar-correct) + grace-aware `canSubmitJob` | Modify |
| `apps/web/app/api/uploads/route.ts` | Route through `canSubmitJob` instead of inline status checks | Modify |
| `packages/shared/src/services/subscription-reconcile.service.ts` | `mapStripeStatus` + `reconcileSubscriptions` | Create |
| `packages/shared/src/services/index.ts` | Export reconcile service | Modify |
| `packages/shared/src/lib/referral-queue.ts` | Register hourly `subscription-reconcile` repeatable job | Modify |
| `packages/shared/src/lib/index.ts` | Export `SUBSCRIPTION_RECONCILE_JOB` | Modify |
| `apps/worker/src/referral-scheduler.ts` | Handle the `subscription-reconcile` job name | Modify |
| `packages/shared/src/services/billing.service.ts` | Webhook dedup; store `currentPeriodStart`; status-aware `subscription.updated` | Modify |
| `packages/shared/src/services/__tests__/*` | Tests for all of the above | Modify/Create |

**Test command (used throughout):** run from repo root `/srv/saas/clipclap.io`:
```bash
npx vitest run <path-to-test-file>
```

---

## Task 1: Prisma schema — `currentPeriodStart` + `StripeWebhookEvent`

**Files:**
- Modify: `prisma/schema.prisma` (User model ~line 107; new model after `TributeWebhookEvent` ~line 226)

- [ ] **Step 1: Add `currentPeriodStart` to the User model**

In `prisma/schema.prisma`, find this line inside `model User` (line 107):

```prisma
  currentPeriodEnd      DateTime?
```

Add the new field directly above it:

```prisma
  currentPeriodStart    DateTime?
  currentPeriodEnd      DateTime?
```

- [ ] **Step 2: Add the `StripeWebhookEvent` model**

In `prisma/schema.prisma`, find the existing `TributeWebhookEvent` model:

```prisma
model TributeWebhookEvent {
  id        String   @id @default(cuid())
  eventHash String   @unique
  name      String
  payload   Json
  createdAt DateTime @default(now())

  @@index([name, createdAt])
  @@map("tribute_webhook_events")
}
```

Add this new model immediately after it:

```prisma
model StripeWebhookEvent {
  eventId   String   @id
  type      String
  createdAt DateTime @default(now())

  @@index([type, createdAt])
  @@map("stripe_webhook_events")
}
```

- [ ] **Step 3: Push the schema and regenerate the client**

Run:
```bash
npx prisma db push && npx prisma generate
```
Expected: "Your database is now in sync with your Prisma schema." and "Generated Prisma Client".

- [ ] **Step 4: Verify TypeScript sees the new field/model**

Run:
```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
```
Expected: exits cleanly (no errors). The generated client now includes `currentPeriodStart` on `User` and a `stripeWebhookEvent` delegate.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(billing): add User.currentPeriodStart and StripeWebhookEvent model"
```

---

## Task 2: Billing config — `SUBSCRIPTION_GRACE_BUFFER_DAYS`

**Files:**
- Create: `packages/shared/src/config/billing.ts`
- Modify: `packages/shared/src/config/index.ts`

- [ ] **Step 1: Create the config file**

Create `packages/shared/src/config/billing.ts`:

```typescript
// Days of access granted past currentPeriodEnd before the runtime guard blocks
// and the reconcile cron date-expires a subscription. Covers webhook delivery
// lag and Stripe Smart Retries (first reattempt is ~day 3).
export const SUBSCRIPTION_GRACE_BUFFER_DAYS = 3;
```

- [ ] **Step 2: Export it from the config barrel**

In `packages/shared/src/config/index.ts`, add this line after the existing exports:

```typescript
export { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "./billing";
```

- [ ] **Step 3: Verify it compiles and is importable**

Run:
```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
```
Expected: exits cleanly.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/config/billing.ts packages/shared/src/config/index.ts
git commit -m "feat(billing): add SUBSCRIPTION_GRACE_BUFFER_DAYS config"
```

---

## Task 3: Usage guard — calendar-correct window + grace-aware `canSubmitJob`

This changes `getPeriodStart` to a 3-argument signature (prefers stored `currentPeriodStart`), updates both call sites, and rewrites `canSubmitJob` so ACTIVE/DUNNING require a live (within-grace) period while CANCELED/CANCELED_GRACE/NONE stay blocked.

**Files:**
- Modify: `packages/shared/src/services/usage.service.ts`
- Test: `packages/shared/src/services/__tests__/usage.service.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/services/__tests__/usage.service.test.ts`, add this import at the top alongside the existing imports:

```typescript
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../../config/billing";
```

**First, update the four existing tests whose assumptions the behavior change breaks** (they mock `currentPeriodEnd: null` or rely on the old DUNNING/`setDate(-30)` behavior).

Replace the existing test `"canSubmitJob blocks when over period cap and no top-up"` (give it a live period so it reaches the quota check):

```typescript
  it("canSubmitJob blocks when over period cap and no top-up", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      subscriptionStatus: "ACTIVE",
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });

    const result = await canSubmitJob("u1", 10);
    expect(result).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringMatching(/limit/i) })
    );
  });
```

Replace the existing test `"canSubmitJob allows when over cap but top-up covers it"`:

```typescript
  it("canSubmitJob allows when over cap but top-up covers it", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 50,
      subscriptionStatus: "ACTIVE",
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });

    const result = await canSubmitJob("u1", 30);
    expect(result).toEqual({ allowed: true });
  });
```

Replace the existing test `"canSubmitJob blocks during DUNNING"` (DUNNING is no longer an instant block; it blocks once the period has lapsed past grace):

```typescript
  it("canSubmitJob blocks DUNNING once period has lapsed past grace", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      subscriptionStatus: "DUNNING",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(
        Date.now() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * 24 * 60 * 60 * 1000
      ),
    });

    const result = await canSubmitJob("u1", 10);
    expect(result).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringMatching(/ended|period/i) })
    );
  });
```

Replace the existing test `"canSubmitJob anchors period to currentPeriodEnd when present"` (the monthly fallback now subtracts a calendar month, not 30 fixed days):

```typescript
  it("canSubmitJob anchors period to currentPeriodEnd when present (no stored start)", async () => {
    const futureEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: futureEnd,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 60 * 60 } });

    await canSubmitJob("u1", 10);

    const aggregateCall = (prisma.job.aggregate as any).mock.calls[0][0];
    const periodStart = aggregateCall.where.createdAt.gte as Date;
    const periodEnd = aggregateCall.where.createdAt.lte as Date;
    const expectedStart = new Date(futureEnd);
    expectedStart.setMonth(expectedStart.getMonth() - 1);
    expect(periodStart.getTime()).toBe(expectedStart.getTime());
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
  });
```

(The existing `"canSubmitJob blocks for NONE plan"` and `"canSubmitJob blocks during CANCELED_GRACE (read-only)"` tests are unaffected — those branches still short-circuit before the date check — so leave them as-is.)

**Then add this `describe` block at the end of the file** (before the final closing of the file):

```typescript
describe("canSubmitJob grace + period logic", () => {
  beforeEach(() => vi.clearAllMocks());

  const DAY = 24 * 60 * 60 * 1000;

  function mockUser(overrides: Record<string, unknown>) {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * DAY),
      ...overrides,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
  }

  it("blocks NONE plan", async () => {
    mockUser({ plan: "NONE", subscriptionStatus: "NONE" });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks CANCELED_GRACE even within period", async () => {
    mockUser({ subscriptionStatus: "CANCELED_GRACE" });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("allows ACTIVE within period", async () => {
    mockUser({ subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 2 * DAY) });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(true);
  });

  it("allows DUNNING while within grace (period ended < grace ago)", async () => {
    mockUser({
      subscriptionStatus: "DUNNING",
      currentPeriodEnd: new Date(Date.now() - 1 * DAY),
    });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(true);
  });

  it("blocks DUNNING after grace has elapsed", async () => {
    mockUser({
      subscriptionStatus: "DUNNING",
      currentPeriodEnd: new Date(Date.now() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * DAY),
    });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks ACTIVE whose period ended past grace (missed renewal)", async () => {
    mockUser({
      subscriptionStatus: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * DAY),
    });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks ACTIVE with null currentPeriodEnd", async () => {
    mockUser({ subscriptionStatus: "ACTIVE", currentPeriodEnd: null });
    const res = await canSubmitJob("u1", 1);
    expect(res.allowed).toBe(false);
  });

  it("blocks over-quota user (presign-style duration 0)", async () => {
    mockUser({ subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 2 * DAY) });
    // STARTER MONTHLY limit is 270 min; simulate 300 used.
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 300 * 60 } });
    const res = await canSubmitJob("u1", 0);
    expect(res.allowed).toBe(false);
  });

  it("allows exactly-at-limit user with duration 0 (presign)", async () => {
    mockUser({ subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 2 * DAY) });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });
    const res = await canSubmitJob("u1", 0);
    expect(res.allowed).toBe(true);
  });
});

describe("getPeriodStart via getUsageForUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses stored currentPeriodStart when present", async () => {
    const start = new Date("2026-04-30T00:00:00Z");
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: start,
      currentPeriodEnd: new Date("2026-05-30T00:00:00Z"),
      stripeSubscriptionId: "sub_1",
      tributeSubscriptionId: null,
    });
    (prisma.clip.count as any).mockResolvedValue(0);
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });

    await getUsageForUser("u1");

    // The aggregate window must start at the stored period start.
    const aggArgs = (prisma.job.aggregate as any).mock.calls[0][0];
    expect(aggArgs.where.createdAt.gte).toEqual(start);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/usage.service.test.ts
```
Expected: FAIL — the DUNNING/grace tests fail (current code blocks DUNNING outright and ignores the date), and the `currentPeriodStart` test fails (3-arg `getPeriodStart` not implemented).

- [ ] **Step 3: Rewrite `getPeriodStart` (3-arg, calendar-correct)**

In `packages/shared/src/services/usage.service.ts`, replace the entire `getPeriodStart` function (currently lines 23-44) with:

```typescript
// Computes the start of the current billing period (the usage window start).
// Prefers the provider-supplied currentPeriodStart so the window matches the
// real billing period even during DUNNING/grace. Falls back to subtracting one
// calendar month (monthly) or 7 days (weekly) from currentPeriodEnd, and finally
// to a rolling window from now for legacy rows with no period info.
function getPeriodStart(
  cycle: BillingCycle | null,
  currentPeriodStart: Date | null,
  currentPeriodEnd: Date | null
): Date {
  if (currentPeriodStart) {
    return currentPeriodStart;
  }

  if (currentPeriodEnd) {
    const start = new Date(currentPeriodEnd);
    if (cycle === "WEEKLY") {
      start.setDate(start.getDate() - 7);
    } else {
      start.setMonth(start.getMonth() - 1);
    }
    return start;
  }

  const fallback = new Date();
  if (cycle === "WEEKLY") {
    fallback.setDate(fallback.getDate() - 7);
  } else {
    fallback.setMonth(fallback.getMonth() - 1);
  }
  return fallback;
}
```

- [ ] **Step 4: Update the `getUsageForUser` call site**

In `packages/shared/src/services/usage.service.ts`, find (line ~98):

```typescript
  const periodStart = getPeriodStart(user.billingCycle, user.currentPeriodEnd);
```

Replace with:

```typescript
  const periodStart = getPeriodStart(
    user.billingCycle,
    user.currentPeriodStart,
    user.currentPeriodEnd
  );
```

- [ ] **Step 5: Rewrite `canSubmitJob` status/date gate**

In `packages/shared/src/services/usage.service.ts`, add this import near the top (after the existing `getPlanLimits` import):

```typescript
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../config/billing";
```

Then replace the status checks and the period-start line inside `canSubmitJob` (currently lines 133-144):

```typescript
  if (user.plan === "NONE" || user.subscriptionStatus === "NONE") {
    return { allowed: false, reason: "No active subscription. Choose a plan to get started." };
  }
  if (user.subscriptionStatus === "DUNNING") {
    return { allowed: false, reason: "Your last payment failed. Please update your payment method." };
  }
  if (user.subscriptionStatus === "CANCELED_GRACE" || user.subscriptionStatus === "CANCELED") {
    return { allowed: false, reason: "Your subscription is canceled. Resubscribe to create new clips." };
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const periodStart = getPeriodStart(user.billingCycle, user.currentPeriodEnd);
```

with:

```typescript
  if (user.plan === "NONE" || user.subscriptionStatus === "NONE") {
    return { allowed: false, reason: "No active subscription. Choose a plan to get started." };
  }
  if (
    user.subscriptionStatus === "CANCELED_GRACE" ||
    user.subscriptionStatus === "CANCELED"
  ) {
    return { allowed: false, reason: "Your subscription is canceled. Resubscribe to create new clips." };
  }

  // ACTIVE or DUNNING: access is allowed only while the billing period is still
  // live within the grace buffer. This is the defense-in-depth that stops a
  // missed renewal webhook (or a stale DB row) from granting access forever.
  const graceMs = SUBSCRIPTION_GRACE_BUFFER_DAYS * 24 * 60 * 60 * 1000;
  if (
    !user.currentPeriodEnd ||
    user.currentPeriodEnd.getTime() + graceMs <= Date.now()
  ) {
    return {
      allowed: false,
      reason: "Your subscription period has ended. Renew to continue creating clips.",
    };
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const periodStart = getPeriodStart(
    user.billingCycle,
    user.currentPeriodStart,
    user.currentPeriodEnd
  );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/usage.service.test.ts
```
Expected: PASS (all tests, including pre-existing ones).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/services/usage.service.ts packages/shared/src/services/__tests__/usage.service.test.ts
git commit -m "feat(billing): grace-aware canSubmitJob + provider-anchored usage window"
```

---

## Task 4: Route the upload presign through `canSubmitJob`

Replace the three inline status checks in the presign route with a single `canSubmitJob(userId, 0)` call so the date/grace guard and quota check apply there too.

**Files:**
- Modify: `apps/web/app/api/uploads/route.ts`

- [ ] **Step 1: Swap the import**

In `apps/web/app/api/uploads/route.ts`, replace line 3:

```typescript
import { getPresignedUploadUrl, prisma, getPlanLimits } from "@clipclap/shared";
```

with:

```typescript
import { getPresignedUploadUrl, prisma, getPlanLimits, canSubmitJob } from "@clipclap/shared";
```

- [ ] **Step 2: Replace the inline status block with the unified guard**

In the same file, replace this block (lines 26-46):

```typescript
  if (user.plan === "NONE" || user.subscriptionStatus === "NONE") {
    return NextResponse.json(
      { error: "Active subscription required to upload" },
      { status: 402 }
    );
  }
  if (user.subscriptionStatus === "DUNNING") {
    return NextResponse.json(
      { error: "Payment failed; update your payment method" },
      { status: 402 }
    );
  }
  if (
    user.subscriptionStatus === "CANCELED_GRACE" ||
    user.subscriptionStatus === "CANCELED"
  ) {
    return NextResponse.json(
      { error: "Subscription canceled; resubscribe to upload" },
      { status: 402 }
    );
  }
```

with:

```typescript
  // Coarse gate at presign time: status + grace-date + already-over-quota.
  // Duration is unknown until the file is uploaded, so pass 0; exact minute
  // enforcement happens at job submit (api/jobs/route.ts) with the real duration.
  const submission = await canSubmitJob(session.user.id, 0);
  if (!submission.allowed) {
    return NextResponse.json({ error: submission.reason }, { status: 402 });
  }
```

- [ ] **Step 3: Typecheck the web app**

Run:
```bash
npx tsc -p apps/web/tsconfig.json --noEmit
```
Expected: exits cleanly. (`user` is still used below for the file-size limit check, so its fetch stays.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/uploads/route.ts
git commit -m "refactor(billing): route upload presign through canSubmitJob guard"
```

---

## Task 5: Reconcile service — `mapStripeStatus` + `reconcileSubscriptions`

**Files:**
- Create: `packages/shared/src/services/subscription-reconcile.service.ts`
- Modify: `packages/shared/src/services/index.ts`
- Test: `packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockStripe = {
  subscriptions: { retrieve: vi.fn() },
};

vi.mock("../billing.service", () => ({
  getStripe: () => mockStripe,
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findMany: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "../../lib/prisma";
import {
  mapStripeStatus,
  reconcileSubscriptions,
} from "../subscription-reconcile.service";

describe("mapStripeStatus", () => {
  it("maps active/trialing to ACTIVE", () => {
    expect(mapStripeStatus("active")).toBe("ACTIVE");
    expect(mapStripeStatus("trialing")).toBe("ACTIVE");
  });
  it("maps past_due/unpaid to DUNNING", () => {
    expect(mapStripeStatus("past_due")).toBe("DUNNING");
    expect(mapStripeStatus("unpaid")).toBe("DUNNING");
  });
  it("maps canceled/incomplete_expired to CANCELED", () => {
    expect(mapStripeStatus("canceled")).toBe("CANCELED");
    expect(mapStripeStatus("incomplete_expired")).toBe("CANCELED");
  });
  it("returns null for unknown/transient statuses", () => {
    expect(mapStripeStatus("incomplete")).toBeNull();
    expect(mapStripeStatus("paused")).toBeNull();
  });
});

describe("reconcileSubscriptions", () => {
  beforeEach(() => vi.clearAllMocks());
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date("2026-05-30T12:00:00Z");

  it("advances a Stripe user whose webhook was missed (still active)", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u1",
        stripeSubscriptionId: "sub_1",
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      status: "active",
      current_period_start: 1780000000,
      current_period_end: 1782600000,
    });

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        subscriptionStatus: "ACTIVE",
        dunningSince: null,
        currentPeriodStart: new Date(1780000000 * 1000),
        currentPeriodEnd: new Date(1782600000 * 1000),
      }),
    });
  });

  it("moves a Stripe past_due user to DUNNING", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u2",
        stripeSubscriptionId: "sub_2",
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      status: "past_due",
      current_period_start: 1780000000,
      current_period_end: 1782600000,
    });

    await reconcileSubscriptions(NOW);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u2" },
      data: expect.objectContaining({ subscriptionStatus: "DUNNING" }),
    });
  });

  it("date-expires a Tribute user past grace to CANCELED", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u3",
        stripeSubscriptionId: null,
        tributeSubscriptionId: "trb_1",
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 10 * DAY),
      },
    ]);

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u3" },
      data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
    });
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("leaves a Tribute user still within grace untouched", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u4",
        stripeSubscriptionId: null,
        tributeSubscriptionId: "trb_2",
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("skips a Stripe user when retrieve throws (logs, continues)", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u5",
        stripeSubscriptionId: "sub_5",
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);
    mockStripe.subscriptions.retrieve.mockRejectedValue(new Error("stripe down"));

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts
```
Expected: FAIL with "Cannot find module '../subscription-reconcile.service'" (or undefined exports).

- [ ] **Step 3: Implement the service**

Create `packages/shared/src/services/subscription-reconcile.service.ts`:

```typescript
import type { SubscriptionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getStripe } from "./billing.service";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../config/billing";

// Maps a Stripe subscription.status to our local SubscriptionStatus.
// Returns null for transient states (incomplete, paused) we should not act on.
export function mapStripeStatus(
  stripeStatus: string
): SubscriptionStatus | null {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "ACTIVE";
    case "past_due":
    case "unpaid":
      return "DUNNING";
    case "canceled":
    case "incomplete_expired":
      return "CANCELED";
    default:
      return null;
  }
}

// Hourly reconcile: finds ACTIVE/DUNNING users whose period has lapsed and pulls
// the truth from the provider. Stripe is authoritative (retrieve + status map);
// Tribute is push-only, so a lapsed period past grace is date-expired to CANCELED.
export async function reconcileSubscriptions(
  now: Date
): Promise<{ reconciled: number }> {
  const skewMs = 5 * 60 * 1000;
  const cutoff = new Date(now.getTime() - skewMs);
  const graceMs = SUBSCRIPTION_GRACE_BUFFER_DAYS * 24 * 60 * 60 * 1000;

  const users = await prisma.user.findMany({
    where: {
      subscriptionStatus: { in: ["ACTIVE", "DUNNING"] },
      currentPeriodEnd: { lt: cutoff },
    },
    select: {
      id: true,
      stripeSubscriptionId: true,
      tributeSubscriptionId: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
    },
  });

  let reconciled = 0;

  for (const user of users) {
    if (user.stripeSubscriptionId) {
      const stripe = getStripe();
      let sub;
      try {
        sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      } catch (err) {
        console.error(
          `[reconcile] user=${user.id} stripe retrieve failed; skipping:`,
          err
        );
        continue;
      }

      const nextStatus = mapStripeStatus(sub.status);
      if (!nextStatus) continue;

      const data: {
        subscriptionStatus: SubscriptionStatus;
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        dunningSince?: null;
      } = {
        subscriptionStatus: nextStatus,
        currentPeriodStart: new Date(sub.current_period_start * 1000),
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
      };
      if (nextStatus === "ACTIVE") data.dunningSince = null;

      if (nextStatus !== user.subscriptionStatus) {
        console.log(
          `[reconcile] user=${user.id} ${user.subscriptionStatus}→${nextStatus} reason=stripe_status=${sub.status}`
        );
      }
      await prisma.user.update({ where: { id: user.id }, data });
      reconciled++;
    } else if (user.tributeSubscriptionId) {
      const expiredPastGrace =
        user.currentPeriodEnd != null &&
        user.currentPeriodEnd.getTime() + graceMs < now.getTime();
      if (expiredPastGrace) {
        console.log(
          `[reconcile] user=${user.id} ${user.subscriptionStatus}→CANCELED reason=tribute_period_expired_grace_elapsed`
        );
        await prisma.user.update({
          where: { id: user.id },
          data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
        });
        reconciled++;
      }
    }
  }

  return { reconciled };
}
```

- [ ] **Step 4: Export the service from the barrel**

In `packages/shared/src/services/index.ts`, add after the existing `export * from "./tribute.service";` line:

```typescript
export * from "./subscription-reconcile.service";
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts
```
Expected: PASS (all reconcile + mapStripeStatus tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/subscription-reconcile.service.ts packages/shared/src/services/index.ts packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts
git commit -m "feat(billing): subscription-reconcile service (Stripe pull, Tribute date-expire)"
```

---

## Task 6: Cron wiring — hourly `subscription-reconcile` job

**Files:**
- Modify: `packages/shared/src/lib/referral-queue.ts`
- Modify: `packages/shared/src/lib/index.ts`
- Modify: `apps/worker/src/referral-scheduler.ts`

- [ ] **Step 1: Add the job constant and schedule it**

In `packages/shared/src/lib/referral-queue.ts`, add the new constant after the existing `HOLD_RELEASE_JOB` declaration (line 5):

```typescript
export const SUBSCRIPTION_RECONCILE_JOB = "subscription-reconcile";
```

Then, inside `registerReferralSchedules`, add the new repeatable job right after the existing `hold-release` line (line 29):

```typescript
  await queue.add(SUBSCRIPTION_RECONCILE_JOB, {}, { repeat: { pattern: "0 * * * *" }, jobId: SUBSCRIPTION_RECONCILE_JOB });
```

(The function's existing comment already says "Idempotent on jobId, so calling on every worker boot is safe" — that applies to this job too.)

- [ ] **Step 2: Export the constant from the lib barrel**

In `packages/shared/src/lib/index.ts`, find the `referral-queue` re-export block:

```typescript
export {
  getReferralQueue,
  registerReferralSchedules,
  REFERRAL_QUEUE_NAME,
  HOLD_RELEASE_JOB,
} from "./referral-queue";
```

Replace it with:

```typescript
export {
  getReferralQueue,
  registerReferralSchedules,
  REFERRAL_QUEUE_NAME,
  HOLD_RELEASE_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
} from "./referral-queue";
```

- [ ] **Step 3: Handle the job in the scheduler worker**

In `apps/worker/src/referral-scheduler.ts`, update the imports (lines 2-6) to add `SUBSCRIPTION_RECONCILE_JOB` and `reconcileSubscriptions`:

```typescript
import {
  getRedis,
  REFERRAL_QUEUE_NAME,
  HOLD_RELEASE_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  releaseMaturedCommissions,
  reconcileSubscriptions,
} from "@clipclap/shared";
```

Then, inside the worker processor callback, add a branch after the existing `HOLD_RELEASE_JOB` block:

```typescript
      if (job.name === SUBSCRIPTION_RECONCILE_JOB) {
        const { reconciled } = await reconcileSubscriptions(now);
        console.log(`[reconcile] reconciled ${reconciled} subscriptions`);
        return;
      }
```

(`now` is already declared at the top of the callback as `const now = new Date();`.)

- [ ] **Step 4: Typecheck shared + worker**

Run:
```bash
npx tsc -p packages/shared/tsconfig.json --noEmit && npx tsc -p apps/worker/tsconfig.json --noEmit
```
Expected: both exit cleanly.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lib/referral-queue.ts packages/shared/src/lib/index.ts apps/worker/src/referral-scheduler.ts
git commit -m "feat(billing): schedule hourly subscription-reconcile job"
```

---

## Task 7: Stripe webhook dedup

Wrap `handleWebhook` so an already-processed `event.id` is skipped, and the event is recorded only after the switch completes.

**Files:**
- Modify: `packages/shared/src/services/billing.service.ts`
- Test: `packages/shared/src/services/__tests__/billing.service.test.ts`

- [ ] **Step 1: Add `stripeWebhookEvent` to the test's prisma mock**

In `packages/shared/src/services/__tests__/billing.service.test.ts`, update the prisma mock (lines 14-23) to add the new delegate:

```typescript
vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    stripeWebhookEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));
```

- [ ] **Step 2: Write the failing dedup tests**

In the same file, inside the `describe("billing.service - handleWebhook", ...)` block, add these two tests at the end (before the block's closing `});`):

```typescript
  it("skips processing when the event id was already recorded", async () => {
    (prisma.stripeWebhookEvent.findUnique as any).mockResolvedValueOnce({
      eventId: "evt_dup",
    });
    mockStripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_dup",
      type: "invoice.payment_succeeded",
      data: { object: { subscription: "sub_1" } },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.stripeWebhookEvent.create).not.toHaveBeenCalled();
  });

  it("records the event id after successful processing", async () => {
    (prisma.stripeWebhookEvent.findUnique as any).mockResolvedValue(null);
    mockStripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_new",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1" } },
    });

    await handleWebhook("body", "sig");

    expect(prisma.stripeWebhookEvent.create).toHaveBeenCalledWith({
      data: { eventId: "evt_new", type: "customer.subscription.deleted" },
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```
Expected: FAIL — dedup not implemented (the "skips processing" test sees `updateMany`/no-create not honored, and "records" sees no `create`).

- [ ] **Step 4: Implement the dedup wrapper**

In `packages/shared/src/services/billing.service.ts`, inside `handleWebhook`, find this line (line 103):

```typescript
  const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
```

Insert the dedup guard immediately after it:

```typescript
  const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);

  // Idempotency: skip events already processed. Recorded AFTER the switch below
  // so an event that throws mid-processing is retried by Stripe, not skipped.
  const seen = await prisma.stripeWebhookEvent.findUnique({
    where: { eventId: event.id },
  });
  if (seen) return;
```

Then find the closing brace of the `switch (event.type) { ... }` statement (line 366, the `}` that closes the switch, just before the final `}` of the function). Immediately after the switch's closing brace, add:

```typescript
  // Mark processed. try/catch absorbs the unique-violation from a rare
  // concurrent double-delivery (both passed the findUnique check above).
  try {
    await prisma.stripeWebhookEvent.create({
      data: { eventId: event.id, type: event.type },
    });
  } catch {
    // already recorded concurrently — treat as duplicate, nothing to do
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```
Expected: PASS — including all pre-existing handleWebhook tests (their constructEvent mocks now flow through findUnique→null→process→create).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/billing.service.ts packages/shared/src/services/__tests__/billing.service.test.ts
git commit -m "feat(billing): dedup Stripe webhooks via StripeWebhookEvent (record after success)"
```

---

## Task 8: Store `currentPeriodStart` on checkout + invoice webhooks

**Files:**
- Modify: `packages/shared/src/services/billing.service.ts`
- Test: `packages/shared/src/services/__tests__/billing.service.test.ts`

- [ ] **Step 1: Update existing tests to expect `currentPeriodStart`**

In `packages/shared/src/services/__tests__/billing.service.test.ts`:

In the `checkout.session.completed` test, update the `subscriptions.retrieve` mock (lines 179-183) to include a start:

```typescript
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      items: { data: [{ price: { id: "price_pm" } }] },
      current_period_start: 1778408000,
      current_period_end: 1781000000,
    });
```

and add to its `expect(...).objectContaining({ data: ... })` assertion (after the `currentPeriodEnd` line, line 197):

```typescript
          currentPeriodStart: new Date(1778408000 * 1000),
```

In the `invoice.payment_succeeded` test, update the `subscriptions.retrieve` mock (lines 237-240):

```typescript
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      current_period_start: 1779408000,
      current_period_end: 1782000000,
    });
```

and add to its assertion `data` (after the `currentPeriodEnd` line, line 251):

```typescript
          currentPeriodStart: new Date(1779408000 * 1000),
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```
Expected: FAIL — the two updated assertions expect `currentPeriodStart` the handler doesn't write yet.

- [ ] **Step 3: Write `currentPeriodStart` in the checkout handler**

In `packages/shared/src/services/billing.service.ts`, in the `checkout.session.completed` subscription branch, find (line 147):

```typescript
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
```

Replace with:

```typescript
          currentPeriodStart: new Date(subscription.current_period_start * 1000),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
```

- [ ] **Step 4: Write `currentPeriodStart` in the invoice handler**

In the same file, in the `invoice.payment_succeeded` branch, find (line 216):

```typescript
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
```

Replace with:

```typescript
          currentPeriodStart: new Date(subscription.current_period_start * 1000),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/billing.service.ts packages/shared/src/services/__tests__/billing.service.test.ts
git commit -m "feat(billing): persist currentPeriodStart on checkout and renewal webhooks"
```

---

## Task 9: Status-aware `customer.subscription.updated`

Make the updated-handler read `subscription.status` (→ ACTIVE/DUNNING with the `dunningSince` guard) and also store `currentPeriodStart`.

**Files:**
- Modify: `packages/shared/src/services/billing.service.ts`
- Test: `packages/shared/src/services/__tests__/billing.service.test.ts`

- [ ] **Step 1: Update the existing test and add status tests**

In `packages/shared/src/services/__tests__/billing.service.test.ts`, replace the existing `customer.subscription.updated` test (lines 278-302) with:

```typescript
  it("customer.subscription.updated (active) sets plan, cycle, period, ACTIVE", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_u1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          status: "active",
          items: { data: [{ price: { id: "price_mm" } }] },
          current_period_start: 1778408000,
          current_period_end: 1781000000,
        },
      },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1" },
        data: expect.objectContaining({
          plan: "MAX",
          billingCycle: "MONTHLY",
          subscriptionStatus: "ACTIVE",
          dunningSince: null,
          currentPeriodStart: new Date(1778408000 * 1000),
          currentPeriodEnd: new Date(1781000000 * 1000),
        }),
      })
    );
  });

  it("customer.subscription.updated (past_due) stamps DUNNING with guard", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_u2",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          status: "past_due",
          items: { data: [{ price: { id: "price_mm" } }] },
          current_period_start: 1778408000,
          current_period_end: 1781000000,
        },
      },
    });

    await handleWebhook("body", "sig");

    // base update (plan/cycle/period) + guarded dunning update
    const calls = (prisma.user.updateMany as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1", dunningSince: null },
        data: expect.objectContaining({
          subscriptionStatus: "DUNNING",
          dunningSince: expect.any(Date),
        }),
      })
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```
Expected: FAIL — current handler writes neither `subscriptionStatus` nor `currentPeriodStart` and never makes the guarded DUNNING update.

- [ ] **Step 3: Rewrite the `customer.subscription.updated` case**

In `packages/shared/src/services/billing.service.ts`, replace the entire `customer.subscription.updated` case (lines 351-365) with:

```typescript
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const mapped = priceId ? getPlanFromPriceId(priceId) : null;
      if (!mapped) break;

      const baseData = {
        plan: mapped.plan,
        billingCycle: mapped.cycle,
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      };

      const status = subscription.status;
      if (status === "active" || status === "trialing") {
        // Healthy: clear any dunning stamp.
        await prisma.user.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: { ...baseData, subscriptionStatus: "ACTIVE", dunningSince: null },
        });
      } else if (status === "past_due" || status === "unpaid") {
        // Always refresh plan/cycle/period; stamp DUNNING only on first transition
        // (mirrors invoice.payment_failed so dunningSince is not re-stamped).
        await prisma.user.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: baseData,
        });
        await prisma.user.updateMany({
          where: { stripeSubscriptionId: subscription.id, dunningSince: null },
          data: { subscriptionStatus: "DUNNING", dunningSince: new Date() },
        });
      } else {
        // canceled/incomplete/etc: refresh fields, leave status to
        // customer.subscription.deleted + the reconcile cron.
        await prisma.user.updateMany({
          where: { stripeSubscriptionId: subscription.id },
          data: baseData,
        });
      }
      break;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/billing.service.ts packages/shared/src/services/__tests__/billing.service.test.ts
git commit -m "feat(billing): customer.subscription.updated maps status to ACTIVE/DUNNING"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole shared test suite**

Run:
```bash
npx vitest run packages/shared/src
```
Expected: PASS — all suites green (usage, billing, reconcile, and every pre-existing suite).

- [ ] **Step 2: Typecheck all touched packages**

Run:
```bash
npx tsc -p packages/shared/tsconfig.json --noEmit \
  && npx tsc -p apps/web/tsconfig.json --noEmit \
  && npx tsc -p apps/worker/tsconfig.json --noEmit
```
Expected: all exit cleanly.

- [ ] **Step 3: Confirm the reconcile job registers (smoke check)**

Confirm the worker schedules the job. Run:
```bash
grep -n "SUBSCRIPTION_RECONCILE_JOB" packages/shared/src/lib/referral-queue.ts apps/worker/src/referral-scheduler.ts
```
Expected: the constant is both registered (`queue.add(...)`) in `referral-queue.ts` and handled (`job.name === SUBSCRIPTION_RECONCILE_JOB`) in `referral-scheduler.ts`.

- [ ] **Step 4: Final commit (if any uncommitted verification fixes)**

```bash
git add -A && git commit -m "test(billing): full suite + typecheck green for billing hardening" || echo "nothing to commit"
```

---

## Self-Review Notes (coverage map)

- Spec §1A unified guard → Task 3 (canSubmitJob) + Task 4 (uploads route).
- Spec §1B reconcile cron → Task 5 (service) + Task 6 (schedule).
- Spec §2 webhook dedup → Task 7.
- Spec §3 currentPeriodStart + getPeriodStart → Task 1 (field) + Task 3 (getPeriodStart) + Task 8 (storage) + Task 9 (also stores it on updated).
- Spec §4 status-aware updated → Task 9.
- Data model changes → Task 1.
- Testing section → Tasks 3, 5, 7, 8, 9, 10.

**DUNNING behavior change** (now access-until-grace, was immediate block) lands in Task 3 and is exercised by its tests.
