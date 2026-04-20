# ClipClap Billing Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a billing foundation that supports the v1 pricing tiers (Starter/Plus/Max with weekly+monthly billing), minute-based usage tracking, Stripe lifecycle webhooks that set retention-aware state (cleanup happens in Plan 2), top-up purchases, and abuse protections on uploads.

**Architecture:** Extend the existing `billing.service.ts` and Prisma schema rather than rewriting. Replace the video-count usage model with minutes-per-period. Add `subscriptionStatus` state machine to `User` so Plan 2's retention cleanup can query clips by user state. Keep webhook handlers side-effect-minimal (just mutate state); cleanup is a later phase.

**Tech Stack:** Next.js 15 App Router, Prisma + PostgreSQL, Stripe Node SDK, BullMQ + Redis, vitest, Cloudflare R2 via AWS SDK.

**Reference spec:** `docs/superpowers/specs/2026-04-19-clipclap-launch-design.md` — sections 1 (pricing), 2.4–2.8 (billing lifecycle scenarios), 3.6 (direct-to-R2 upload), 3.7 (API rate limiting is Plan 3, not here).

---

## File Structure

**New files:**
- `packages/shared/src/config/plans.ts` — rewritten (same path, new content)
- `packages/shared/src/services/billing.service.ts` — heavily extended
- `packages/shared/src/services/topup.service.ts` — new, Stripe one-time top-up flow
- `packages/shared/src/services/usage.service.ts` — new, minute-based usage queries
- `apps/web/app/api/billing/topup/route.ts` — new endpoint
- `apps/web/app/api/billing/portal/route.ts` — new, Stripe Customer Portal session
- `prisma/migrations/<timestamp>_plan_rename_and_lifecycle/migration.sql` — generated

**Modified files:**
- `prisma/schema.prisma` — Plan enum, User lifecycle fields, Clip retention fields
- `packages/shared/src/services/user.service.ts` — replace video-count with minute-usage
- `packages/shared/src/services/index.ts` — export new services
- `apps/web/app/api/jobs/route.ts` — abuse protections
- `apps/web/app/api/uploads/route.ts` — file-size and duration pre-check
- `apps/web/components/plan-card.tsx` — new tier names and features
- `apps/web/app/(dashboard)/dashboard/plans/page.tsx` — new tier list
- `apps/web/components/usage-bar.tsx` — minute display
- `apps/web/components/sidebar.tsx` — usage data update
- `apps/web/app/(dashboard)/layout.tsx` — pass minute usage
- `.env.example` — new Stripe price IDs
- `packages/shared/src/config/__tests__/plans.test.ts` — rewrite
- `packages/shared/src/config/__tests__/plans.comprehensive.test.ts` — delete or rewrite

---

## Task 1: Rewrite Plan Enum in Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma`

**Why:** The current enum has FREE/STARTER/PRO which don't match the v1 pricing. FREE is removed, PRO is renamed to MAX, and PLUS is added. We also add `NONE` as the default for users who have no active subscription (replaces the role of FREE as "default state").

- [ ] **Step 1: Edit Plan enum**

Replace the `Plan` enum in `prisma/schema.prisma`:

```prisma
enum Plan {
  NONE
  STARTER
  PLUS
  MAX
}
```

- [ ] **Step 2: Edit User.plan default**

Change the `plan` field default on the `User` model:

```prisma
plan  Plan  @default(NONE)
```

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): rename Plan enum to NONE/STARTER/PLUS/MAX"
```

---

## Task 2: Add Subscription Lifecycle Fields to User

**Files:**
- Modify: `prisma/schema.prisma`

**Why:** The spec's billing lifecycle (sections 2.4, 2.5) requires tracking dunning and grace-period states so Plan 2's cleanup job can find users whose clips should be deleted. Currently we only have `plan` + `stripeSubscriptionId`; we need explicit state.

- [ ] **Step 1: Add SubscriptionStatus enum**

Add to `prisma/schema.prisma` below the `Plan` enum:

```prisma
enum SubscriptionStatus {
  NONE
  ACTIVE
  DUNNING
  CANCELED_GRACE
  CANCELED
}

enum BillingCycle {
  WEEKLY
  MONTHLY
}
```

- [ ] **Step 2: Extend User model**

Add to the `User` model after the existing `stripeSubscriptionId` field:

```prisma
subscriptionStatus     SubscriptionStatus @default(NONE)
billingCycle           BillingCycle?
currentPeriodEnd       DateTime?
dunningSince           DateTime?
graceEndsAt            DateTime?
topUpMinutesRemaining  Int                @default(0)
```

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add subscription lifecycle fields to User"
```

---

## Task 3: Add Retention Fields and Indexes to Clip

**Files:**
- Modify: `prisma/schema.prisma`

**Why:** Spec Section 2.1 requires per-clip `expiresAt` so retention cleanup in Plan 2 can work. Soft-delete marker `deletedAt` enables bug-recovery per Section 2.10. Indexes are required for the cleanup query scan.

- [ ] **Step 1: Extend Clip model**

Add to the `Clip` model in `prisma/schema.prisma`:

```prisma
expiresAt   DateTime?
deletedAt   DateTime?
```

- [ ] **Step 2: Add indexes on Clip model**

Add to the `Clip` model (alongside existing `@@index([userId])`):

```prisma
@@index([expiresAt, deletedAt])
@@index([userId, createdAt(sort: Desc)])
```

Full Clip indexes block should look like:

```prisma
@@index([jobId])
@@index([userId])
@@index([expiresAt, deletedAt])
@@index([userId, createdAt(sort: Desc)])
```

- [ ] **Step 3: Add index on Job for concurrency checks**

Add to the `Job` model (alongside existing indexes):

```prisma
@@index([userId, status])
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add retention fields and indexes to Clip"
```

---

## Task 4: Generate and Review Prisma Migration

**Files:**
- Create: `prisma/migrations/<timestamp>_plan_rename_and_lifecycle/migration.sql`

**Why:** We need to materialize the schema changes as a migration and verify the SQL before applying. Renaming an enum value (PRO → MAX) requires explicit SQL that `prisma migrate` generates; removing FREE requires a data migration for any existing rows.

- [ ] **Step 1: Create migration**

From repo root:

```bash
docker compose exec web npx prisma migrate dev --name plan_rename_and_lifecycle --create-only
```

This creates the migration file without running it, so we can inspect.

- [ ] **Step 2: Inspect generated SQL**

Open the new migration file. You should see:
- `ALTER TYPE "Plan" RENAME VALUE 'PRO' TO 'MAX'` (or recreation pattern)
- `ALTER TYPE "Plan" ADD VALUE 'PLUS'`
- Handling for FREE removal

If Prisma generated a destructive enum rebuild (DROP + CREATE) that would wipe the `users.plan` column, edit the migration to use explicit `ALTER TYPE ... RENAME VALUE` statements and `UPDATE users SET plan = 'NONE' WHERE plan = 'FREE'` before removing FREE.

Expected safe SQL order:

```sql
-- 1. Rename PRO → MAX
ALTER TYPE "Plan" RENAME VALUE 'PRO' TO 'MAX';

-- 2. Add PLUS and NONE values
ALTER TYPE "Plan" ADD VALUE 'PLUS';
ALTER TYPE "Plan" ADD VALUE 'NONE';

-- 3. Migrate any FREE users to NONE
UPDATE "users" SET "plan" = 'NONE' WHERE "plan" = 'FREE';

-- 4. Remove FREE (requires recreation in Postgres)
-- Prisma will generate this; verify the generated pattern handles the default
```

- [ ] **Step 3: Run the migration**

```bash
docker compose exec web npx prisma migrate dev
```

Expected: migration applies cleanly, Prisma client regenerates.

- [ ] **Step 4: Verify DB state**

```bash
docker compose exec postgres psql -U clipfast -d clipfast -c "\dT+ Plan"
docker compose exec postgres psql -U clipfast -d clipfast -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='users' AND column_name IN ('subscriptionStatus','billingCycle','currentPeriodEnd','dunningSince','graceEndsAt','topUpMinutesRemaining');"
docker compose exec postgres psql -U clipfast -d clipfast -c "SELECT column_name FROM information_schema.columns WHERE table_name='clips' AND column_name IN ('expiresAt','deletedAt');"
```

Expected: Plan enum shows NONE/STARTER/PLUS/MAX, User columns exist, Clip columns exist.

- [ ] **Step 5: Commit**

```bash
git add prisma/migrations/
git commit -m "feat(db): migration for plan rename and subscription lifecycle"
```

---

## Task 5: Rewrite plans.ts Configuration

**Files:**
- Modify: `packages/shared/src/config/plans.ts`
- Modify: `packages/shared/src/config/__tests__/plans.test.ts`
- Delete: `packages/shared/src/config/__tests__/plans.comprehensive.test.ts` (obsolete; new test covers all)

**Why:** Spec Section 1.1 defines the v1 limits. The old config uses `videosPerWeek`; v1 is minute-based (`minutesPerPeriod`) with explicit `billingCycle`. Section 1.6 adds abuse caps. Section 2.1 adds retention days.

- [ ] **Step 1: Write new test file**

Replace contents of `packages/shared/src/config/__tests__/plans.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getPlanLimits, PLAN_LIMITS, getPlanFromPriceId } from "../plans";

describe("Plan Limits", () => {
  it("NONE plan has zero quotas", () => {
    const limits = getPlanLimits("NONE");
    expect(limits.minutesPerPeriod).toBe(0);
    expect(limits.storageClips).toBe(0);
  });

  it("STARTER monthly: 270 min, 20 clips, 7d retention", () => {
    const limits = getPlanLimits("STARTER", "MONTHLY");
    expect(limits.minutesPerPeriod).toBe(270);
    expect(limits.storageClips).toBe(20);
    expect(limits.retentionDays).toBe(7);
    expect(limits.subtitlePresets).toEqual(["tiktok"]);
    expect(limits.concurrentJobsLimit).toBe(1);
  });

  it("STARTER weekly: 75 min, same features as monthly", () => {
    const limits = getPlanLimits("STARTER", "WEEKLY");
    expect(limits.minutesPerPeriod).toBe(75);
    expect(limits.storageClips).toBe(20);
  });

  it("PLUS monthly: 1000 min, 150 clips, 30d retention, 3 presets", () => {
    const limits = getPlanLimits("PLUS", "MONTHLY");
    expect(limits.minutesPerPeriod).toBe(1000);
    expect(limits.storageClips).toBe(150);
    expect(limits.retentionDays).toBe(30);
    expect(limits.subtitlePresets).toEqual(["tiktok", "minimal", "bold"]);
    expect(limits.concurrentJobsLimit).toBe(2);
  });

  it("MAX monthly: 3500 min, 1000 clips, 90d retention, all presets, priority", () => {
    const limits = getPlanLimits("MAX", "MONTHLY");
    expect(limits.minutesPerPeriod).toBe(3500);
    expect(limits.storageClips).toBe(1000);
    expect(limits.retentionDays).toBe(90);
    expect(limits.priorityQueue).toBe(true);
    expect(limits.concurrentJobsLimit).toBe(3);
  });

  it("PLUS and MAX do not have weekly cycles", () => {
    expect(() => getPlanLimits("PLUS", "WEEKLY")).toThrow(/no weekly/i);
    expect(() => getPlanLimits("MAX", "WEEKLY")).toThrow(/no weekly/i);
  });

  it("max source duration per upload is 180 min across all paid plans", () => {
    expect(getPlanLimits("STARTER", "MONTHLY").maxSourceDurationMinutes).toBe(180);
    expect(getPlanLimits("PLUS", "MONTHLY").maxSourceDurationMinutes).toBe(180);
    expect(getPlanLimits("MAX", "MONTHLY").maxSourceDurationMinutes).toBe(180);
  });

  it("max jobs per day scales with tier", () => {
    expect(getPlanLimits("STARTER", "MONTHLY").maxJobsPerDay).toBe(20);
    expect(getPlanLimits("PLUS", "MONTHLY").maxJobsPerDay).toBe(50);
    expect(getPlanLimits("MAX", "MONTHLY").maxJobsPerDay).toBe(100);
  });

  it("getPlanFromPriceId returns correct tuple", () => {
    process.env.STRIPE_STARTER_WEEKLY_PRICE_ID = "price_sw";
    process.env.STRIPE_STARTER_MONTHLY_PRICE_ID = "price_sm";
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_pm";
    process.env.STRIPE_MAX_MONTHLY_PRICE_ID = "price_mm";

    expect(getPlanFromPriceId("price_sw")).toEqual({ plan: "STARTER", cycle: "WEEKLY" });
    expect(getPlanFromPriceId("price_sm")).toEqual({ plan: "STARTER", cycle: "MONTHLY" });
    expect(getPlanFromPriceId("price_pm")).toEqual({ plan: "PLUS", cycle: "MONTHLY" });
    expect(getPlanFromPriceId("price_mm")).toEqual({ plan: "MAX", cycle: "MONTHLY" });
    expect(getPlanFromPriceId("price_unknown")).toBeNull();
  });
});
```

- [ ] **Step 2: Delete obsolete test file**

```bash
rm packages/shared/src/config/__tests__/plans.comprehensive.test.ts
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
docker compose exec web npx vitest run packages/shared/src/config/__tests__/plans.test.ts
```

Expected: all tests fail with "function not defined" or type errors.

- [ ] **Step 4: Rewrite plans.ts**

Replace contents of `packages/shared/src/config/plans.ts`:

```typescript
import type { Plan, BillingCycle } from "@prisma/client";

export interface PlanLimits {
  minutesPerPeriod: number;
  storageClips: number;
  retentionDays: number;
  subtitlePresets: string[];
  priorityQueue: boolean;
  concurrentJobsLimit: number;
  maxSourceDurationMinutes: number;
  maxFileSizeBytes: number;
  maxJobsPerDay: number;
  priceUsd: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

const ABUSE_CAPS = {
  maxSourceDurationMinutes: 180,
  maxFileSizeBytes: 2 * GB,
} as const;

export const PLAN_LIMITS: Record<
  Exclude<Plan, "NONE">,
  Record<BillingCycle, PlanLimits | null>
> = {
  STARTER: {
    WEEKLY: {
      minutesPerPeriod: 75,
      storageClips: 20,
      retentionDays: 7,
      subtitlePresets: ["tiktok"],
      priorityQueue: false,
      concurrentJobsLimit: 1,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 20,
      priceUsd: 3,
    },
    MONTHLY: {
      minutesPerPeriod: 270,
      storageClips: 20,
      retentionDays: 7,
      subtitlePresets: ["tiktok"],
      priorityQueue: false,
      concurrentJobsLimit: 1,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 20,
      priceUsd: 9,
    },
  },
  PLUS: {
    WEEKLY: null,
    MONTHLY: {
      minutesPerPeriod: 1000,
      storageClips: 150,
      retentionDays: 30,
      subtitlePresets: ["tiktok", "minimal", "bold"],
      priorityQueue: false,
      concurrentJobsLimit: 2,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 50,
      priceUsd: 29,
    },
  },
  MAX: {
    WEEKLY: null,
    MONTHLY: {
      minutesPerPeriod: 3500,
      storageClips: 1000,
      retentionDays: 90,
      subtitlePresets: ["tiktok", "minimal", "bold"],
      priorityQueue: true,
      concurrentJobsLimit: 3,
      maxSourceDurationMinutes: ABUSE_CAPS.maxSourceDurationMinutes,
      maxFileSizeBytes: ABUSE_CAPS.maxFileSizeBytes,
      maxJobsPerDay: 100,
      priceUsd: 89,
    },
  },
};

const NONE_LIMITS: PlanLimits = {
  minutesPerPeriod: 0,
  storageClips: 0,
  retentionDays: 0,
  subtitlePresets: [],
  priorityQueue: false,
  concurrentJobsLimit: 0,
  maxSourceDurationMinutes: 0,
  maxFileSizeBytes: 0,
  maxJobsPerDay: 0,
  priceUsd: 0,
};

export function getPlanLimits(plan: Plan, cycle?: BillingCycle): PlanLimits {
  if (plan === "NONE") return NONE_LIMITS;
  const cycleToUse = cycle ?? "MONTHLY";
  const limits = PLAN_LIMITS[plan][cycleToUse];
  if (!limits) throw new Error(`Plan ${plan} has no weekly cycle`);
  return limits;
}

export function getPlanFromPriceId(
  priceId: string
): { plan: Plan; cycle: BillingCycle } | null {
  const map: Record<string, { plan: Plan; cycle: BillingCycle }> = {
    [process.env.STRIPE_STARTER_WEEKLY_PRICE_ID ?? ""]: { plan: "STARTER", cycle: "WEEKLY" },
    [process.env.STRIPE_STARTER_MONTHLY_PRICE_ID ?? ""]: { plan: "STARTER", cycle: "MONTHLY" },
    [process.env.STRIPE_PLUS_MONTHLY_PRICE_ID ?? ""]: { plan: "PLUS", cycle: "MONTHLY" },
    [process.env.STRIPE_MAX_MONTHLY_PRICE_ID ?? ""]: { plan: "MAX", cycle: "MONTHLY" },
  };
  delete map[""];
  return map[priceId] ?? null;
}

export const TOPUP_PACKS = {
  SMALL: { minutes: 100, priceUsd: 6, envKey: "STRIPE_TOPUP_SMALL_PRICE_ID" },
  LARGE: { minutes: 300, priceUsd: 15, envKey: "STRIPE_TOPUP_LARGE_PRICE_ID" },
} as const;

export type TopupPack = keyof typeof TOPUP_PACKS;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
docker compose exec web npx vitest run packages/shared/src/config/__tests__/plans.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/config/plans.ts packages/shared/src/config/__tests__/
git commit -m "feat(plans): minute-based limits for Starter/Plus/Max tiers"
```

---

## Task 6: Create Usage Service (Minute-Based)

**Files:**
- Create: `packages/shared/src/services/usage.service.ts`
- Create: `packages/shared/src/services/__tests__/usage.service.test.ts`
- Modify: `packages/shared/src/services/index.ts`

**Why:** Replace the video-count `getWeeklyUsage` with minute-based tracking per Section 1.1. Usage needs a well-defined period boundary: for weekly users it's a rolling 7 days; for monthly, rolling 30 days. `topUpMinutesRemaining` is consulted when the primary period cap is exceeded.

- [ ] **Step 1: Write failing test**

Create `packages/shared/src/services/__tests__/usage.service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUniqueOrThrow: vi.fn() },
    job: { aggregate: vi.fn() },
  },
}));

import { prisma } from "../../lib/prisma";
import {
  getMinutesUsedInPeriod,
  getUsageForUser,
  canSubmitJob,
} from "../usage.service";

describe("usage.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getMinutesUsedInPeriod sums source durations in window", async () => {
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 1800 } });
    const minutes = await getMinutesUsedInPeriod("u1", new Date(), new Date());
    expect(minutes).toBe(30);
  });

  it("getMinutesUsedInPeriod returns 0 when no jobs", async () => {
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: null } });
    const minutes = await getMinutesUsedInPeriod("u1", new Date(), new Date());
    expect(minutes).toBe(0);
  });

  it("getUsageForUser returns plan limits and usage for STARTER monthly", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 1800 } });

    const usage = await getUsageForUser("u1");
    expect(usage.plan).toBe("STARTER");
    expect(usage.minutesUsed).toBe(30);
    expect(usage.minutesLimit).toBe(270);
    expect(usage.topUpMinutesRemaining).toBe(0);
  });

  it("canSubmitJob blocks when over period cap and no top-up", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      subscriptionStatus: "ACTIVE",
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });

    const result = await canSubmitJob("u1", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/limit/i);
  });

  it("canSubmitJob allows when over cap but top-up covers it", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 50,
      subscriptionStatus: "ACTIVE",
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 270 * 60 } });

    const result = await canSubmitJob("u1", 30);
    expect(result.allowed).toBe(true);
  });

  it("canSubmitJob blocks for NONE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      subscriptionStatus: "NONE",
      topUpMinutesRemaining: 0,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/subscription/i);
  });

  it("canSubmitJob blocks during DUNNING", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      subscriptionStatus: "DUNNING",
      topUpMinutesRemaining: 0,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/payment/i);
  });

  it("canSubmitJob blocks during CANCELED_GRACE (read-only)", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "PLUS",
      billingCycle: "MONTHLY",
      subscriptionStatus: "CANCELED_GRACE",
      topUpMinutesRemaining: 0,
    });

    const result = await canSubmitJob("u1", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/canceled|grace/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker compose exec web npx vitest run packages/shared/src/services/__tests__/usage.service.test.ts
```

Expected: file-not-found errors for the import.

- [ ] **Step 3: Add sourceDurationSec field to Job model**

First, we need a `sourceDurationSec` column on `Job` (not in the current schema). Add to `prisma/schema.prisma` on the Job model, next to `transcription`:

```prisma
sourceDurationSec Int?
```

Generate migration:

```bash
docker compose exec web npx prisma migrate dev --name job_source_duration
```

- [ ] **Step 4: Implement usage.service.ts**

Create `packages/shared/src/services/usage.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import type { Plan, BillingCycle } from "@prisma/client";

export async function getMinutesUsedInPeriod(
  userId: string,
  from: Date,
  to: Date
): Promise<number> {
  const result = await prisma.job.aggregate({
    where: {
      userId,
      createdAt: { gte: from, lte: to },
      status: { not: "FAILED" },
      sourceDurationSec: { not: null },
    },
    _sum: { sourceDurationSec: true },
  });
  const seconds = result._sum.sourceDurationSec ?? 0;
  return Math.ceil(seconds / 60);
}

function getPeriodStart(cycle: BillingCycle | null): Date {
  const d = new Date();
  if (cycle === "WEEKLY") {
    d.setDate(d.getDate() - 7);
  } else {
    d.setDate(d.getDate() - 30);
  }
  return d;
}

export interface UsageSummary {
  plan: Plan;
  billingCycle: BillingCycle | null;
  minutesUsed: number;
  minutesLimit: number;
  topUpMinutesRemaining: number;
  storageClipsLimit: number;
}

export async function getUsageForUser(userId: string): Promise<UsageSummary> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.plan === "NONE") {
    return {
      plan: "NONE",
      billingCycle: null,
      minutesUsed: 0,
      minutesLimit: 0,
      topUpMinutesRemaining: 0,
      storageClipsLimit: 0,
    };
  }
  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const periodStart = getPeriodStart(user.billingCycle);
  const minutesUsed = await getMinutesUsedInPeriod(
    userId,
    periodStart,
    new Date()
  );
  return {
    plan: user.plan,
    billingCycle: user.billingCycle,
    minutesUsed,
    minutesLimit: limits.minutesPerPeriod,
    topUpMinutesRemaining: user.topUpMinutesRemaining,
    storageClipsLimit: limits.storageClips,
  };
}

export interface JobSubmissionCheck {
  allowed: boolean;
  reason?: string;
}

export async function canSubmitJob(
  userId: string,
  jobDurationMinutes: number
): Promise<JobSubmissionCheck> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

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
  const periodStart = getPeriodStart(user.billingCycle);
  const used = await getMinutesUsedInPeriod(userId, periodStart, new Date());
  const projectedUsage = used + jobDurationMinutes;
  const totalAvailable = limits.minutesPerPeriod + user.topUpMinutesRemaining;

  if (projectedUsage > totalAvailable) {
    return {
      allowed: false,
      reason: `This job would exceed your minute limit (${used}/${limits.minutesPerPeriod} used, ${user.topUpMinutesRemaining} top-up available).`,
    };
  }

  return { allowed: true };
}
```

- [ ] **Step 5: Export from services index**

Edit `packages/shared/src/services/index.ts` and add:

```typescript
export * from "./usage.service";
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
docker compose exec web npx vitest run packages/shared/src/services/__tests__/usage.service.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/services/usage.service.ts packages/shared/src/services/__tests__/ packages/shared/src/services/index.ts prisma/schema.prisma prisma/migrations/
git commit -m "feat(usage): minute-based usage tracking with lifecycle state gating"
```

---

## Task 7: Update user.service.ts to Use New Usage Model

**Files:**
- Modify: `packages/shared/src/services/user.service.ts`

**Why:** The old `canCreateJob` and `getUsage` used video counts. Replace by delegating to `usage.service` and keep the API surface so callers don't break.

- [ ] **Step 1: Rewrite user.service.ts**

Replace contents of `packages/shared/src/services/user.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import type { User } from "@prisma/client";
import { getUsageForUser, canSubmitJob } from "./usage.service";

export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export async function getUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export async function getUserByTelegramId(
  telegramId: string
): Promise<User | null> {
  return prisma.user.findUnique({ where: { telegramId } });
}

export async function getUsage(userId: string) {
  return getUsageForUser(userId);
}

export async function canCreateJob(
  userId: string,
  jobDurationMinutes: number
): Promise<{ allowed: boolean; reason?: string }> {
  return canSubmitJob(userId, jobDurationMinutes);
}
```

- [ ] **Step 2: Find all callers of canCreateJob and update call sites**

```bash
grep -rn "canCreateJob" /srv/saas/clipclap.io --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected callers are in:
- `apps/web/app/api/jobs/route.ts`
- Possibly `apps/bot/`

For each caller, pass `jobDurationMinutes` (source duration in minutes). If the caller doesn't yet know this, pass 0 for now; Task 11 will fix job route.

- [ ] **Step 3: Run type-check**

```bash
docker compose exec web npx tsc --noEmit -p packages/shared/tsconfig.json
docker compose exec web npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/services/user.service.ts
git commit -m "refactor(user): delegate usage to minute-based usage.service"
```

---

## Task 8: Create Stripe Products and Set Price IDs

**Files:**
- Modify: `.env.example`
- Modify: `.env` (locally; do not commit)

**Why:** Stripe prices must be created in the Stripe Dashboard before webhooks and checkout can work. This is a manual step the user performs; we document the required products and env var names.

- [ ] **Step 1: Update .env.example**

Replace the Stripe section of `.env.example`:

```
# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Subscription price IDs (one per plan × cycle)
STRIPE_STARTER_WEEKLY_PRICE_ID=
STRIPE_STARTER_MONTHLY_PRICE_ID=
STRIPE_PLUS_MONTHLY_PRICE_ID=
STRIPE_MAX_MONTHLY_PRICE_ID=

# One-time top-up price IDs
STRIPE_TOPUP_SMALL_PRICE_ID=
STRIPE_TOPUP_LARGE_PRICE_ID=
```

- [ ] **Step 2: Write Stripe Dashboard setup instructions in spec or README**

Append to `docs/superpowers/specs/2026-04-19-clipclap-launch-design.md` a new section (or create `docs/runbooks/stripe-setup.md`) with exact instructions:

**Products to create in Stripe Dashboard (test mode first, then live):**

1. Product: **ClipClap Starter**
   - Price 1: `$3.00 USD recurring every week` → copy price ID to `STRIPE_STARTER_WEEKLY_PRICE_ID`
   - Price 2: `$9.00 USD recurring every month` → copy to `STRIPE_STARTER_MONTHLY_PRICE_ID`

2. Product: **ClipClap Plus**
   - Price: `$29.00 USD recurring every month` → `STRIPE_PLUS_MONTHLY_PRICE_ID`

3. Product: **ClipClap Max**
   - Price: `$89.00 USD recurring every month` → `STRIPE_MAX_MONTHLY_PRICE_ID`

4. Product: **ClipClap 100-minute top-up**
   - Price: `$6.00 USD one-time` → `STRIPE_TOPUP_SMALL_PRICE_ID`

5. Product: **ClipClap 300-minute top-up**
   - Price: `$15.00 USD one-time` → `STRIPE_TOPUP_LARGE_PRICE_ID`

6. Configure the Customer Portal (Settings → Billing → Customer portal): enable subscription cancel, payment method update. Disable plan switching via portal (we will handle upgrades via our own UI).

- [ ] **Step 3: Delete old env keys from local .env**

Edit `.env` to remove `STRIPE_STARTER_PRICE_ID` and `STRIPE_PRO_PRICE_ID`. Add the new keys with values from your Stripe Dashboard.

- [ ] **Step 4: Verify env loaded**

```bash
docker compose up -d
docker compose exec web node -e "console.log(Object.keys(process.env).filter(k => k.includes('STRIPE')).sort())"
```

Expected: lists all six new STRIPE_ keys.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/
git commit -m "chore(stripe): document v1 product setup, update env keys"
```

---

## Task 9: Rewrite billing.service.ts — Checkout for Plans + Cycles

**Files:**
- Modify: `packages/shared/src/services/billing.service.ts`
- Create: `packages/shared/src/services/__tests__/billing.service.test.ts`

**Why:** Current `createCheckoutSession` only handles STARTER/PRO without billing cycle. Need to route to correct price ID based on plan + cycle.

- [ ] **Step 1: Write failing test for createCheckoutSession**

Create `packages/shared/src/services/__tests__/billing.service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockStripe = {
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  subscriptions: { retrieve: vi.fn() },
  webhooks: { constructEvent: vi.fn() },
};

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => mockStripe),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from "../../lib/prisma";
import { createCheckoutSession } from "../billing.service";

describe("billing.service — createCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_STARTER_WEEKLY_PRICE_ID = "price_sw";
    process.env.STRIPE_STARTER_MONTHLY_PRICE_ID = "price_sm";
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_pm";
    process.env.STRIPE_MAX_MONTHLY_PRICE_ID = "price_mm";
  });

  it("routes STARTER+WEEKLY to correct price", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout" });

    await createCheckoutSession("u1", "STARTER", "WEEKLY", "https://x", "https://y");

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_sw", quantity: 1 }],
      })
    );
  });

  it("routes PLUS+MONTHLY to plus price", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout" });

    await createCheckoutSession("u1", "PLUS", "MONTHLY", "https://x", "https://y");

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_pm", quantity: 1 }],
      })
    );
  });

  it("rejects PLUS+WEEKLY (unsupported cycle)", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: "cus_1",
    });

    await expect(
      createCheckoutSession("u1", "PLUS", "WEEKLY", "https://x", "https://y")
    ).rejects.toThrow(/weekly/i);
  });

  it("creates Stripe customer if user has none", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      stripeCustomerId: null,
    });
    mockStripe.customers.create.mockResolvedValue({ id: "cus_new" });
    mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout" });

    await createCheckoutSession("u1", "STARTER", "MONTHLY", "https://x", "https://y");

    expect(mockStripe.customers.create).toHaveBeenCalledWith({
      email: "a@b.c",
      metadata: { userId: "u1" },
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { stripeCustomerId: "cus_new" },
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker compose exec web npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```

Expected: fails because signature differs.

- [ ] **Step 3: Rewrite createCheckoutSession**

Edit `packages/shared/src/services/billing.service.ts`. Replace the existing `createCheckoutSession` function (lines ~20-59) and the `PLAN_TO_PRICE_ID` / `getPriceIdToPlan` helpers (lines ~11-18) with:

```typescript
import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import { getPlanFromPriceId, TOPUP_PACKS } from "../config/plans";
import type { Plan, BillingCycle } from "@prisma/client";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is required");
  return new Stripe(key);
}

function priceIdFor(plan: Plan, cycle: BillingCycle): string {
  if (plan === "STARTER" && cycle === "WEEKLY") {
    return requireEnv("STRIPE_STARTER_WEEKLY_PRICE_ID");
  }
  if (plan === "STARTER" && cycle === "MONTHLY") {
    return requireEnv("STRIPE_STARTER_MONTHLY_PRICE_ID");
  }
  if (plan === "PLUS" && cycle === "MONTHLY") {
    return requireEnv("STRIPE_PLUS_MONTHLY_PRICE_ID");
  }
  if (plan === "MAX" && cycle === "MONTHLY") {
    return requireEnv("STRIPE_MAX_MONTHLY_PRICE_ID");
  }
  throw new Error(`Unsupported plan/cycle: ${plan}/${cycle} (no weekly for Plus or Max)`);
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

export async function createCheckoutSession(
  userId: string,
  plan: Exclude<Plan, "NONE">,
  cycle: BillingCycle,
  successUrl: string,
  cancelUrl: string
): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const stripe = getStripe();

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { userId },
    });
    customerId = customer.id;
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customerId },
    });
  }

  const priceId = priceIdFor(plan, cycle);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId, plan, cycle },
  });

  return session.url!;
}

export { getStripe, getPlanFromPriceId };
```

Keep the existing `handleWebhook` and `getSubscription` functions temporarily — they will be rewritten in Task 10.

- [ ] **Step 4: Run tests**

```bash
docker compose exec web npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/billing.service.ts packages/shared/src/services/__tests__/billing.service.test.ts
git commit -m "feat(billing): route checkout by plan and billing cycle"
```

---

## Task 10: Rewrite Stripe Webhook Handlers for Lifecycle

**Files:**
- Modify: `packages/shared/src/services/billing.service.ts`
- Modify: `packages/shared/src/services/__tests__/billing.service.test.ts`

**Why:** Spec sections 2.4 (failed payment dunning) and 2.5 (cancel grace) require setting `subscriptionStatus`, `dunningSince`, `graceEndsAt` on webhook events. The current handler only mutates `plan`.

- [ ] **Step 1: Add webhook tests**

Append to `packages/shared/src/services/__tests__/billing.service.test.ts`:

```typescript
import { handleWebhook } from "../billing.service";

describe("billing.service — handleWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_STARTER_MONTHLY_PRICE_ID = "price_sm";
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_pm";
  });

  it("checkout.session.completed activates subscription with plan and cycle", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { userId: "u1", plan: "PLUS", cycle: "MONTHLY" },
          subscription: "sub_1",
        },
      },
    });
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      items: { data: [{ price: { id: "price_pm" } }] },
      current_period_end: 1781000000,
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u1" },
        data: expect.objectContaining({
          plan: "PLUS",
          billingCycle: "MONTHLY",
          subscriptionStatus: "ACTIVE",
          stripeSubscriptionId: "sub_1",
          dunningSince: null,
          graceEndsAt: null,
        }),
      })
    );
  });

  it("invoice.payment_failed sets DUNNING status", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "invoice.payment_failed",
      data: {
        object: {
          subscription: "sub_1",
          customer: "cus_1",
        },
      },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1" },
        data: expect.objectContaining({
          subscriptionStatus: "DUNNING",
          dunningSince: expect.any(Date),
        }),
      })
    );
  });

  it("invoice.payment_succeeded clears DUNNING", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "invoice.payment_succeeded",
      data: {
        object: {
          subscription: "sub_1",
        },
      },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1" },
        data: expect.objectContaining({
          subscriptionStatus: "ACTIVE",
          dunningSince: null,
        }),
      })
    );
  });

  it("customer.subscription.deleted enters 7-day grace", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_1",
        },
      },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1" },
        data: expect.objectContaining({
          subscriptionStatus: "CANCELED_GRACE",
          graceEndsAt: expect.any(Date),
        }),
      })
    );
  });

  it("customer.subscription.updated with new price changes plan and cycle", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          items: { data: [{ price: { id: "price_pm" } }] },
          current_period_end: 1781000000,
        },
      },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: "sub_1" },
        data: expect.objectContaining({
          plan: "PLUS",
          billingCycle: "MONTHLY",
          currentPeriodEnd: expect.any(Date),
        }),
      })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
docker compose exec web npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```

Expected: new tests fail because handler does not set the new fields.

- [ ] **Step 3: Rewrite handleWebhook**

In `packages/shared/src/services/billing.service.ts`, replace the entire `handleWebhook` function with:

```typescript
export async function handleWebhook(
  body: string,
  signature: string
): Promise<void> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");

  const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      if (!userId) break;

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      if (!subscriptionId) break;

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;
      const mapped = priceId ? getPlanFromPriceId(priceId) : null;
      if (!mapped) break;

      await prisma.user.updateMany({
        where: { id: userId },
        data: {
          plan: mapped.plan,
          billingCycle: mapped.cycle,
          subscriptionStatus: "ACTIVE",
          stripeSubscriptionId: subscriptionId,
          dunningSince: null,
          graceEndsAt: null,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      });
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id;
      if (!subscriptionId) break;
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: {
          subscriptionStatus: "DUNNING",
          dunningSince: new Date(),
        },
      });
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id;
      if (!subscriptionId) break;
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: {
          subscriptionStatus: "ACTIVE",
          dunningSince: null,
        },
      });
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const graceEnd = new Date();
      graceEnd.setDate(graceEnd.getDate() + 7);
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: {
          subscriptionStatus: "CANCELED_GRACE",
          graceEndsAt: graceEnd,
        },
      });
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const mapped = priceId ? getPlanFromPriceId(priceId) : null;
      if (!mapped) break;
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: {
          plan: mapped.plan,
          billingCycle: mapped.cycle,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      });
      break;
    }
  }
}
```

- [ ] **Step 4: Run all billing tests**

```bash
docker compose exec web npx vitest run packages/shared/src/services/__tests__/billing.service.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/billing.service.ts packages/shared/src/services/__tests__/billing.service.test.ts
git commit -m "feat(billing): lifecycle webhook handlers — dunning, grace, plan change"
```

---

## Task 11: Implement Top-up Purchase Flow

**Files:**
- Create: `packages/shared/src/services/topup.service.ts`
- Create: `apps/web/app/api/billing/topup/route.ts`
- Modify: `packages/shared/src/services/billing.service.ts` (webhook extension for top-up)
- Modify: `packages/shared/src/services/index.ts`

**Why:** Spec Section 1.2 defines top-up packs. They are one-time Stripe Checkout sessions (mode=payment). On success, we credit the user's `topUpMinutesRemaining`.

- [ ] **Step 1: Create topup.service.ts**

Create `packages/shared/src/services/topup.service.ts`:

```typescript
import { prisma } from "../lib/prisma";
import { TOPUP_PACKS, type TopupPack } from "../config/plans";
import { getStripe } from "./billing.service";

export async function createTopupCheckoutSession(
  userId: string,
  pack: TopupPack,
  successUrl: string,
  cancelUrl: string
): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.stripeCustomerId) {
    throw new Error("User has no Stripe customer; subscribe to a plan first");
  }
  const stripe = getStripe();
  const priceId = process.env[TOPUP_PACKS[pack].envKey];
  if (!priceId) throw new Error(`Missing env: ${TOPUP_PACKS[pack].envKey}`);

  const session = await stripe.checkout.sessions.create({
    customer: user.stripeCustomerId,
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId, topupPack: pack, minutes: String(TOPUP_PACKS[pack].minutes) },
  });

  return session.url!;
}

export async function creditTopupMinutes(userId: string, minutes: number): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      topUpMinutesRemaining: { increment: minutes },
    },
  });
}
```

- [ ] **Step 2: Export from services index**

Edit `packages/shared/src/services/index.ts` and add:

```typescript
export * from "./topup.service";
```

- [ ] **Step 3: Add topup handling to webhook**

In `packages/shared/src/services/billing.service.ts`, in `handleWebhook`, extend the `checkout.session.completed` case to detect mode=payment:

```typescript
case "checkout.session.completed": {
  const session = event.data.object as Stripe.Checkout.Session;
  const userId = session.metadata?.userId;
  if (!userId) break;

  if (session.mode === "payment") {
    const minutes = Number(session.metadata?.minutes ?? "0");
    if (minutes > 0) {
      const { creditTopupMinutes } = await import("./topup.service");
      await creditTopupMinutes(userId, minutes);
    }
    break;
  }

  // Existing subscription path follows (unchanged)
  const subscriptionId = ...
  // ...rest of subscription handling
}
```

- [ ] **Step 4: Create topup API route**

Create `apps/web/app/api/billing/topup/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createTopupCheckoutSession } from "@clipfast/shared";
import { TOPUP_PACKS } from "@clipfast/shared";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { pack } = await req.json();
  if (pack !== "SMALL" && pack !== "LARGE") {
    return NextResponse.json(
      { error: "Invalid pack; must be SMALL or LARGE" },
      { status: 400 }
    );
  }

  try {
    const url = await createTopupCheckoutSession(
      session.user.id,
      pack,
      `${process.env.NEXTAUTH_URL}/dashboard?topup=success`,
      `${process.env.NEXTAUTH_URL}/dashboard?topup=canceled`
    );
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create top-up" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 5: Add topup test**

Append to `packages/shared/src/services/__tests__/billing.service.test.ts`:

```typescript
describe("billing.service — topup webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("top-up checkout credits minutes to user", async () => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          metadata: { userId: "u1", topupPack: "SMALL", minutes: "100" },
        },
      },
    });

    await handleWebhook("body", "sig");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { topUpMinutesRemaining: { increment: 100 } },
    });
  });
});
```

- [ ] **Step 6: Run tests**

```bash
docker compose exec web npx vitest run packages/shared/src/services/__tests__/
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/services/topup.service.ts packages/shared/src/services/index.ts apps/web/app/api/billing/topup/ packages/shared/src/services/billing.service.ts packages/shared/src/services/__tests__/billing.service.test.ts
git commit -m "feat(billing): top-up packs (100min $6, 300min $15) via one-time Stripe Checkout"
```

---

## Task 12: Abuse Protection on Job Submission API

**Files:**
- Modify: `apps/web/app/api/jobs/route.ts`

**Why:** Spec Section 1.6 defines hard abuse caps (max duration, max jobs/day, concurrent limit). The API must validate before enqueuing.

- [ ] **Step 1: Read current route**

Read `apps/web/app/api/jobs/route.ts` to understand the current POST handler shape. Note the current field names (sourceUrl, sourceKey, subtitlePreset, etc.).

- [ ] **Step 2: Extend POST handler with abuse checks**

Prepend these checks before the existing `jobService.createJob` call in the POST handler:

```typescript
import { getPlanLimits, canSubmitJob } from "@clipfast/shared";
import { prisma } from "@clipfast/shared";

// Inside POST, after auth check and req.json parsing:
const user = await prisma.user.findUniqueOrThrow({
  where: { id: session.user.id },
});

if (user.plan === "NONE") {
  return NextResponse.json(
    { error: "Active subscription required to create jobs" },
    { status: 402 }
  );
}

const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");

// Client must send sourceDurationSec (detected client-side for uploads, or from yt-dlp probe for URLs)
const sourceDurationSec: number | undefined = body.sourceDurationSec;
if (typeof sourceDurationSec === "number") {
  const durationMinutes = Math.ceil(sourceDurationSec / 60);
  if (durationMinutes > limits.maxSourceDurationMinutes) {
    return NextResponse.json(
      { error: `Source exceeds max duration (${limits.maxSourceDurationMinutes} min). Trim before uploading.` },
      { status: 400 }
    );
  }

  const subCheck = await canSubmitJob(session.user.id, durationMinutes);
  if (!subCheck.allowed) {
    return NextResponse.json({ error: subCheck.reason }, { status: 402 });
  }
}

// Max jobs per day
const dayStart = new Date();
dayStart.setHours(0, 0, 0, 0);
const jobsToday = await prisma.job.count({
  where: { userId: session.user.id, createdAt: { gte: dayStart } },
});
if (jobsToday >= limits.maxJobsPerDay) {
  return NextResponse.json(
    { error: `Daily job limit reached (${limits.maxJobsPerDay}). Try again tomorrow or upgrade.` },
    { status: 429 }
  );
}

// Concurrent in-flight jobs
const activeStatuses = ["PENDING", "DOWNLOADING", "TRANSCRIBING", "ANALYZING", "CUTTING"] as const;
const inFlight = await prisma.job.count({
  where: { userId: session.user.id, status: { in: [...activeStatuses] } },
});
if (inFlight >= limits.concurrentJobsLimit) {
  return NextResponse.json(
    { error: `You have ${inFlight} active jobs (limit: ${limits.concurrentJobsLimit}). Wait for one to finish.` },
    { status: 429 }
  );
}
```

The concurrent check is intentionally a plain count here; atomic enforcement is a Plan 3 task (Redis semaphore). For MVP, race conditions on concurrent submissions at this scale are acceptable.

- [ ] **Step 3: Extend jobService.createJob to accept sourceDurationSec**

In `packages/shared/src/services/job.service.ts`, update the `createJob` function signature to accept and persist `sourceDurationSec`. Example:

```typescript
export interface CreateJobInput {
  userId: string;
  sourceUrl?: string;
  sourceKey?: string;
  originalFilename?: string;
  subtitles?: boolean;
  subtitlePreset?: string;
  sourceDurationSec?: number;
}
```

Update the `prisma.job.create` call to include `sourceDurationSec`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/jobs/route.ts packages/shared/src/services/job.service.ts
git commit -m "feat(jobs): abuse protections (duration, daily cap, concurrent limit) on submission"
```

---

## Task 13: Abuse Protection on Upload URL Endpoint

**Files:**
- Modify: `apps/web/app/api/uploads/route.ts`

**Why:** Spec Section 3.6 + Section 1.6: the presigned upload URL endpoint must reject files that would violate plan's `maxFileSizeBytes`. Without this, users upload the full 2GB to R2 before we discover it's too big.

- [ ] **Step 1: Rewrite uploads route**

Replace contents of `apps/web/app/api/uploads/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPresignedUploadUrl, getPlanLimits, prisma } from "@clipfast/shared";
import { randomUUID } from "crypto";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { filename, contentType, fileSizeBytes } = body;

  if (!filename || !contentType) {
    return NextResponse.json(
      { error: "filename and contentType are required" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
  });

  if (user.plan === "NONE") {
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

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");

  if (typeof fileSizeBytes === "number" && fileSizeBytes > limits.maxFileSizeBytes) {
    const maxGb = (limits.maxFileSizeBytes / (1024 * 1024 * 1024)).toFixed(1);
    return NextResponse.json(
      { error: `File too large; max ${maxGb} GB` },
      { status: 413 }
    );
  }

  const ext = filename.split(".").pop() || "mp4";
  const key = `uploads/${session.user.id}/${randomUUID()}.${ext}`;
  const uploadUrl = await getPresignedUploadUrl(key, contentType);

  return NextResponse.json({ uploadUrl, key });
}
```

- [ ] **Step 2: Update upload-zone.tsx to send fileSizeBytes**

Edit `apps/web/components/upload-zone.tsx`. In the fetch call to `/api/uploads`, update the body to include `fileSizeBytes: file.size`:

```typescript
const { uploadUrl, key } = await fetch("/api/uploads", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    filename: file.name,
    contentType: file.type,
    fileSizeBytes: file.size,
  }),
}).then((r) => r.json());
```

Also add client-side duration detection for video files before issuing the upload: use a hidden `<video>` element, set `src` to `URL.createObjectURL(file)`, read `duration` on `loadedmetadata`. Send the detected duration when you POST to `/api/jobs`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/uploads/route.ts apps/web/components/upload-zone.tsx
git commit -m "feat(uploads): reject oversize files and locked-out subs before presigned URL"
```

---

## Task 14: Update Plans Page UI for New Tiers

**Files:**
- Modify: `apps/web/app/(dashboard)/dashboard/plans/page.tsx`
- Modify: `apps/web/components/plan-card.tsx`

**Why:** The current plans page shows FREE/STARTER/PRO with weekly prices. Must show STARTER (weekly+monthly), PLUS (monthly), MAX (monthly) with new limits.

- [ ] **Step 1: Rewrite plans page**

Replace contents of `apps/web/app/(dashboard)/dashboard/plans/page.tsx`:

```typescript
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUsageForUser, PLAN_LIMITS, TOPUP_PACKS } from "@clipfast/shared";
import { PlanCard } from "@/components/plan-card";

export default async function PlansPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await getUsageForUser(session.user.id);
  const currentPlan = usage.plan;
  const currentCycle = usage.billingCycle;

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Choose a plan that fits your workflow. Cancel anytime.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        <PlanCard
          name="Starter"
          planKey="STARTER"
          cycleOptions={[
            { label: "Weekly", cycle: "WEEKLY", priceUsd: 3, minutes: 75 },
            { label: "Monthly", cycle: "MONTHLY", priceUsd: 9, minutes: 270 },
          ]}
          features={[
            "Up to 180 min per upload",
            "20 clips stored",
            "7-day retention",
            "TikTok subtitle style",
          ]}
          current={currentPlan === "STARTER"}
          currentCycle={currentCycle}
        />
        <PlanCard
          name="Plus"
          planKey="PLUS"
          cycleOptions={[
            { label: "Monthly", cycle: "MONTHLY", priceUsd: 29, minutes: 1000 },
          ]}
          features={[
            "Up to 180 min per upload",
            "150 clips stored",
            "30-day retention",
            "3 subtitle styles",
            "2 jobs at once",
          ]}
          current={currentPlan === "PLUS"}
          currentCycle={currentCycle}
          highlighted
        />
        <PlanCard
          name="Max"
          planKey="MAX"
          cycleOptions={[
            { label: "Monthly", cycle: "MONTHLY", priceUsd: 89, minutes: 3500 },
          ]}
          features={[
            "Up to 180 min per upload",
            "1000 clips stored",
            "90-day retention",
            "All subtitle styles",
            "3 jobs at once",
            "Priority processing",
          ]}
          current={currentPlan === "MAX"}
          currentCycle={currentCycle}
        />
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Need more minutes?</h2>
        <p className="text-sm text-muted-foreground">
          Top up without changing your plan. Credits expire at the end of your current period.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
          <TopupCard pack="SMALL" minutes={100} priceUsd={6} />
          <TopupCard pack="LARGE" minutes={300} priceUsd={15} />
        </div>
      </section>
    </div>
  );
}

function TopupCard({
  pack,
  minutes,
  priceUsd,
}: {
  pack: "SMALL" | "LARGE";
  minutes: number;
  priceUsd: number;
}) {
  return (
    <form action="/api/billing/topup" method="POST" className="rounded-lg border border-border p-4 flex items-center justify-between">
      <div>
        <p className="font-medium">+{minutes} minutes</p>
        <p className="text-xs text-muted-foreground">${priceUsd} one-time</p>
      </div>
      <button
        type="submit"
        name="pack"
        value={pack}
        className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-neutral-200"
      >
        Buy
      </button>
    </form>
  );
}
```

Note: `TopupCard` form-action is a simplified server-action shortcut; if the existing codebase uses a client-side pattern, use `fetch('/api/billing/topup', {method: 'POST', body: JSON.stringify({pack})})` instead.

- [ ] **Step 2: Rewrite plan-card.tsx**

Replace contents of `apps/web/components/plan-card.tsx`. Reference the existing component to match the existing visual style (dark theme, rounded borders). The new component accepts multiple cycle options and a current-state indicator:

```typescript
"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type { Plan, BillingCycle } from "@prisma/client";

interface CycleOption {
  label: string;
  cycle: BillingCycle;
  priceUsd: number;
  minutes: number;
}

interface PlanCardProps {
  name: string;
  planKey: Exclude<Plan, "NONE">;
  cycleOptions: CycleOption[];
  features: string[];
  current?: boolean;
  currentCycle?: BillingCycle | null;
  highlighted?: boolean;
}

export function PlanCard({
  name,
  planKey,
  cycleOptions,
  features,
  current,
  currentCycle,
  highlighted,
}: PlanCardProps) {
  const [selectedCycle, setSelectedCycle] = useState<BillingCycle>(
    cycleOptions[0]?.cycle ?? "MONTHLY"
  );
  const selected = cycleOptions.find((c) => c.cycle === selectedCycle)!;
  const [loading, setLoading] = useState(false);

  const onSubscribe = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planKey, cycle: selectedCycle }),
      });
      const { url, error } = await r.json();
      if (url) window.location.href = url;
      else alert(error ?? "Failed to start checkout");
    } finally {
      setLoading(false);
    }
  };

  const isCurrent = current && currentCycle === selectedCycle;

  return (
    <div
      className={`relative rounded-2xl border p-6 ${
        highlighted
          ? "border-white/20 bg-white/[0.03]"
          : "border-white/[0.06] bg-white/[0.01]"
      }`}
    >
      {highlighted && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-white px-3 py-0.5 text-[11px] font-semibold text-black">
          Popular
        </span>
      )}
      <h3 className="font-semibold">{name}</h3>

      {cycleOptions.length > 1 && (
        <div className="mt-3 flex gap-1 rounded-md bg-white/[0.04] p-1">
          {cycleOptions.map((c) => (
            <button
              key={c.cycle}
              onClick={() => setSelectedCycle(c.cycle)}
              className={`flex-1 rounded px-2 py-1 text-xs ${
                selectedCycle === c.cycle
                  ? "bg-white/[0.08] text-white"
                  : "text-neutral-400"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <p className="mt-4">
        <span className="text-3xl font-bold tabular-nums">${selected.priceUsd}</span>
        <span className="text-sm text-neutral-600">
          /{selected.cycle === "WEEKLY" ? "week" : "month"}
        </span>
      </p>
      <p className="text-xs text-muted-foreground mt-1">{selected.minutes} minutes</p>

      <ul className="mt-5 space-y-2 text-sm text-neutral-400">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check className="w-3.5 h-3.5 text-neutral-500 mt-0.5 flex-shrink-0" />
            {f}
          </li>
        ))}
      </ul>

      <button
        onClick={onSubscribe}
        disabled={loading || isCurrent}
        className={`mt-6 block w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-all ${
          isCurrent
            ? "bg-white/[0.04] text-neutral-500 cursor-not-allowed"
            : highlighted
            ? "bg-white text-black hover:bg-neutral-200"
            : "bg-white/[0.06] text-white hover:bg-white/[0.1]"
        } disabled:opacity-60`}
      >
        {isCurrent ? "Current plan" : loading ? "Loading..." : "Subscribe"}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Update billing checkout route to accept plan+cycle**

Edit `apps/web/app/api/billing/checkout/route.ts` — inspect current signature, update to accept `{plan, cycle}` from body and pass to `createCheckoutSession`:

```typescript
const { plan, cycle } = await req.json();
const url = await createCheckoutSession(
  session.user.id,
  plan,
  cycle,
  `${process.env.NEXTAUTH_URL}/dashboard?subscribed=true`,
  `${process.env.NEXTAUTH_URL}/dashboard/plans`
);
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/(dashboard)/dashboard/plans/ apps/web/components/plan-card.tsx apps/web/app/api/billing/checkout/
git commit -m "feat(plans-ui): new tier cards with cycle toggle + top-up purchase"
```

---

## Task 15: Update Sidebar Usage Display

**Files:**
- Modify: `apps/web/components/sidebar.tsx`
- Modify: `apps/web/components/usage-bar.tsx`
- Modify: `apps/web/app/(dashboard)/layout.tsx`

**Why:** Sidebar currently shows `videosUsed/videosLimit`. Must show `minutesUsed/minutesLimit` with top-up indicator.

- [ ] **Step 1: Update layout to pass minute usage**

Edit `apps/web/app/(dashboard)/layout.tsx`. The current call `userService.getUsage(...)` returns `{videosUsed, videosLimit, plan}` — it now returns `{minutesUsed, minutesLimit, topUpMinutesRemaining, plan, billingCycle, storageClipsLimit}`. Update the `<Sidebar>` props:

```typescript
<Sidebar
  user={{
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    avatarUrl: session.user.image ?? null,
  }}
  usage={{
    minutesUsed: usage.minutesUsed,
    minutesLimit: usage.minutesLimit,
    topUpRemaining: usage.topUpMinutesRemaining,
    plan: usage.plan,
  }}
/>
```

- [ ] **Step 2: Update sidebar interface and rendering**

Edit `apps/web/components/sidebar.tsx`. Change `SidebarProps.usage`:

```typescript
usage: {
  minutesUsed: number;
  minutesLimit: number;
  topUpRemaining: number;
  plan: string;
};
```

And pass to UsageBar:

```tsx
<UsageBar
  used={usage.minutesUsed}
  limit={usage.minutesLimit}
  topup={usage.topUpRemaining}
  plan={usage.plan}
/>
```

Also: hide the `Upgrade` link when `plan === "MAX"` (already satisfied). Add a simple guard:

```tsx
{usage.plan !== "MAX" && (
  <Link href="/dashboard/plans" ...>Upgrade</Link>
)}
```

- [ ] **Step 3: Update UsageBar component**

Edit `apps/web/components/usage-bar.tsx`. Accept new props:

```typescript
interface UsageBarProps {
  used: number;
  limit: number;
  topup: number;
  plan: string;
}

export function UsageBar({ used, limit, topup, plan }: UsageBarProps) {
  if (plan === "NONE" || limit === 0) {
    return (
      <div className="rounded-md border border-border p-3">
        <p className="text-xs text-muted-foreground">No active plan</p>
      </div>
    );
  }

  const percent = Math.min(100, Math.round((used / limit) * 100));
  const critical = percent >= 90;

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Minutes</span>
        <span className="tabular-nums">{used} / {limit}</span>
      </div>
      <div className="h-1.5 rounded bg-white/[0.06] overflow-hidden">
        <div
          className={`h-full ${critical ? "bg-red-500" : "bg-white/70"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {topup > 0 && (
        <p className="text-[11px] text-emerald-400">+{topup} top-up min</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/sidebar.tsx apps/web/components/usage-bar.tsx apps/web/app/(dashboard)/layout.tsx
git commit -m "feat(sidebar): minute-based usage bar with top-up indicator"
```

---

## Task 16: Stripe Customer Portal Route

**Files:**
- Create: `apps/web/app/api/billing/portal/route.ts`
- Modify: `apps/web/app/(dashboard)/dashboard/settings/page.tsx`

**Why:** Users need a way to cancel their subscription, update payment method. Stripe's Customer Portal handles this; we just need an endpoint that creates a session URL.

- [ ] **Step 1: Create portal route**

Create `apps/web/app/api/billing/portal/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma, getStripe } from "@clipfast/shared";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
  });
  if (!user.stripeCustomerId) {
    return NextResponse.json(
      { error: "No Stripe customer; subscribe first" },
      { status: 400 }
    );
  }

  const stripe = getStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${process.env.NEXTAUTH_URL}/dashboard/settings`,
  });

  return NextResponse.json({ url: portal.url });
}
```

- [ ] **Step 2: Export getStripe from shared**

Ensure `getStripe` is exported from `packages/shared/src/services/billing.service.ts` (added in Task 9 step 3). Then ensure it's re-exported through `packages/shared/src/services/index.ts` — add if missing:

```typescript
export { getStripe } from "./billing.service";
```

- [ ] **Step 3: Add "Manage billing" link to Settings**

Edit `apps/web/app/(dashboard)/dashboard/settings/page.tsx`. Add a new section after the Profile section:

```tsx
<div className="space-y-4">
  <h2 className="text-lg font-semibold">Billing</h2>
  <p className="text-sm text-muted-foreground">
    Update your payment method or cancel your subscription.
  </p>
  <form action="/api/billing/portal" method="POST">
    <button
      type="submit"
      className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
    >
      Manage billing
    </button>
  </form>
</div>
```

If the form-action approach doesn't match the codebase's existing pattern, use a client component that fetches and redirects:

```tsx
"use client";
function ManageBillingButton() {
  return (
    <button
      onClick={async () => {
        const r = await fetch("/api/billing/portal", { method: "POST" });
        const { url, error } = await r.json();
        if (url) window.location.href = url;
        else alert(error);
      }}
      className="..."
    >
      Manage billing
    </button>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/billing/portal/ apps/web/app/(dashboard)/dashboard/settings/page.tsx packages/shared/src/services/index.ts
git commit -m "feat(billing): Stripe Customer Portal for self-serve management"
```

---

## Task 17: Compute expiresAt on Clip Creation

**Files:**
- Modify: `packages/shared/src/services/clip.service.ts` (or whichever creates clips)
- Modify: `apps/worker/src/processors/cut.ts` (or wherever Clip rows are inserted)

**Why:** Spec Section 2.1 invariant: `expiresAt = created_at + retentionDays`. Set this at insert time so Plan 2's cleanup can query cheaply. Retention comes from the user's plan at time of creation.

- [ ] **Step 1: Find clip creation sites**

```bash
grep -rn "prisma.clip.create" /srv/saas/clipclap.io --include="*.ts" | grep -v node_modules
```

- [ ] **Step 2: Update each call site**

For each `prisma.clip.create` call, wrap the data:

```typescript
import { getPlanLimits } from "@clipfast/shared";

// Fetch user plan once per job:
const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
const expiresAt = new Date();
expiresAt.setDate(expiresAt.getDate() + limits.retentionDays);

await prisma.clip.create({
  data: {
    // ...existing fields
    expiresAt,
  },
});
```

Apply consistently across all creation sites so no clip is created without `expiresAt`.

- [ ] **Step 3: Add a service-level helper to avoid repetition**

Create `packages/shared/src/lib/retention.ts`:

```typescript
import { getPlanLimits } from "../config/plans";
import type { Plan, BillingCycle } from "@prisma/client";

export function computeClipExpiresAt(
  plan: Plan,
  cycle: BillingCycle | null,
  createdAt: Date = new Date()
): Date {
  if (plan === "NONE") {
    // Clips should not be created without a plan, but defensive
    return new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  }
  const limits = getPlanLimits(plan, cycle ?? "MONTHLY");
  const out = new Date(createdAt);
  out.setDate(out.getDate() + limits.retentionDays);
  return out;
}
```

Export from `packages/shared/src/index.ts`:

```typescript
export * from "./lib/retention";
```

Refactor the clip creation sites to use `computeClipExpiresAt(user.plan, user.billingCycle)`.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/lib/retention.ts packages/shared/src/index.ts apps/worker/src/processors/cut.ts packages/shared/src/services/clip.service.ts
git commit -m "feat(clips): set expiresAt on creation based on user retention"
```

---

## Task 18: End-to-End Manual Verification

**Files:**
- None (this is a test run using Stripe test mode)

**Why:** The payment → subscribe → upload → job flow has many moving parts. Manual verification in the Stripe test dashboard catches edge cases that unit tests miss.

- [ ] **Step 1: Start full stack**

```bash
docker compose up -d --build
docker compose logs -f web
```

Watch for clean startup, no errors.

- [ ] **Step 2: Set up Stripe webhook forwarding (local testing)**

In a separate terminal:

```bash
stripe listen --forward-to https://clipclap.io/api/billing/webhook
```

Copy the `whsec_...` secret into `.env` as `STRIPE_WEBHOOK_SECRET`, then `docker compose restart web`.

- [ ] **Step 3: Test subscribe flow**

1. Open `https://clipclap.io/login`, sign in with Google
2. Navigate to `/dashboard/plans`
3. Click "Subscribe" on Starter → select Weekly
4. In Stripe Checkout, use test card `4242 4242 4242 4242`, any future date, any CVC
5. Verify redirect back to dashboard
6. Check DB:

```bash
docker compose exec postgres psql -U clipfast -d clipfast -c "SELECT email, plan, \"billingCycle\", \"subscriptionStatus\", \"currentPeriodEnd\" FROM users ORDER BY \"updatedAt\" DESC LIMIT 1;"
```

Expected: `plan=STARTER, billingCycle=WEEKLY, subscriptionStatus=ACTIVE`.

- [ ] **Step 4: Test upload and job creation**

1. On dashboard, upload a short test video (30–60 seconds)
2. Open browser DevTools, confirm direct PUT to R2 (not through Next.js)
3. Job should appear in the dashboard with `PENDING` status
4. Check the worker logs:

```bash
docker compose logs -f worker
```

Expected: pipeline runs to `DONE`, clips appear in dashboard.

- [ ] **Step 5: Verify abuse limits**

1. Try to submit a job while having 2 in-flight (Starter plan): second submission should return 429 with the limit message
2. Try to upload a 3GB fake file (create with `dd if=/dev/zero of=big.mp4 bs=1M count=3000` if needed): request to `/api/uploads` should return 413

- [ ] **Step 6: Test failed payment webhook**

From Stripe Dashboard:
1. Go to Customers → [your test customer] → Subscription
2. Click "..." menu → "Charge customer now" — but with a card Stripe flags as failing (use test card `4000 0000 0000 0341`)
3. Wait for the `invoice.payment_failed` event to fire
4. Check DB:

```bash
docker compose exec postgres psql -U clipfast -d clipfast -c "SELECT email, \"subscriptionStatus\", \"dunningSince\" FROM users ORDER BY \"updatedAt\" DESC LIMIT 1;"
```

Expected: `subscriptionStatus=DUNNING, dunningSince=<timestamp>`.

5. Try to submit a new job: must return 402 with the "payment failed" message.

- [ ] **Step 7: Test subscription cancel**

From Customer Portal (or Stripe Dashboard directly), cancel the subscription immediately.

Check DB:

```bash
docker compose exec postgres psql -U clipfast -d clipfast -c "SELECT email, \"subscriptionStatus\", \"graceEndsAt\" FROM users ORDER BY \"updatedAt\" DESC LIMIT 1;"
```

Expected: `subscriptionStatus=CANCELED_GRACE, graceEndsAt=<now+7d>`.

- [ ] **Step 8: Test top-up**

1. On plans page, click "Buy" on +100 min top-up
2. Complete Stripe Checkout
3. Check DB:

```bash
docker compose exec postgres psql -U clipfast -d clipfast -c "SELECT email, \"topUpMinutesRemaining\" FROM users ORDER BY \"updatedAt\" DESC LIMIT 1;"
```

Expected: `topUpMinutesRemaining=100` (or 100 + any previous balance).

- [ ] **Step 9: Commit any fixes discovered during testing**

If bugs were found and fixed, commit them. Otherwise this task has no commit.

```bash
git status  # confirm clean
```

---

## Self-Review Checklist

Before handing off to execution:

- [ ] **Spec coverage:**
  - Section 1 (Pricing): Tasks 5, 8, 9, 11, 14 ✓
  - Section 2.1-2.3 (retention data model): Tasks 3, 17 ✓
  - Sections 2.4-2.7 (lifecycle scenarios): Task 10 (state transitions only; cleanup is Plan 2) ✓
  - Section 2.8 (GDPR erasure): NOT COVERED — intentional, Plan 2 scope
  - Section 2.9 (source video lifecycle): already implemented in current pipeline ✓
  - Section 2.10-2.11 (cleanup mechanism): Plan 2 scope
  - Section 3.6 (direct-to-R2 upload): Task 13 ✓
  - Section 3.7 (API rate limiting): NOT COVERED — Plan 3 scope
  - Section 1.6 (abuse protections): Task 12, 13 ✓

- [ ] **Placeholder scan:** no "TODO", no "TBD", no "fill in", no "similar to".

- [ ] **Type consistency:**
  - `BillingCycle` values are `WEEKLY | MONTHLY` throughout ✓
  - `SubscriptionStatus` values are `NONE | ACTIVE | DUNNING | CANCELED_GRACE | CANCELED` throughout ✓
  - `getPlanLimits(plan, cycle)` signature consistent across usage.service, billing.service, API routes ✓
  - `canSubmitJob(userId, durationMinutes)` signature consistent ✓

- [ ] **Gaps:** Task 17 depends on user.plan being set before clip creation. For users whose plan changes during a job (rare edge case), clip inherits the plan at creation time — acceptable.

---

**Plan complete and saved to [docs/superpowers/plans/2026-04-19-clipclap-billing-foundation.md](docs/superpowers/plans/2026-04-19-clipclap-billing-foundation.md).**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
