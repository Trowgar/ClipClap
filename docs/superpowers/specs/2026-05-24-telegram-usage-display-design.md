# Telegram Bot - Usage Limits Display

**Date:** 2026-05-24
**Status:** Approved, ready for implementation plan
**Scope:** Extend the `/account` view of the ClipClap Telegram bot to display the user's remaining usage limits.

## Goal

A user tapping 📊 Account in the bot should immediately see, at a glance, **how much of their plan they've consumed and how much is left** - without having to open the web dashboard.

The two limits users care about are:

1. **Minutes per period** - the main paid quota (`minutesUsed / minutesPerPeriod` + any top-up balance).
2. **Storage clips** - how many of their clip slots are currently occupied (`clipsStored / storageClipsLimit`) and how long clips are kept (`retentionDays`).

The two internal anti-abuse caps (`maxJobsPerDay`, `concurrentJobsLimit`) are NOT shown - they're operational, not user-facing decision drivers.

## Non-goals

- New menu entry point - usage display lives inside the existing 📊 Account button. No additional buttons or commands.
- Visual progress bars / ASCII graphics - plain text only (matches the rest of the bot's tone, renders identically across Telegram clients).
- Web-dashboard changes - out of scope. (The web has its own usage display; bot uses the same underlying service.)
- Pro-active limit warnings before user attempts an action - out of scope. Submission blockers already explain *which* limit was hit; this spec only covers the on-demand `/account` view.

## Design

### Output shape

**User has an active plan** (e.g., Starter monthly, 45 / 270 minutes used, 100 top-up minutes, 8 / 20 clips stored, 42 total ever):

EN:
```
📊 Account

Plan: Starter (monthly)
Renews: 2026-06-24 (in 31 days)

Minutes: 45 / 270 this period (225 left)
+ Top-up: 100 minutes

Storage: 8 / 20 clips (kept for 7 days)
Total clips created: 42
```

RU:
```
📊 Аккаунт

Тариф: Starter (месячный)
Продление: 2026-06-24 (через 31 день)

Минуты: 45 / 270 в этом периоде (осталось 225)
+ Дополнительно: 100 минут

Хранилище: 8 / 20 клипов (хранятся 7 дней)
Всего создано: 42 клипа
```

**User has no top-up:** the `+ Top-up: ...` line is omitted.

**User on NONE plan:**

EN:
```
📊 Account

Plan: no active plan

Pick a plan to start clipping.
Total clips created: 0
```

RU:
```
📊 Аккаунт

Тариф: нет активного

Выбери тариф, чтобы начать.
Всего создано: 0 клипов
```

### Data layer

Extend `UsageSummary` in `packages/shared/src/services/usage.service.ts` with three new fields, and add a single `prisma.clip.count` for in-storage clips:

```ts
export interface UsageSummary {
  // existing
  plan: Plan;
  billingCycle: BillingCycle | null;
  minutesUsed: number;
  minutesLimit: number;
  topUpMinutesRemaining: number;
  storageClipsLimit: number;
  // new
  clipsStored: number;       // prisma.clip.count where deletedAt = null
  retentionDays: number;     // from PLAN_LIMITS (0 on NONE)
  currentPeriodEnd: Date | null;  // from User (already loaded)
  clipsTotal: number;        // prisma.clip.count (no filter) - historical
}
```

Implementation notes:
- `clipsStored` = `prisma.clip.count({ where: { userId, deletedAt: null } })`. Includes clips whose `expiresAt` is in the past but cleanup hasn't run yet - that's intentional, it reflects what's actually still occupying storage.
- `clipsTotal` is hoisted out of `apps/bot/src/handlers.ts` (which currently does its own `prisma.clip.count`) into the service. Single source of truth.
- `retentionDays` comes from `getPlanLimits(plan, cycle).retentionDays`. For NONE plan, returns 0 - the handler's NONE branch ignores it.
- Two queries (count active, count total) can run in parallel via `Promise.all`. Service-level optimization, not user-visible.

### i18n

The existing `accountText` template in `apps/bot/src/i18n.ts` accepts `{ plan, billingCycle, periodEnd, clipsTotal }`. **Replace** the signature with:

```ts
accountText: (params: {
  plan: string;
  billingCycle: string | null;
  periodEnd: string | null;
  daysUntilPeriodEnd: number | null;
  minutesUsed: number;
  minutesLimit: number;
  topUpMinutes: number;
  clipsStored: number;
  storageClipsLimit: number;
  retentionDays: number;
  clipsTotal: number;
}) => string;
```

For `plan === "NONE"` the template returns the NONE-variant text (above). Otherwise it composes the full report.

Russian noun pluralization uses the existing `pluralizeRu` helper:
- `клип / клипа / клипов` - clips
- `день / дня / дней` - days
- `минута / минуты / минут` - minutes is unnecessary; we just use the bare "минут" in all cases (Russian convention with numerals before unit nouns is `45 минут`, `1 минут` would actually be `1 минута`, but we follow common UI shorthand where "минут" is used as a label, not in agreement with the number).

To keep simple consistency with the rest of the UI ("Total clips created: 42 клипа"), we'll use `pluralizeRu` for `клип` everywhere it appears.

### Handler

In `apps/bot/src/handlers.ts`, the existing `renderAccountText(dict, userId)` function:

1. If `userId` is undefined (user not yet in DB - shouldn't happen for an existing menu tap, but defensively): return NONE-variant directly with all zeros.
2. Call `getUsageForUser(userId)` from `@clipfast/shared`.
3. Compute `daysUntilPeriodEnd` from `usage.currentPeriodEnd`: `Math.max(0, ceil((periodEnd - now) / day))`, or `null` if no period end.
4. Format `periodEnd` to `YYYY-MM-DD` string (or `null`).
5. Format `billingCycle` to lowercase string (`"monthly"` / `"weekly"`) or `null`.
6. Pass everything into `dict.accountText(...)`.

The function no longer does `prisma.clip.count` directly - that lives in the service now.

### Error handling

- `getUsageForUser` throws if user is missing (`findUniqueOrThrow`). The handler doesn't try to swallow - let it propagate to the top-level update handler, which already logs and silently fails (existing behavior).
- If `currentPeriodEnd` is in the past (e.g., dunning state), `daysUntilPeriodEnd` is 0, and the text reads "Renews: 2026-04-24 (today)". The user is in `DUNNING` anyway, so submissions will already be blocked elsewhere.

### Testing

Unit tests in `apps/bot/src/__tests__/i18n.test.ts` (extend existing file):

- `accountText` for NONE plan renders the "no active plan" variant (EN + RU)
- `accountText` for active plan with top-up renders all four blocks (plan/period, minutes, storage, total)
- `accountText` for active plan with `topUpMinutes === 0` omits the top-up line
- `accountText` Russian uses correct pluralization for `клип` at n=1, 2, 5, 21
- `accountText` Russian uses correct pluralization for `день` at n=1, 2, 5, 21

Service-level tests in `packages/shared/src/services/__tests__/usage.service.test.ts` (existing file - extend):

- `getUsageForUser` includes `clipsStored`, `retentionDays`, `currentPeriodEnd`, `clipsTotal` in the returned object
- `clipsStored` counts only clips with `deletedAt = null`
- `clipsTotal` counts all clips regardless of `deletedAt`
- NONE plan returns `retentionDays: 0` and `currentPeriodEnd: null`

No new integration tests - the handler integration is covered by the existing `/account` flow (still callable end-to-end after the change).

## File changes

| File | Status | Change |
|---|---|---|
| `packages/shared/src/services/usage.service.ts` | modify | Extend `UsageSummary` with 4 new fields; add `clipsStored`, `clipsTotal` counts; load `retentionDays` and `currentPeriodEnd` |
| `packages/shared/src/services/__tests__/usage.service.test.ts` | modify | New cases for the four new fields and NONE-plan defaults |
| `apps/bot/src/i18n.ts` | modify | Update `accountText` signature in `Dict` interface; rewrite EN+RU templates to render the four blocks; handle NONE variant |
| `apps/bot/src/handlers.ts` | modify | `renderAccountText` calls `getUsageForUser`, computes `daysUntilPeriodEnd`, passes everything to dict |
| `apps/bot/src/__tests__/i18n.test.ts` | modify | New cases for `accountText` (NONE, active, top-up presence, Russian plurals) |

## Out of scope (deferred)

- Showing remaining jobs/day or concurrent slots - anti-abuse caps, not relevant to user mental model.
- Inline button to "Manage plan" / "Buy top-up" beneath the account text - could be a follow-up.
- Proactive notifications when approaching limits (e.g., 80% minutes used) - separate feature.
- Web-dashboard parity - out of scope here.
