# Subscription Liveness Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram Account card and the video-submission gate agree about whether a subscription is usable, and make stuck `ACTIVE` rows self-heal, by introducing one shared liveness predicate.

**Architecture:** A new pure module `subscription-state.ts` in `packages/shared` owns the lifecycle rule (`getSubscriptionState` + `isPeriodLive`). The video gate (`canSubmitJob`), the account card (`getUsageForUser` + bot `accountText`), and the hourly reconcile cron all consume it, so no surface can compute liveness differently. The reconcile cron gains the missing branch for provider-less rows. The web dashboard is untouched.

**Tech Stack:** TypeScript, Prisma, Vitest, grammY (Telegram bot), npm workspaces.

**Reference spec:** `docs/superpowers/specs/2026-07-14-subscription-liveness-consistency-design.md`

---

## Setup

Work on a feature branch, not `main`:

```bash
cd /srv/dev/clipclap.io
git checkout -b fix/subscription-liveness-consistency
```

Commit identity is `Trowgar <trowgar@yahoo.com>` (repo default); no Claude attribution trailer. All test/build commands run from the repo root `/srv/dev/clipclap.io` (the host has `node_modules/.bin/vitest`).

## File Structure

- **Create** `packages/shared/src/services/subscription-state.ts` — pure lifecycle predicate. No DB, no imports beyond Prisma types + grace config. Owns `SubscriptionPhase`, `SubscriptionState`, `isPeriodLive`, `getSubscriptionState`.
- **Create** `packages/shared/src/services/__tests__/subscription-state.test.ts` — unit tests for the predicate.
- **Modify** `packages/shared/src/services/index.ts` — export the new module.
- **Modify** `packages/shared/src/services/usage.service.ts` — `canSubmitJob` and `getUsageForUser` consume the predicate; `UsageSummary` gains `subscriptionState`.
- **Modify** `packages/shared/src/services/__tests__/usage.service.test.ts` — cover the new field + unchanged gate behavior.
- **Modify** `packages/shared/src/services/subscription-reconcile.service.ts` — reuse `isPeriodLive`; add the provider-less branch.
- **Modify** `packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts` — cover the provider-less branch.
- **Modify** `apps/bot/src/i18n.ts` — `accountText` renders honestly per `phase` (EN + RU).
- **Modify** `apps/bot/src/__tests__/i18n.test.ts` — cover PERIOD_ENDED / CANCELED rendering.
- **Modify** `apps/bot/src/handlers.ts` — `sendAccountView` passes `phase` into `accountText`.

---

## Task 1: Shared liveness predicate (`subscription-state.ts`)

**Files:**
- Create: `packages/shared/src/services/subscription-state.ts`
- Test: `packages/shared/src/services/__tests__/subscription-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/subscription-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../../config/billing";
import { getSubscriptionState, isPeriodLive } from "../subscription-state";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-14T12:00:00Z");

function user(overrides: Record<string, unknown>) {
  return {
    plan: "MAX",
    subscriptionStatus: "ACTIVE",
    currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY),
    ...overrides,
  } as any;
}

describe("isPeriodLive", () => {
  it("is false for a null period end", () => {
    expect(isPeriodLive(null, NOW)).toBe(false);
  });
  it("is true within grace after period end", () => {
    expect(isPeriodLive(new Date(NOW.getTime() - 1 * DAY), NOW)).toBe(true);
  });
  it("is false once grace has elapsed", () => {
    expect(
      isPeriodLive(
        new Date(NOW.getTime() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * DAY),
        NOW
      )
    ).toBe(false);
  });
  it("is false exactly at the grace boundary (half-open interval)", () => {
    expect(
      isPeriodLive(
        new Date(NOW.getTime() - SUBSCRIPTION_GRACE_BUFFER_DAYS * DAY),
        NOW
      )
    ).toBe(false);
  });
});

describe("getSubscriptionState", () => {
  it("NONE plan -> phase NONE, not live", () => {
    expect(
      getSubscriptionState(user({ plan: "NONE", subscriptionStatus: "NONE" }), NOW)
    ).toEqual({ phase: "NONE", live: false });
  });
  it("status NONE -> phase NONE, not live", () => {
    expect(
      getSubscriptionState(user({ subscriptionStatus: "NONE" }), NOW)
    ).toEqual({ phase: "NONE", live: false });
  });
  it("CANCELED -> not live", () => {
    expect(
      getSubscriptionState(user({ subscriptionStatus: "CANCELED" }), NOW)
    ).toEqual({ phase: "CANCELED", live: false });
  });
  it("CANCELED_GRACE -> not live (matches the gate)", () => {
    expect(
      getSubscriptionState(user({ subscriptionStatus: "CANCELED_GRACE" }), NOW)
    ).toEqual({ phase: "CANCELED_GRACE", live: false });
  });
  it("ACTIVE with a future period -> live", () => {
    expect(
      getSubscriptionState(user({ subscriptionStatus: "ACTIVE" }), NOW)
    ).toEqual({ phase: "ACTIVE", live: true });
  });
  it("DUNNING within grace -> live", () => {
    expect(
      getSubscriptionState(
        user({
          subscriptionStatus: "DUNNING",
          currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
        }),
        NOW
      )
    ).toEqual({ phase: "DUNNING", live: true });
  });
  it("ACTIVE whose period ended past grace -> PERIOD_ENDED, not live (the reported bug)", () => {
    expect(
      getSubscriptionState(
        user({
          subscriptionStatus: "ACTIVE",
          currentPeriodEnd: new Date(
            NOW.getTime() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 1) * DAY
          ),
        }),
        NOW
      )
    ).toEqual({ phase: "PERIOD_ENDED", live: false });
  });
  it("ACTIVE with a null period end -> PERIOD_ENDED, not live", () => {
    expect(
      getSubscriptionState(
        user({ subscriptionStatus: "ACTIVE", currentPeriodEnd: null }),
        NOW
      )
    ).toEqual({ phase: "PERIOD_ENDED", live: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/src/services/__tests__/subscription-state.test.ts`
Expected: FAIL — `Failed to resolve import "../subscription-state"` (module does not exist yet).

- [ ] **Step 3: Write the module**

Create `packages/shared/src/services/subscription-state.ts`:

```ts
import type { Plan, SubscriptionStatus } from "@prisma/client";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../config/billing";

const GRACE_MS = SUBSCRIPTION_GRACE_BUFFER_DAYS * 24 * 60 * 60 * 1000;

export type SubscriptionPhase =
  | "NONE" // no plan / subscriptionStatus NONE
  | "ACTIVE" // period live, healthy
  | "DUNNING" // payment failing, still within grace/period
  | "CANCELED_GRACE" // canceled by user
  | "CANCELED" // canceled / terminated
  | "PERIOD_ENDED"; // ACTIVE/DUNNING but currentPeriodEnd + grace elapsed

export interface SubscriptionState {
  phase: SubscriptionPhase;
  live: boolean; // lifecycle access allowed; quota is checked separately
}

// True while the billing period plus the grace buffer has not elapsed. The
// interval is half-open (exactly at the boundary is NOT live) to match the
// original canSubmitJob check.
export function isPeriodLive(
  currentPeriodEnd: Date | null,
  now: Date
): boolean {
  return (
    currentPeriodEnd != null &&
    currentPeriodEnd.getTime() + GRACE_MS > now.getTime()
  );
}

// Single source of truth for the subscription lifecycle. `live` means lifecycle
// access is allowed (the minute quota is checked separately by canSubmitJob).
// Consumed by canSubmitJob (the gate), getUsageForUser (the account card), and
// the reconcile cron so no surface can disagree about whether a subscription is
// usable. Mirrors the original canSubmitJob allow/deny exactly.
export function getSubscriptionState(
  user: {
    plan: Plan;
    subscriptionStatus: SubscriptionStatus;
    currentPeriodEnd: Date | null;
  },
  now: Date
): SubscriptionState {
  if (user.plan === "NONE" || user.subscriptionStatus === "NONE") {
    return { phase: "NONE", live: false };
  }
  if (user.subscriptionStatus === "CANCELED") {
    return { phase: "CANCELED", live: false };
  }
  if (user.subscriptionStatus === "CANCELED_GRACE") {
    return { phase: "CANCELED_GRACE", live: false };
  }
  // ACTIVE or DUNNING from here.
  if (!isPeriodLive(user.currentPeriodEnd, now)) {
    return { phase: "PERIOD_ENDED", live: false };
  }
  return {
    phase: user.subscriptionStatus === "DUNNING" ? "DUNNING" : "ACTIVE",
    live: true,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/src/services/__tests__/subscription-state.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Export the module from the services barrel**

Modify `packages/shared/src/services/index.ts` — add this line next to the other `export * from "./..."` lines (e.g. right after `export * from "./usage.service";`):

```ts
export * from "./subscription-state";
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/subscription-state.ts \
        packages/shared/src/services/__tests__/subscription-state.test.ts \
        packages/shared/src/services/index.ts
git commit -m "feat(shared): add getSubscriptionState liveness predicate"
```

---

## Task 2: Route `canSubmitJob` + `getUsageForUser` through the predicate

**Files:**
- Modify: `packages/shared/src/services/usage.service.ts`
- Test: `packages/shared/src/services/__tests__/usage.service.test.ts`

- [ ] **Step 1: Write the failing test**

Add these tests inside the top-level `describe("usage.service", ...)` block in `packages/shared/src/services/__tests__/usage.service.test.ts` (e.g. after the existing `canSubmitJob blocks for NONE plan` test):

```ts
  it("getUsageForUser reports subscriptionState PERIOD_ENDED for a lapsed ACTIVE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "MAX",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(
        Date.now() - (SUBSCRIPTION_GRACE_BUFFER_DAYS + 5) * 24 * 60 * 60 * 1000
      ),
      tributeSubscriptionId: null,
      stripeSubscriptionId: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.subscriptionState).toEqual({ phase: "PERIOD_ENDED", live: false });
  });

  it("getUsageForUser reports subscriptionState ACTIVE for a live plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "MAX",
      billingCycle: "MONTHLY",
      subscriptionStatus: "ACTIVE",
      topUpMinutesRemaining: 0,
      currentPeriodStart: null,
      currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      tributeSubscriptionId: null,
      stripeSubscriptionId: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.subscriptionState).toEqual({ phase: "ACTIVE", live: true });
  });

  it("getUsageForUser reports subscriptionState NONE for NONE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
      subscriptionStatus: "NONE",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
      tributeSubscriptionId: null,
      stripeSubscriptionId: null,
    });
    (prisma.clip.count as any).mockResolvedValue(0);

    const usage = await getUsageForUser("u1");
    expect(usage.subscriptionState).toEqual({ phase: "NONE", live: false });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/src/services/__tests__/usage.service.test.ts -t subscriptionState`
Expected: FAIL — `usage.subscriptionState` is `undefined` (field not returned yet).

- [ ] **Step 3: Update imports in `usage.service.ts`**

Replace the top import block (lines 1-4):

```ts
import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../config/billing";
import type { Plan, BillingCycle } from "@prisma/client";
```

with:

```ts
import { prisma } from "../lib/prisma";
import { getPlanLimits } from "../config/plans";
import {
  getSubscriptionState,
  type SubscriptionState,
  type SubscriptionPhase,
} from "./subscription-state";
import type { Plan, BillingCycle } from "@prisma/client";
```

- [ ] **Step 4: Add `subscriptionState` to `UsageSummary`**

In the `UsageSummary` interface, add the field after `paymentProvider: PaymentProvider;`:

```ts
  paymentProvider: PaymentProvider;
  subscriptionState: SubscriptionState;
}
```

- [ ] **Step 5: Compute and return `subscriptionState` in `getUsageForUser`**

After the line `const paymentProvider = resolvePaymentProvider(user);`, add:

```ts
  const subscriptionState = getSubscriptionState(user, new Date());
```

In the `if (user.plan === "NONE")` early return object, add `subscriptionState,` after `paymentProvider,`:

```ts
      clipsTotal,
      paymentProvider,
      subscriptionState,
    };
```

In the main return object at the end of `getUsageForUser`, add `subscriptionState,` after `paymentProvider,`:

```ts
    clipsTotal,
    paymentProvider,
    subscriptionState,
  };
```

- [ ] **Step 6: Add the phase->reason map above `canSubmitJob`**

Immediately before `export async function canSubmitJob(` (just before its leading comment), add:

```ts
// Block messages by phase. ACTIVE/DUNNING entries are never read (guarded by
// state.live) but are present so the map is total over SubscriptionPhase.
const LIFECYCLE_BLOCK_REASON: Record<SubscriptionPhase, string> = {
  NONE: "No active subscription. Choose a plan to get started.",
  ACTIVE: "",
  DUNNING: "",
  CANCELED: "Your subscription is canceled. Resubscribe to create new clips.",
  CANCELED_GRACE:
    "Your subscription is canceled. Resubscribe to create new clips.",
  PERIOD_ENDED:
    "Your subscription period has ended. Renew to continue creating clips.",
};
```

- [ ] **Step 7: Replace the inline lifecycle branches in `canSubmitJob`**

Replace this block (the three inline checks, from the `if (user.plan === "NONE" ...` through the closing brace of the `currentPeriodEnd` check):

```ts
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
```

with:

```ts
  // Lifecycle gate: single source of truth shared with the account card and the
  // reconcile cron. `live` is false for NONE/CANCELED*/period-ended; the message
  // is chosen per phase so the user sees why they were blocked. This preserves
  // the exact reason strings the original inline checks returned.
  const state = getSubscriptionState(user, new Date());
  if (!state.live) {
    return { allowed: false, reason: LIFECYCLE_BLOCK_REASON[state.phase] };
  }
```

- [ ] **Step 8: Run the full usage.service test file**

Run: `npx vitest run packages/shared/src/services/__tests__/usage.service.test.ts`
Expected: PASS — the new `subscriptionState` tests pass AND every pre-existing `canSubmitJob` test still passes (behavior unchanged: NONE, CANCELED_GRACE, period-ended past grace, DUNNING within grace, quota limits).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/services/usage.service.ts \
        packages/shared/src/services/__tests__/usage.service.test.ts
git commit -m "refactor(shared): canSubmitJob + getUsageForUser use getSubscriptionState"
```

---

## Task 3: Close the reconcile gap for provider-less rows

**Files:**
- Modify: `packages/shared/src/services/subscription-reconcile.service.ts`
- Test: `packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts`

- [ ] **Step 1: Write the failing test**

Add these tests inside `describe("reconcileSubscriptions", ...)` in `packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts` (after the existing `leaves a Tribute user still within grace untouched` test):

```ts
  it("date-expires a provider-less user past grace to CANCELED", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u6",
        stripeSubscriptionId: null,
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 10 * DAY),
      },
    ]);

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u6" },
      data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
    });
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("leaves a provider-less user still within grace untouched", async () => {
    (prisma.user.findMany as any).mockResolvedValue([
      {
        id: "u7",
        stripeSubscriptionId: null,
        tributeSubscriptionId: null,
        subscriptionStatus: "ACTIVE",
        currentPeriodEnd: new Date(NOW.getTime() - 1 * DAY),
      },
    ]);

    const res = await reconcileSubscriptions(NOW);

    expect(res.reconciled).toBe(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts -t "provider-less"`
Expected: FAIL — the `date-expires a provider-less user past grace` test fails because the current code has no `else` branch (`reconciled` stays 0, `update` not called).

- [ ] **Step 3: Update imports in `subscription-reconcile.service.ts`**

Replace line 4:

```ts
import { SUBSCRIPTION_GRACE_BUFFER_DAYS } from "../config/billing";
```

with:

```ts
import { isPeriodLive } from "./subscription-state";
```

- [ ] **Step 4: Remove the now-unused `graceMs` local**

Delete this line near the top of `reconcileSubscriptions` (the `skewMs` and `cutoff` lines stay):

```ts
  const graceMs = SUBSCRIPTION_GRACE_BUFFER_DAYS * 24 * 60 * 60 * 1000;
```

- [ ] **Step 5: Rewrite the Tribute branch and add the provider-less branch**

Replace the entire `} else if (user.tributeSubscriptionId) { ... }` block (through its closing brace, just before the `}` that closes the `for` loop) with:

```ts
    } else if (user.tributeSubscriptionId) {
      if (!isPeriodLive(user.currentPeriodEnd, now)) {
        console.log(
          `[reconcile] user=${user.id} ${user.subscriptionStatus}→CANCELED reason=tribute_period_expired_grace_elapsed`
        );
        await prisma.user.update({
          where: { id: user.id },
          data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
        });
        reconciled++;
      }
    } else {
      // No provider subscription attached (manual grant / stale row). A lapsed
      // period can never self-renew, so date-expire it once grace has elapsed -
      // mirrors the Tribute branch and stops a stuck ACTIVE row from lasting
      // forever (the account-card-vs-gate contradiction this fix targets).
      if (!isPeriodLive(user.currentPeriodEnd, now)) {
        console.log(
          `[reconcile] user=${user.id} ${user.subscriptionStatus}→CANCELED reason=provider_absent_period_expired`
        );
        await prisma.user.update({
          where: { id: user.id },
          data: { subscriptionStatus: "CANCELED", graceEndsAt: null },
        });
        reconciled++;
      }
    }
```

- [ ] **Step 6: Run the full reconcile test file**

Run: `npx vitest run packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts`
Expected: PASS — the two new provider-less tests pass AND all pre-existing tests still pass (Stripe advance/dunning/skip, Tribute expire/within-grace still behave identically, since `isPeriodLive` uses the same 3-day grace).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/services/subscription-reconcile.service.ts \
        packages/shared/src/services/__tests__/subscription-reconcile.service.test.ts
git commit -m "fix(shared): reconcile date-expires provider-less lapsed subscriptions"
```

---

## Task 4: Honest Account card rendering (`accountText`)

**Files:**
- Modify: `apps/bot/src/i18n.ts`
- Test: `apps/bot/src/__tests__/i18n.test.ts`

Note: `phase` is added as an **optional** field. Existing tests omit it and keep hitting the unchanged active layout, so they stay green; production always supplies it (Task 5).

- [ ] **Step 1: Write the failing test**

Add these tests inside the `accountText` describe area of `apps/bot/src/__tests__/i18n.test.ts` (e.g. right after the `renders accountText NONE variant in both locales` test):

```ts
  it("renders accountText PERIOD_ENDED as ended, not active, in both locales", () => {
    const base = {
      plan: "MAX",
      billingCycle: "monthly",
      periodEnd: "2026-06-20",
      daysUntilPeriodEnd: 0,
      phase: "PERIOD_ENDED" as const,
      minutesUsed: 69,
      minutesLimit: 3500,
      topUpMinutes: 0,
      clipsStored: 13,
      storageClipsLimit: 1000,
      retentionDays: 90,
      clipsTotal: 13,
    };

    const en = t("en").accountText(base);
    expect(en).toContain("ended 2026-06-20");
    expect(en).toContain("Renew to keep clipping.");
    expect(en).not.toContain("(today)");
    expect(en).not.toContain("Renews:");

    const ru = t("ru").accountText(base);
    expect(ru).toContain("истёк 2026-06-20");
    expect(ru).toContain("Продлите");
    expect(ru).not.toContain("(сегодня)");
    expect(ru).not.toContain("Продление:");
  });

  it("renders accountText CANCELED as canceled in both locales", () => {
    const base = {
      plan: "MAX",
      billingCycle: "monthly",
      periodEnd: "2026-06-20",
      daysUntilPeriodEnd: 0,
      phase: "CANCELED" as const,
      minutesUsed: 0,
      minutesLimit: 3500,
      topUpMinutes: 0,
      clipsStored: 13,
      storageClipsLimit: 1000,
      retentionDays: 90,
      clipsTotal: 13,
    };

    expect(t("en").accountText(base)).toContain("canceled");
    expect(t("ru").accountText(base)).toContain("отменён");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/bot/src/__tests__/i18n.test.ts -t "PERIOD_ENDED"`
Expected: FAIL — current output shows `Renews: 2026-06-20 (today)` and lacks "ended"/"истёк" (and TypeScript will not yet accept the `phase` property).

- [ ] **Step 3: Import the phase type at the top of `i18n.ts`**

Add as the new first line of `apps/bot/src/i18n.ts` (above `export type Locale = "en" | "ru";`):

```ts
import type { SubscriptionPhase } from "@clipclap/shared";
```

- [ ] **Step 4: Add `phase` to the `Dict.accountText` param type**

In the `accountText` param object type inside `interface Dict`, add `phase?: SubscriptionPhase;` after `daysUntilPeriodEnd: number | null;`:

```ts
    periodEnd: string | null;
    daysUntilPeriodEnd: number | null;
    phase?: SubscriptionPhase;
    minutesUsed: number;
```

- [ ] **Step 5: Rewrite the EN `accountText` implementation**

Replace the entire EN `accountText: ({ ... }) => { ... },` (the one inside `const en: Dict = {`, starting at `accountText: ({` and ending at the closing `},`) with:

```ts
  accountText: ({
    plan,
    billingCycle,
    periodEnd,
    daysUntilPeriodEnd,
    phase,
    minutesUsed,
    minutesLimit,
    topUpMinutes,
    clipsStored,
    storageClipsLimit,
    retentionDays,
    clipsTotal,
  }) => {
    if (plan === "NONE" || phase === "NONE") {
      return `Plan: no active plan\n\nPick a plan to start clipping.\nTotal clips created: ${clipsTotal}`;
    }
    const planLabel = `${plan}${billingCycle ? ` (${billingCycle})` : ""}`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `Plan: ${planLabel} - ended${periodEnd ? ` ${periodEnd}` : ""}`;
      renewLine = "Renew to keep clipping.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `Plan: ${planLabel} - canceled`;
      renewLine = "Resubscribe to keep clipping.";
    } else {
      planLine = `Plan: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (today)"
            : ` (in ${daysUntilPeriodEnd} day${daysUntilPeriodEnd === 1 ? "" : "s"})`;
      renewLine = periodEnd ? `Renews: ${periodEnd}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${renewLine ? `${renewLine}\n` : ""}Payment issue - please update your payment method.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Minutes: ${minutesUsed} / ${minutesLimit} this period (${minutesLeft} left)`;
    const topUpLine = topUpMinutes > 0 ? `+ Top-up: ${topUpMinutes} minutes\n` : "";
    const storageLine = `Storage: ${clipsStored} / ${storageClipsLimit} clips (kept for ${retentionDays} days)`;
    const totalLine = `Total clips created: ${clipsTotal}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(/\n\n\n+/g, "\n\n");
  },
```

- [ ] **Step 6: Rewrite the RU `accountText` implementation**

Replace the entire RU `accountText: ({ ... }) => { ... },` (the one inside `const ru: Dict = {`) with:

```ts
  accountText: ({
    plan,
    billingCycle,
    periodEnd,
    daysUntilPeriodEnd,
    phase,
    minutesUsed,
    minutesLimit,
    topUpMinutes,
    clipsStored,
    storageClipsLimit,
    retentionDays,
    clipsTotal,
  }) => {
    if (plan === "NONE" || phase === "NONE") {
      return `Тариф: нет активного\n\nВыбери тариф, чтобы начать.\nВсего создано: ${clipsTotal} ${pluralizeRu(clipsTotal, "клип", "клипа", "клипов")}`;
    }
    const cycleLabel =
      billingCycle === null
        ? ""
        : billingCycle === "weekly" || billingCycle === "WEEKLY"
          ? " (недельный)"
          : " (месячный)";
    const planLabel = `${plan}${cycleLabel}`;
    let planLine: string;
    let renewLine: string;
    if (phase === "PERIOD_ENDED") {
      planLine = `Тариф: ${planLabel} - истёк${periodEnd ? ` ${periodEnd}` : ""}`;
      renewLine = "Продлите, чтобы продолжить нарезку.";
    } else if (phase === "CANCELED" || phase === "CANCELED_GRACE") {
      planLine = `Тариф: ${planLabel} - отменён`;
      renewLine = "Оформите заново, чтобы продолжить.";
    } else {
      planLine = `Тариф: ${planLabel}`;
      const renewSuffix =
        daysUntilPeriodEnd === null
          ? ""
          : daysUntilPeriodEnd === 0
            ? " (сегодня)"
            : ` (через ${daysUntilPeriodEnd} ${pluralizeRu(daysUntilPeriodEnd, "день", "дня", "дней")})`;
      renewLine = periodEnd ? `Продление: ${periodEnd}${renewSuffix}` : "";
      if (phase === "DUNNING") {
        renewLine = `${renewLine ? `${renewLine}\n` : ""}Проблема с оплатой - обновите способ оплаты.`;
      }
    }
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Минуты: ${minutesUsed} / ${minutesLimit} в этом периоде (осталось ${minutesLeft})`;
    const topUpLine =
      topUpMinutes > 0 ? `+ Дополнительно: ${topUpMinutes} минут\n` : "";
    const storageLine = `Хранилище: ${clipsStored} / ${storageClipsLimit} ${pluralizeRu(clipsStored, "клип", "клипа", "клипов")} (хранятся ${retentionDays} ${pluralizeRu(retentionDays, "день", "дня", "дней")})`;
    const totalLine = `Всего создано: ${clipsTotal} ${pluralizeRu(clipsTotal, "клип", "клипа", "клипов")}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(/\n\n\n+/g, "\n\n");
  },
```

- [ ] **Step 7: Run the bot i18n test file**

Run: `npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: PASS — the two new phase tests pass AND all pre-existing `accountText` tests (NONE variant + active-plan-with-top-up EN/RU + plural cases) still pass (active output is byte-identical when `phase` is omitted).

- [ ] **Step 8: Typecheck the bot**

Run: `npm run typecheck -w @clipclap/bot`
Expected: PASS (no type errors; `phase?: SubscriptionPhase` resolves via the `@clipclap/shared` alias).

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/i18n.ts apps/bot/src/__tests__/i18n.test.ts
git commit -m "fix(bot): account card shows expired/canceled state, not stale active"
```

---

## Task 5: Wire `sendAccountView` to pass `phase`

**Files:**
- Modify: `apps/bot/src/handlers.ts`

There is exactly one production caller of `accountText`. Both of its call sites must pass `phase`.

- [ ] **Step 1: Pass `phase: "NONE"` in the `!existing` branch**

In `sendAccountView`, in the `if (!existing) { ... }` block, add `phase: "NONE",` right after `plan: "NONE",`:

```ts
    const text = dict.accountText({
      plan: "NONE",
      phase: "NONE",
      billingCycle: null,
      periodEnd: null,
      daysUntilPeriodEnd: null,
      minutesUsed: 0,
      topUpMinutes: 0,
      clipsStored: 0,
      storageClipsLimit: 0,
      retentionDays: 0,
      clipsTotal: 0,
    });
```

- [ ] **Step 2: Pass the real phase in the main branch**

In the main `dict.accountText({ ... })` call (the one using `usage.*`), add `phase: usage.subscriptionState.phase,` right after `daysUntilPeriodEnd,`:

```ts
  const text = dict.accountText({
    plan: usage.plan,
    billingCycle,
    periodEnd,
    daysUntilPeriodEnd,
    phase: usage.subscriptionState.phase,
    minutesUsed: usage.minutesUsed,
    minutesLimit: usage.minutesLimit,
    topUpMinutes: usage.topUpMinutesRemaining,
    clipsStored: usage.clipsStored,
    storageClipsLimit: usage.storageClipsLimit,
    retentionDays: usage.retentionDays,
    clipsTotal: usage.clipsTotal,
  });
```

Note: no change to the CTA button logic below this call. For a `PERIOD_ENDED` MAX user, `usage.plan` is still `MAX` (not `NONE`), so control flows to the existing "Manage subscription" button, which already links to `/dashboard/plans` (or `t.me/tribute`) — the correct renew destination. The renew call-to-action itself is the new body line from Task 4.

- [ ] **Step 3: Typecheck the bot**

Run: `npm run typecheck -w @clipclap/bot`
Expected: PASS — `usage.subscriptionState.phase` is a `SubscriptionPhase`, accepted by `accountText`.

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/handlers.ts
git commit -m "fix(bot): sendAccountView passes subscription phase to the card"
```

---

## Task 6: Full verification + rebuild shared

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npx vitest run`
Expected: PASS — all shared + bot + web tests green, including the new subscription-state, usage.service, reconcile, and i18n tests.

- [ ] **Step 2: Typecheck the bot once more**

Run: `npm run typecheck -w @clipclap/bot`
Expected: PASS.

- [ ] **Step 3: Rebuild the shared package**

The worker and reconcile cron run the compiled `dist` of `@clipclap/shared`, so the new predicate + reconcile branch only take effect after a rebuild.

Run: `npm run build -w @clipclap/shared`
Expected: build succeeds, `packages/shared/dist` updated.

- [ ] **Step 4: Restart the services that run the changed code**

Run: `docker compose restart bot worker-transcribe worker-download worker-render worker-finalize worker-analyze`
Expected: containers restart cleanly. (Web runs `src` directly and is unaffected, but restarting `bot` picks up the account-card change and the workers/cron pick up the rebuilt reconcile logic.)

- [ ] **Step 5: Commit any build artifacts if the repo tracks `dist`**

```bash
git status --porcelain packages/shared/dist
# If dist is tracked and changed:
git add packages/shared/dist && git commit -m "chore(shared): rebuild dist"
# If dist is gitignored, skip this step.
```

---

## Task 7 (operational, owner decision): the stale test row

**Not an automated code step.** The reported account (`telegramId 575308044`, the owner's test account) currently sits at `subscriptionStatus=ACTIVE` with a lapsed period and no provider. Per the spec, the owner chooses:

- **Let reconcile fix it (spec default):** after Task 6 the hourly reconcile cron flips it `ACTIVE -> CANCELED` on its next run. This doubles as end-to-end verification of Task 3. Confirm afterwards:

  ```bash
  docker exec clipclapio-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -x -c "SELECT plan, \"subscriptionStatus\", \"currentPeriodEnd\" FROM users WHERE \"telegramId\" = '"'"'575308044'"'"';"'
  ```
  Expected after the cron runs: `subscriptionStatus = CANCELED`.

- **Extend it for continued testing (alternative):** to keep exercising the active-subscriber path, bump the period to the future instead. Run only with the owner's explicit go-ahead:

  ```bash
  docker exec clipclapio-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "UPDATE users SET \"currentPeriodEnd\" = NOW() + INTERVAL '"'"'30 days'"'"', \"currentPeriodStart\" = NOW() WHERE \"telegramId\" = '"'"'575308044'"'"';"'
  ```

Do not delete the account either way.

---

## Manual verification (recommended before merge)

With the `bot` container restarted, in Telegram:

1. As the stale test account (before reconcile expires it, or on any provider-less lapsed row): send a video -> gate replies "period has ended"; open **Аккаунт** -> card now shows `Тариф: MAX (месячный) - истёк 2026-06-20` (no `(сегодня)`), matching the gate. The contradiction is gone.
2. As a live subscriber: **Аккаунт** still shows `Продление: <date> (через N дней)` exactly as before.
