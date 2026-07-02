# Telegram Bot - Plans View for Active Subscribers - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop showing the "pick a plan" prompt to users who already have an active subscription. Show a short summary of their current plan + a single inline "Manage on web" button instead.

**Architecture:** Add a `currentPlanText` template + `manageOnWebBtn` label to the bot's `Dict`. Branch on plan in `handleMenuAction(case "plans")` - NONE keeps the existing flow, active uses the new path that calls `getUsageForUser` and sends the new text with an inline URL button.

**Tech Stack:** TypeScript, Vitest.

**Spec:** [docs/superpowers/specs/2026-05-24-telegram-plans-active-subscriber-design.md](../specs/2026-05-24-telegram-plans-active-subscriber-design.md)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `apps/bot/src/i18n.ts` | modify | Add `currentPlanText` function and `manageOnWebBtn` string to `Dict`; provide EN+RU implementations (use `pluralizeRu` for день/дня/дней in RU). |
| `apps/bot/src/__tests__/i18n.test.ts` | modify | Tests for `currentPlanText` (EN active, RU active with plurals, `daysUntilPeriodEnd === 0`, `periodEnd === null`) and `manageOnWebBtn`. |
| `apps/bot/src/handlers.ts` | modify | Replace `case "plans":` body - branch on existing user + plan; for active call `getUsageForUser`, format, send text with inline button. |

---

## Task 1: i18n additions

**Files:**
- Modify: `apps/bot/src/i18n.ts`
- Test: `apps/bot/src/__tests__/i18n.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/bot/src/__tests__/i18n.test.ts`, append before the closing `});` of the `describe("bot i18n", ...)` block:

```ts
it("exposes manageOnWebBtn in both locales", () => {
  expect(t("en").manageOnWebBtn).toBe("🔧 Manage on clipclap.io");
  expect(t("ru").manageOnWebBtn).toBe("🔧 Управление на clipclap.io");
});

it("currentPlanText renders EN active plan with renewal", () => {
  const text = t("en").currentPlanText({
    plan: "MAX",
    billingCycle: "monthly",
    periodEnd: "2026-06-24",
    daysUntilPeriodEnd: 31,
  });
  expect(text).toContain("Current plan: MAX (monthly)");
  expect(text).toContain("Renews: 2026-06-24 (in 31 days)");
});

it("currentPlanText renders RU active plan with renewal and correct plurals", () => {
  const weekly = t("ru").currentPlanText({
    plan: "STARTER",
    billingCycle: "weekly",
    periodEnd: "2026-05-31",
    daysUntilPeriodEnd: 7,
  });
  expect(weekly).toContain("Текущий тариф: STARTER (недельный)");
  expect(weekly).toContain("Продление: 2026-05-31 (через 7 дней)");

  const monthly = t("ru").currentPlanText({
    plan: "MAX",
    billingCycle: "monthly",
    periodEnd: "2026-06-24",
    daysUntilPeriodEnd: 31,
  });
  expect(monthly).toContain("Текущий тариф: MAX (месячный)");
  expect(monthly).toContain("Продление: 2026-06-24 (через 31 день)");
});

it("currentPlanText renders RU день/дня/дней at n=1, 3, 11", () => {
  const one = t("ru").currentPlanText({
    plan: "PLUS",
    billingCycle: "monthly",
    periodEnd: "2026-05-25",
    daysUntilPeriodEnd: 1,
  });
  expect(one).toContain("через 1 день");

  const three = t("ru").currentPlanText({
    plan: "PLUS",
    billingCycle: "monthly",
    periodEnd: "2026-05-27",
    daysUntilPeriodEnd: 3,
  });
  expect(three).toContain("через 3 дня");

  const eleven = t("ru").currentPlanText({
    plan: "PLUS",
    billingCycle: "monthly",
    periodEnd: "2026-06-04",
    daysUntilPeriodEnd: 11,
  });
  expect(eleven).toContain("через 11 дней");
});

it("currentPlanText renders 'today' / 'сегодня' when daysUntilPeriodEnd is 0", () => {
  expect(
    t("en").currentPlanText({
      plan: "MAX",
      billingCycle: "monthly",
      periodEnd: "2026-05-24",
      daysUntilPeriodEnd: 0,
    })
  ).toContain("Renews: 2026-05-24 (today)");

  expect(
    t("ru").currentPlanText({
      plan: "MAX",
      billingCycle: "monthly",
      periodEnd: "2026-05-24",
      daysUntilPeriodEnd: 0,
    })
  ).toContain("Продление: 2026-05-24 (сегодня)");
});

it("currentPlanText omits Renews line when periodEnd is null", () => {
  const en = t("en").currentPlanText({
    plan: "PLUS",
    billingCycle: "monthly",
    periodEnd: null,
    daysUntilPeriodEnd: null,
  });
  expect(en).toContain("Current plan: PLUS (monthly)");
  expect(en).not.toContain("Renews");

  const ru = t("ru").currentPlanText({
    plan: "PLUS",
    billingCycle: "monthly",
    periodEnd: null,
    daysUntilPeriodEnd: null,
  });
  expect(ru).toContain("Текущий тариф: PLUS (месячный)");
  expect(ru).not.toContain("Продление");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `/srv/saas/clipclap.io`:
`npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: Six new tests fail with errors like `t("en").manageOnWebBtn is undefined` and `t("en").currentPlanText is not a function`.

- [ ] **Step 3: Extend the `Dict` interface**

In `apps/bot/src/i18n.ts`, add these two fields to the `Dict` interface (alongside existing fields - typical placement is after `accountText` and before `planNone`, but anywhere is acceptable):

```ts
  currentPlanText: (params: {
    plan: string;
    billingCycle: string | null;
    periodEnd: string | null;
    daysUntilPeriodEnd: number | null;
  }) => string;
  manageOnWebBtn: string;
```

- [ ] **Step 4: Add EN values**

In `apps/bot/src/i18n.ts`, inside `const en: Dict = { ... }`, add these entries:

```ts
  currentPlanText: ({ plan, billingCycle, periodEnd, daysUntilPeriodEnd }) => {
    const planLine = `Current plan: ${plan}${billingCycle ? ` (${billingCycle})` : ""}`;
    if (!periodEnd) return planLine;
    const suffix =
      daysUntilPeriodEnd === null
        ? ""
        : daysUntilPeriodEnd === 0
          ? " (today)"
          : ` (in ${daysUntilPeriodEnd} day${daysUntilPeriodEnd === 1 ? "" : "s"})`;
    return `${planLine}\nRenews: ${periodEnd}${suffix}`;
  },
  manageOnWebBtn: "🔧 Manage on clipclap.io",
```

- [ ] **Step 5: Add RU values**

In `apps/bot/src/i18n.ts`, inside `const ru: Dict = { ... }`, add these entries:

```ts
  currentPlanText: ({ plan, billingCycle, periodEnd, daysUntilPeriodEnd }) => {
    const cycleLabel =
      billingCycle === null
        ? ""
        : billingCycle === "weekly" || billingCycle === "WEEKLY"
          ? " (недельный)"
          : " (месячный)";
    const planLine = `Текущий тариф: ${plan}${cycleLabel}`;
    if (!periodEnd) return planLine;
    const suffix =
      daysUntilPeriodEnd === null
        ? ""
        : daysUntilPeriodEnd === 0
          ? " (сегодня)"
          : ` (через ${daysUntilPeriodEnd} ${pluralizeRu(daysUntilPeriodEnd, "день", "дня", "дней")})`;
    return `${planLine}\nПродление: ${periodEnd}${suffix}`;
  },
  manageOnWebBtn: "🔧 Управление на clipclap.io",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck -w @clipclap/bot`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/i18n.ts apps/bot/src/__tests__/i18n.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): add currentPlanText + manageOnWebBtn for active subscribers"
```

---

## Task 2: Handler - branch on plan in `case "plans"`

**Files:**
- Modify: `apps/bot/src/handlers.ts`

- [ ] **Step 1: Replace the `case "plans":` block**

In `apps/bot/src/handlers.ts`, find the existing `case "plans":` block inside `handleMenuAction` (around lines 175–183):

```ts
    case "plans": {
      const keyboard = plansKeyboard(dict, config);
      await client.sendMessage(
        message.chat.id,
        dict.welcomeNeedsPlan(config.appUrl),
        keyboard ? { replyMarkup: keyboard } : undefined
      );
      return;
    }
```

Replace it with:

```ts
    case "plans": {
      if (!existing) {
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
        ? Math.max(
            0,
            Math.ceil(
              (usage.currentPeriodEnd.getTime() - Date.now()) / 86_400_000
            )
          )
        : null;
      const billingCycle = usage.billingCycle
        ? usage.billingCycle.toLowerCase()
        : null;

      const text = dict.currentPlanText({
        plan: usage.plan,
        billingCycle,
        periodEnd,
        daysUntilPeriodEnd,
      });

      await client.sendMessage(message.chat.id, text, {
        replyMarkup: {
          inline_keyboard: [
            [
              {
                text: dict.manageOnWebBtn,
                url: `${config.appUrl}/dashboard/plans`,
              },
            ],
          ],
        },
      });
      return;
    }
```

- [ ] **Step 2: Typecheck + full test run**

Run from repo root:
```
npm run typecheck -w @clipclap/bot && npx vitest run
```
Expected: All green.

- [ ] **Step 3: Commit**

```bash
git add apps/bot/src/handlers.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): show current-plan summary for active subscribers on /plans"
```

---

## Task 3: Manual verification

**No new code.** Smoke test in Telegram after a docker rebuild.

- [ ] **Step 1: Rebuild bot container**

Run: `docker compose up -d --build bot`
Expected: clean startup, `Bot profile sync complete (en, ru)` log line.

- [ ] **Step 2: Verify active-plan view**

In Telegram, with a user that has an active plan (e.g., MAX monthly):
- Tap 💎 Plans (or 💎 Тарифы).
- Confirm the message reads `Current plan: MAX (monthly)` / `Текущий тариф: MAX (месячный)` followed by a Renews line with the correct date + days, then a single inline button "🔧 Manage on clipclap.io".
- Tap the button - should open the browser to `https://clipclap.io/dashboard/plans`.

- [ ] **Step 3: Verify NONE-plan view (regression)**

For a user with no active plan:
- Tap 💎 Plans → confirm the existing "Send a video - pick a plan" prompt + Tribute tariff buttons appear unchanged.

- [ ] **Step 4: Verify text edge cases**

- Manually set a user's `currentPeriodEnd` to `null` in the DB (or use one in that state). Tap Plans - should show only the plan line, no Renews line.
- For a user whose `currentPeriodEnd` is today or in the past → should render "today" / "сегодня".

- [ ] **Step 5: Confirm no regressions**

- 📊 Account view still shows minutes and storage usage (unchanged).
- ❓ Help, 🌐 Language behavior unchanged.
- Video submission flow unchanged.

---

## Self-review notes

**Spec coverage:**
- "Branch logic" → Task 2.
- "Output shape" examples → covered by Task 1 tests.
- "i18n additions" (`currentPlanText`, `manageOnWebBtn`) → Task 1.
- "Handler change" → Task 2.
- "Testing" - 6 new test cases (manageOnWebBtn, EN active, RU active with plurals, day-plural variants, today/сегодня, periodEnd-null) → all covered in Task 1.

**Risks / things to watch:**
- For DUNNING / CANCELED_GRACE users, this view says "Current plan: X" cheerfully. The processing blocker still fires via `canSubmitJob` when they actually try to send a video, so the user is not left in a confusing state - but the Plans view does not warn them. Spec marks this as out of scope; if it becomes a support burden, a follow-up can add state-specific copy.
- `currentPeriodEnd` strictly in the past (`daysUntilPeriodEnd = 0`) renders "today" - for DUNNING / CANCELED_GRACE users this might be misleading. Same out-of-scope flag.
- The inline-button URL is built from `config.appUrl`, which is set from `APP_URL || NEXTAUTH_URL || "https://clipclap.io"`. In dev, this might be `http://localhost:3000` - clicking it from Telegram on a phone won't resolve. Not a production concern.
