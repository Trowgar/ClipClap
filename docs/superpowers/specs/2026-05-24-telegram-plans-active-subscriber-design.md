# Telegram Bot - 💎 Plans for Active Subscribers

**Date:** 2026-05-24
**Status:** Approved, ready for implementation
**Scope:** Fix the bug where tapping 💎 Plans always shows the "pick a plan" prompt, even to users who already have an active subscription. Active subscribers should see a summary of their current plan + an inline link to manage on the web.

## Goal

A user tapping 💎 Plans (or 💎 Тарифы) should see something appropriate to their state:

- **NONE plan** - show the existing "pick a plan to start clipping" prompt with Tribute tariff buttons. (Unchanged.)
- **Active plan** - show a short summary (plan name, cycle, renewal date) plus a single inline button to the web dashboard for management. No tariff buttons (would risk Tribute creating a duplicate subscription).

## Non-goals

- In-bot plan upgrade flow. Tribute URLs create new subscriptions; tapping a higher-tier button while already subscribed would double-charge. Upgrades and downgrades go through the web dashboard.
- In-bot cancel / manage flow. All subscription mutation lives on Tribute (via the web dashboard).
- DUNNING / CANCELED_GRACE / CANCELED state differentiation. These are valid states with `plan !== "NONE"` - treat them the same as ACTIVE for this view. Users hitting an actual processing blocker get the explanation through `canSubmitJob` (already implemented).
- Top-up minute packs in this view. Separate flow.
- Web-dashboard parity. Out of scope here.

## Design

### Branch logic

In `handleMenuAction(case "plans")`:

```
if (existing is null OR usage.plan === "NONE"):
  send welcomeNeedsPlan text + plansKeyboard (current behavior - unchanged)
else:
  fetch usage via getUsageForUser
  compute periodEnd ISO date, daysUntilPeriodEnd
  send currentPlanText(...) with single inline button → ${appUrl}/dashboard/plans
```

### Output shape

**Active subscriber, EN:**
```
Current plan: Max (monthly)
Renews: 2026-06-24 (in 31 days)

[ 🔧 Manage on clipclap.io ]
```

**Active subscriber, RU:**
```
Текущий тариф: Starter (месячный)
Продление: 2026-06-24 (через 31 день)

[ 🔧 Управление на clipclap.io ]
```

**Active subscriber with no `currentPeriodEnd`** (legacy / edge case):
```
Current plan: Plus (monthly)

[ 🔧 Manage on clipclap.io ]
```

**Active subscriber with `daysUntilPeriodEnd === 0`:**
- EN: `Renews: 2026-06-24 (today)`
- RU: `Продление: 2026-06-24 (сегодня)`

### i18n additions

Extend `Dict` in `apps/bot/src/i18n.ts` with:

```ts
currentPlanText: (params: {
  plan: string;
  billingCycle: string | null;
  periodEnd: string | null;
  daysUntilPeriodEnd: number | null;
}) => string;
manageOnWebBtn: string;
```

EN values:
- `manageOnWebBtn: "🔧 Manage on clipclap.io"`
- `currentPlanText`:
  ```
  Current plan: {PLAN}{ " (cycle)" if billingCycle }
  {Renews: ISO (in N day(s)) | (today)}  if periodEnd
  ```

RU values:
- `manageOnWebBtn: "🔧 Управление на clipclap.io"`
- `currentPlanText`:
  ```
  Текущий тариф: {PLAN}{ " (недельный/месячный)" if billingCycle }
  {Продление: ISO (через N день/дня/дней) | (сегодня)}  if periodEnd
  ```

Both use the `pluralizeRu` helper for "день / дня / дней".

### Handler change

In `apps/bot/src/handlers.ts`, replace the `case "plans":` block with:

```ts
case "plans": {
  if (!existing) {
    // No DB record yet - show pick-a-plan prompt
    const keyboard = plansKeyboard(dict, config);
    await client.sendMessage(
      message.chat.id,
      dict.welcomeNeedsPlan(config.appUrl),
      keyboard ? { replyMarkup: keyboard } : undefined
    );
    return;
  }

  const usage = await getUsageForUser(existing.id);

  if (usage.plan === "NONE") {
    const keyboard = plansKeyboard(dict, config);
    await client.sendMessage(
      message.chat.id,
      dict.welcomeNeedsPlan(config.appUrl),
      keyboard ? { replyMarkup: keyboard } : undefined
    );
    return;
  }

  const periodEnd = usage.currentPeriodEnd
    ? usage.currentPeriodEnd.toISOString().slice(0, 10)
    : null;
  const daysUntilPeriodEnd = usage.currentPeriodEnd
    ? Math.max(0, Math.ceil((usage.currentPeriodEnd.getTime() - Date.now()) / 86_400_000))
    : null;
  const billingCycle = usage.billingCycle ? usage.billingCycle.toLowerCase() : null;

  const text = dict.currentPlanText({
    plan: usage.plan,
    billingCycle,
    periodEnd,
    daysUntilPeriodEnd,
  });

  await client.sendMessage(message.chat.id, text, {
    replyMarkup: {
      inline_keyboard: [[
        { text: dict.manageOnWebBtn, url: `${config.appUrl}/dashboard/plans` },
      ]],
    },
  });
  return;
}
```

### Testing

In `apps/bot/src/__tests__/i18n.test.ts`, add:

- `currentPlanText` for EN Max monthly with 31-day renewal: contains `"Current plan: Max (monthly)"` and `"Renews: 2026-06-24 (in 31 days)"`.
- `currentPlanText` for RU Starter weekly with 7-day renewal: contains `"Текущий тариф: Starter (недельный)"` and `"Продление: 2026-06-24 (через 7 дней)"`.
- `currentPlanText` for `daysUntilPeriodEnd === 0`: contains `"(today)"` / `"(сегодня)"`.
- `currentPlanText` for `periodEnd === null`: contains plan line, does NOT contain "Renews" / "Продление".
- `currentPlanText` RU plural at n=1: `"через 1 день"`.
- `currentPlanText` RU plural at n=3: `"через 3 дня"`.
- `manageOnWebBtn` matches expected literal in both locales.

No service-level test changes needed - `getUsageForUser` is already covered.

## File changes

| File | Status | Change |
|---|---|---|
| `apps/bot/src/i18n.ts` | modify | Add `currentPlanText` + `manageOnWebBtn` to `Dict`; add EN+RU implementations using `pluralizeRu` |
| `apps/bot/src/__tests__/i18n.test.ts` | modify | Tests for `currentPlanText` rendering (both locales, plurals, edge cases) and `manageOnWebBtn` |
| `apps/bot/src/handlers.ts` | modify | Replace `case "plans":` body with the branched logic above |

## Out of scope (deferred)

- In-bot upgrade buttons with warnings about Tribute duplication
- DUNNING-specific copy with re-payment URL
- CANCELED_GRACE-specific copy with re-subscribe URL
- Top-up purchase from this view
