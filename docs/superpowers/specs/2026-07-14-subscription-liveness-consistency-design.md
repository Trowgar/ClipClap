# Subscription liveness consistency

Date: 2026-07-14
Status: Approved (design)
Scope: `packages/shared` + `apps/bot` (web dashboard out of scope)

## Problem

A Telegram user sends a video and the bot replies "Your subscription period has
ended. Renew to continue creating clips." The user then opens the Account card
(`Аккаунт`), which shows the plan as active: `Тариф: MAX (месячный) / Продление:
2026-06-20 (сегодня)`. The two surfaces contradict each other.

### Root cause

The two surfaces answer different questions and only one of them is honest:

- The **video gate** (`canSubmitJob`, `packages/shared/src/services/usage.service.ts`)
  enforces the subscription lifecycle. It blocks when
  `currentPeriodEnd + grace <= now`. This is correct.
- The **Account card** (`getUsageForUser` + `accountText` in
  `apps/bot/src/i18n.ts` / `apps/bot/src/handlers.ts`) just prints `plan` and
  `currentPeriodEnd` straight from the DB with **no liveness check at all**.

Confirmed DB state for the reported account (`telegramId 575308044`):

| field | value |
|---|---|
| `plan` | MAX |
| `subscriptionStatus` | ACTIVE |
| `currentPeriodEnd` | 2026-06-20 (24 days in the past) |
| `currentPeriodStart` | NULL |
| Stripe subscription | none |
| Tribute subscription | none |

The period genuinely ended on 2026-06-20, so the gate is right and the card is
lying. Three distinct defects sit under the one symptom:

1. **Display trusts raw fields.** The card renders `plan`/`period` with no
   lifecycle check, so an expired plan looks active.
2. **"(сегодня)" mislabel.** `daysUntilPeriodEnd = Math.max(0, ceil((periodEnd -
   now) / day))` clamps a past date to `0`, which `accountText` renders as
   `(сегодня)` / `(today)`. A period that ended 24 days ago displays as "renews
   today."
3. **Reconcile gap (why the data got stuck).**
   `reconcileSubscriptions` (`packages/shared/src/services/subscription-reconcile.service.ts`)
   has an `if (stripeSubscriptionId) ... else if (tributeSubscriptionId) ...`
   chain with **no final branch**, so a provider-less `ACTIVE` row whose period
   has lapsed is never date-expired. It stays `ACTIVE` forever.

Additionally, the "is the period still live" rule is duplicated inline in
`canSubmitJob` and (differently) in the Tribute branch of `reconcile`, with no
single source of truth.

### Product context

The reported account is the owner's own test account, not a real customer and
not a legitimate ongoing pattern. Provider-less `ACTIVE` subscriptions are not
intended to outlive their period, so `reconcile` may safely date-expire them
after grace with no "comp marker" special case.

## Goal

The Account card and the video gate must never contradict each other, and the
underlying stale-`ACTIVE` data must self-heal. Achieve this with one source of
truth for subscription liveness rather than a third inline copy of the rule.

Non-goals: changing any billing allow/deny behavior, altering the web dashboard,
introducing a comp/grant marker.

## Design

### 1. Single source of truth: `getSubscriptionState`

New pure module (no DB access, trivially unit-testable):
`packages/shared/src/services/subscription-state.ts`

```ts
export type SubscriptionPhase =
  | "NONE"           // no plan / subscriptionStatus NONE
  | "ACTIVE"         // period live, healthy
  | "DUNNING"        // payment failing, still within grace/period
  | "CANCELED_GRACE" // canceled by user
  | "CANCELED"       // canceled / terminated
  | "PERIOD_ENDED";  // ACTIVE/DUNNING but currentPeriodEnd + grace elapsed

export interface SubscriptionState {
  phase: SubscriptionPhase;
  live: boolean; // lifecycle access allowed; quota is checked separately
}

export function getSubscriptionState(
  user: { plan: Plan; subscriptionStatus: SubscriptionStatus; currentPeriodEnd: Date | null },
  now: Date,
): SubscriptionState;

export function isPeriodLive(currentPeriodEnd: Date | null, now: Date): boolean;
```

`getSubscriptionState` reproduces the current `canSubmitJob` lifecycle allow/deny
exactly, so there is no billing regression:

- `plan === "NONE" || subscriptionStatus === "NONE"` -> `{ phase: "NONE", live: false }`
- `subscriptionStatus === "CANCELED"` -> `{ phase: "CANCELED", live: false }`
- `subscriptionStatus === "CANCELED_GRACE"` -> `{ phase: "CANCELED_GRACE", live: false }`
- otherwise (`ACTIVE` / `DUNNING`):
  - `!isPeriodLive(currentPeriodEnd, now)` -> `{ phase: "PERIOD_ENDED", live: false }`
  - else -> `{ phase: subscriptionStatus === "DUNNING" ? "DUNNING" : "ACTIVE", live: true }`

`live === true` only for `ACTIVE` / `DUNNING` with a live period, matching today's
gate. `isPeriodLive` holds the grace math (`currentPeriodEnd != null &&
currentPeriodEnd.getTime() + GRACE_MS > now.getTime()`, where `GRACE_MS` derives
from `SUBSCRIPTION_GRACE_BUFFER_DAYS`) so the same arithmetic is never written a
third time.

Note on `CANCELED_GRACE`: today's `canSubmitJob` denies it, so `live` is `false`
to preserve behavior. Its distinct phase lets the card word it as "canceled"
rather than "period ended." Changing whether a canceled-but-paid-through user
keeps access is explicitly out of scope.

### 2. Consumers switch to the predicate

- **`canSubmitJob`** - replace the three inline lifecycle branches with a single
  `getSubscriptionState(user, new Date())` call plus a `phase -> reason` map that
  returns the exact same strings as today:
  - `NONE` -> "No active subscription. Choose a plan to get started."
  - `CANCELED` / `CANCELED_GRACE` -> "Your subscription is canceled. Resubscribe to create new clips."
  - `PERIOD_ENDED` -> "Your subscription period has ended. Renew to continue creating clips."
  The quota check runs unchanged after `live === true`.
- **`getUsageForUser`** - add `subscriptionState: SubscriptionState` to
  `UsageSummary` (both the `NONE` early-return and the main return). Additive and
  backward compatible, so the web consumer (`userService.getUsage`) is untouched.
- **`reconcileSubscriptions`** - reuse `isPeriodLive`; add the missing branch
  (section 4).

### 3. Account card: honest display

`accountText` gains a `phase: SubscriptionPhase` parameter. `sendAccountView`
passes `usage.subscriptionState.phase`.

| phase | Card |
|---|---|
| `ACTIVE` | unchanged: `Продление: ДАТА (через N дней)` / `(сегодня)` for a genuine same-day renewal |
| `DUNNING` | as active, plus a payment-problem note |
| `PERIOD_ENDED` | header `Тариф: MAX - истёк ДАТА` + renew prompt; storage/clips stats kept; "Продлить" button |
| `CANCELED` / `CANCELED_GRACE` | header `Тариф: MAX - отменён` + resubscribe prompt |

The `Продление` (renews) line is rendered **only** for live phases. That removes
the `(сегодня)` mislabel at the source: an expired period no longer flows into
the renews line, so the clamped-to-zero `daysUntilPeriodEnd` can no longer be
shown as "renews today." Both locales (RU/EN) get parallel wording per the
bilingual i18n policy; plain hyphens only.

Before: `Тариф: MAX (месячный) / Продление: 2026-06-20 (сегодня)`
After: `Тариф: MAX - истёк 2026-06-20 / Продлите, чтобы продолжить нарезку`

### 4. Close the reconcile gap

Add the final `else` branch (neither Stripe nor Tribute id) to the loop in
`reconcileSubscriptions`. When `!isPeriodLive(user.currentPeriodEnd, now)` (period
plus grace elapsed): update `subscriptionStatus: "CANCELED"`, `graceEndsAt: null`,
and log `reason=provider_absent_period_expired`. `plan` is left intact, mirroring
the Tribute expiry branch. This branch calls only `isPeriodLive(currentPeriodEnd,
now)`, and `currentPeriodEnd` is already in the reconcile `select`, so no new
selected fields are needed. This self-heals stuck `ACTIVE` rows on the next hourly
run.

### 5. The stale test row (`telegramId 575308044`)

Data, not code. Owner decides:

- **Let it expire** (default): after deploy, the fixed reconcile flips it
  `ACTIVE -> CANCELED` on the next run, which doubles as live verification of the
  fix. OR
- **Extend for testing**: manually set `currentPeriodEnd` to a future date to keep
  exercising the active-subscriber path.

Spec default is "let reconcile fix it"; the choice stays with the owner. Do not
delete the account.

## Testing

- Unit `getSubscriptionState`: every phase, the grace boundary (just inside / just
  outside), and the exact bug case (`ACTIVE` + past period -> `PERIOD_ENDED`,
  `live: false`).
- `canSubmitJob`: existing tests stay green (behavior identical); add coverage for
  each `phase -> reason` mapping if missing.
- `accountText` (both locales): `PERIOD_ENDED` -> "истёк" / "ended" and no
  "(сегодня)"; `CANCELED` -> "отменён" / "canceled"; `ACTIVE` unchanged.
- `reconcile`: provider-less past grace -> `CANCELED`; provider-less within grace
  -> untouched; Stripe and Tribute paths unchanged.

## Affected files

- `packages/shared/src/services/subscription-state.ts` (new)
- `packages/shared/src/services/usage.service.ts`
- `packages/shared/src/services/subscription-reconcile.service.ts`
- `apps/bot/src/i18n.ts`
- `apps/bot/src/handlers.ts`
- tests alongside the above

Web dashboard is intentionally untouched: `billingService.getSubscription`
already pulls live Stripe status for Stripe customers. The provider-less / Tribute
display quirk on web is noted but out of scope.
