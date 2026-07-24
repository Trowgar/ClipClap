# In-Bot Billing/Plans UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated "💳 Plans" menu button that opens an in-bot plans screen (subscribe when no plan; view + manage when subscribed), and stop the bot from sending users to the website to subscribe.

**Architecture:** Bot-only. A new `plans` `MenuAction` routes to a new `sendPlansView` that reuses the existing `sub:*` `plansKeyboard` (no plan) or shows a status line + a single Manage->Tribute button (subscribed). Plan selection is centralized in `sendPlansView`; the Account view and onboarding stop rendering plan buttons and nudge to the Plans button; the site-URL billing copy is removed.

**Tech Stack:** TypeScript, a plain grammY-free polling bot (`apps/bot`), Vitest (runs **inside the `bot` container** - host Node 18 cannot run Vitest).

**Design spec:** `docs/superpowers/specs/2026-07-24-bot-billing-ux-design.md`

**Branch:** `feat/bot-billing-ux` (already checked out).

## Conventions

- Commit identity: `git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "..."`. No attribution trailer.
- Bot tests: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/<file>`
- Bot typecheck: `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `apps/bot/src/i18n.ts` | Modify | Add `menuPlans`, `plansText`, `plansSubscribed`, `noPlanNudge`; drop the site URL from `welcomeNeedsPlan`/`newAccountCreated`/`blocked` (EN+RU) |
| `apps/bot/src/handlers.ts` | Modify | `plans` MenuAction + wiring; `sendPlansView`; remove `plansKeyboard` from Account/onboarding; nudges; drop `appUrl` from `blocked` call sites |
| `apps/bot/src/__tests__/plans.test.ts` | Create | i18n + menu + `sendPlansView` tests |

---

## Task 1: i18n - Plans strings + de-link billing copy

**Files:**
- Modify: `apps/bot/src/i18n.ts` (Dict type ~26-63; EN dict ~104-154; RU dict ~242-294)
- Create: `apps/bot/src/__tests__/plans.test.ts`

- [ ] **Step 1: Write the failing i18n test**

Create `apps/bot/src/__tests__/plans.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { t } from "../i18n";

describe("plans i18n", () => {
  it("has the Plans menu label in both locales", () => {
    expect(t("en").menuPlans).toBe("💳 Plans");
    expect(t("ru").menuPlans).toBe("💳 Тарифы");
  });

  it("plansText lists the real prices and minutes", () => {
    for (const loc of ["en", "ru"] as const) {
      const s = t(loc).plansText;
      expect(s).toContain("€3");
      expect(s).toContain("€9");
      expect(s).toContain("€29");
      expect(s).toContain("€89");
      expect(s).toContain("75");
      expect(s).toContain("1000");
      expect(s).toContain("3500");
    }
  });

  it("plansSubscribed shows the plan and renewal date", () => {
    expect(t("en").plansSubscribed("PLUS", "2026-08-14")).toContain("PLUS");
    expect(t("en").plansSubscribed("PLUS", "2026-08-14")).toContain("2026-08-14");
    expect(t("ru").plansSubscribed("MAX", null)).toContain("MAX");
  });

  it("billing copy no longer links to the website", () => {
    for (const loc of ["en", "ru"] as const) {
      const d = t(loc);
      expect(d.welcomeNeedsPlan).not.toMatch(/dashboard|clipclap\.io/);
      expect(d.newAccountCreated).not.toMatch(/dashboard|clipclap\.io/);
      expect(d.blocked("limit reached")).not.toMatch(/dashboard|clipclap\.io/);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/plans.test.ts`
Expected: FAIL - `menuPlans`/`plansText`/`plansSubscribed` undefined, and `welcomeNeedsPlan` is still a function (not a string).

- [ ] **Step 3: Update the `Dict` type**

In `apps/bot/src/i18n.ts`:
- Change line 29 `welcomeNeedsPlan: (url: string) => string;` to `welcomeNeedsPlan: string;`
- Change line 32 `newAccountCreated: (url: string) => string;` to `newAccountCreated: string;`
- Change line 50 `blocked: (reason: string, url: string) => string;` to `blocked: (reason: string) => string;`
- After line 62 (`menuAffiliate: string;`) add:
```ts
  menuPlans: string;
  plansText: string;
  plansSubscribed: (plan: string, periodEnd: string | null) => string;
  noPlanNudge: string;
```

- [ ] **Step 4: Update the EN dict**

Replace EN `welcomeNeedsPlan` (lines 104-105) with:
```ts
  welcomeNeedsPlan:
    "Send a video and I'll generate clips. To enable processing, tap 💳 Plans and pick a plan.",
```
Replace EN `newAccountCreated` (lines 108-109) with:
```ts
  newAccountCreated:
    "Account created. Send a video here and I'll start clipping.\n\nTo enable processing, tap 💳 Plans and pick a plan.",
```
Replace EN `blocked` (line 141) with:
```ts
  blocked: (reason) => `${reason}\n\n💳 Plans — choose or manage your subscription.`,
```
After EN `menuAffiliate` (line 154) add:
```ts
  menuPlans: "💳 Plans",
  plansText:
    "💳 ClipClap Plans\nPay once — start using. Cancel anytime in Tribute.\n\n" +
    "🌱 Starter — €3/wk · €9/mo — 75 / 270 min\n" +
    "🚀 Plus — €29/mo — 1000 min\n" +
    "👑 Max — €89/mo — 3500 min\n\n" +
    "Pick a plan below 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `You're on ${plan} ✅  Active until ${periodEnd}.\nManage or cancel your subscription in Tribute.`
      : `You're on ${plan} ✅\nManage or cancel your subscription in Tribute.`,
  noPlanNudge: "No active plan — tap 💳 Plans to choose one.",
```

- [ ] **Step 5: Update the RU dict**

Replace RU `welcomeNeedsPlan` (lines 242-243) with:
```ts
  welcomeNeedsPlan:
    "Пришли видео - сделаю клипы. Чтобы запустить обработку, нажми 💳 Тарифы и выбери план.",
```
Replace RU `newAccountCreated` (lines 246-247) with:
```ts
  newAccountCreated:
    "Аккаунт создан. Пришли видео - начну нарезку.\n\nЧтобы запустить обработку, нажми 💳 Тарифы и выбери план.",
```
Replace RU `blocked` (line 281) with:
```ts
  blocked: (reason) => `${reason}\n\n💳 Тарифы — выбрать или управлять подпиской.`,
```
After RU `menuAffiliate` (line 294) add:
```ts
  menuPlans: "💳 Тарифы",
  plansText:
    "💳 Тарифы ClipClap\nОплатил — пользуешься. Отменить можно в любой момент в Tribute.\n\n" +
    "🌱 Starter — €3/нед · €9/мес — 75 / 270 мин\n" +
    "🚀 Plus — €29/мес — 1000 мин\n" +
    "👑 Max — €89/мес — 3500 мин\n\n" +
    "Выбери план ниже 👇",
  plansSubscribed: (plan, periodEnd) =>
    periodEnd
      ? `Ты на плане ${plan} ✅  Активен до ${periodEnd}.\nУправление и отмена — в Tribute.`
      : `Ты на плане ${plan} ✅\nУправление и отмена — в Tribute.`,
  noPlanNudge: "Нет активного плана — нажми 💳 Тарифы, чтобы выбрать.",
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/plans.test.ts`
Expected: FAIL still - `handlers.ts` won't compile yet because it calls `dict.welcomeNeedsPlan(...)`/`dict.newAccountCreated(...)`/`dict.blocked(reason, url)` as functions with the old signatures. That is fixed in Tasks 2-3. If the ONLY failures are TS errors in `handlers.ts` about those three call sites, that is expected; the i18n assertions themselves must pass. Confirm by reading the failure output.

> Do NOT commit yet - `handlers.ts` is mid-change. Task 3 finishes the call sites; commit happens at the end of Task 3. (Tasks 1-3 are one cohesive change to two files.)

---

## Task 2: Plans menu button + `sendPlansView`

**Files:**
- Modify: `apps/bot/src/handlers.ts` (MenuAction 83; matchMenuAction 85-94; buildMainMenu 96-105; parseMenuCommand 205-209; handleMenuAction 211-239; add `sendPlansView`)
- Modify: `apps/bot/src/__tests__/plans.test.ts`

- [ ] **Step 1: Add the failing menu + view tests**

Append to `apps/bot/src/__tests__/plans.test.ts`:

```ts
import { vi } from "vitest";

const flowMocks = vi.hoisted(() => ({ getUsageForUser: vi.fn() }));
vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getUsageForUser: flowMocks.getUsageForUser, prisma: { user: { findUnique: vi.fn() } } };
});

import { matchMenuAction, sendPlansView } from "../handlers";

function fakeClient() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
}

describe("plans menu wiring", () => {
  it("matches the Plans label to the plans action (EN + RU), others unchanged", () => {
    expect(matchMenuAction("💳 Plans")).toBe("plans");
    expect(matchMenuAction("💳 Тарифы")).toBe("plans");
    expect(matchMenuAction("📊 Account")).toBe("account");
  });
});

describe("sendPlansView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no user: shows plan cards + sub:* buttons without calling getUsageForUser", async () => {
    const client = fakeClient();
    await sendPlansView(client, { chat: { id: 1 } } as never, t("en"), { appUrl: "https://x" }, null);
    expect(flowMocks.getUsageForUser).not.toHaveBeenCalled();
    const call = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(call[1]).toContain("€89");
    expect(JSON.stringify(call[2])).toContain("sub:MAX:MONTHLY");
  });

  it("no live plan: shows plan cards + sub:* buttons", async () => {
    flowMocks.getUsageForUser.mockResolvedValue({ plan: "NONE", subscriptionState: { phase: "NONE", live: false }, currentPeriodEnd: null, paymentProvider: null });
    const client = fakeClient();
    await sendPlansView(client, { chat: { id: 1 } } as never, t("en"), { appUrl: "https://x" }, { id: "u1" });
    const call = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(JSON.stringify(call[2])).toContain("sub:STARTER:WEEKLY");
  });

  it("subscribed: status line + single Manage->Tribute button, no buy buttons", async () => {
    flowMocks.getUsageForUser.mockResolvedValue({ plan: "PLUS", subscriptionState: { phase: "ACTIVE", live: true }, currentPeriodEnd: new Date("2026-08-14T00:00:00.000Z"), paymentProvider: "tribute" });
    const client = fakeClient();
    await sendPlansView(client, { chat: { id: 1 } } as never, t("en"), { appUrl: "https://x" }, { id: "u1" });
    const call = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(call[1]).toContain("PLUS");
    expect(call[1]).toContain("2026-08-14");
    const opts = JSON.stringify(call[2]);
    expect(opts).toContain("https://t.me/tribute");
    expect(opts).not.toContain("sub:");
  });
});
```

Add `import { beforeEach } from "vitest";` to the top of the file if not already imported (the first `describe` block only used `describe/expect/it`).

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/plans.test.ts`
Expected: FAIL - `sendPlansView` not exported; `matchMenuAction` returns null for the Plans label.

- [ ] **Step 3: Wire the `plans` menu action**

In `apps/bot/src/handlers.ts`:

Change line 83 to:
```ts
export type MenuAction = "account" | "help" | "settings" | "affiliate" | "plans";
```

In `matchMenuAction` (after the `menuAffiliate` check, ~line 91) add:
```ts
    if (text === d.menuPlans) return "plans";
```

Replace `buildMainMenu`'s `keyboard` (lines 98-101) with:
```ts
    keyboard: [
      [{ text: dict.menuPlans }, { text: dict.menuAccount }],
      [{ text: dict.menuAffiliate }, { text: dict.menuHelp }],
      [{ text: dict.menuSettings }],
    ],
```

Change `parseMenuCommand`'s regex (line 206) to include `plans`:
```ts
  const m = /^\/(account|help|settings|plans)(@\S+)?(\s|$)/.exec(text);
```

In `handleMenuAction`'s `switch` (before the closing brace, after the `affiliate` case ~line 237) add:
```ts
    case "plans": {
      await sendPlansView(client, message, dict, config, existing);
      return;
    }
```

- [ ] **Step 4: Add `sendPlansView`**

Add this function right after `sendAccountView` (after its closing brace, ~line 326). `getUsageForUser` is already imported from `@clipclap/shared` at the top of the file; `plansKeyboard` is defined lower in the file.

```ts
export async function sendPlansView(
  client: TelegramClient,
  message: TelegramMessage,
  dict: Dict,
  config: BotRuntimeConfig,
  existing: { id: string } | null
) {
  // No account, or no live subscription -> show the plans + subscribe buttons.
  if (!existing) {
    await client.sendMessage(message.chat.id, dict.plansText, {
      replyMarkup: plansKeyboard(dict),
    });
    return;
  }

  const usage = await getUsageForUser(existing.id);
  if (usage.plan === "NONE" || !usage.subscriptionState.live) {
    await client.sendMessage(message.chat.id, dict.plansText, {
      replyMarkup: plansKeyboard(dict),
    });
    return;
  }

  // Live subscriber -> status + a single Manage button (-> Tribute). No buy buttons.
  const periodEnd = usage.currentPeriodEnd
    ? usage.currentPeriodEnd.toISOString().slice(0, 10)
    : null;
  const manageUrl =
    usage.paymentProvider === "tribute"
      ? "https://t.me/tribute"
      : `${config.appUrl}/dashboard/plans`;

  await client.sendMessage(message.chat.id, dict.plansSubscribed(usage.plan, periodEnd), {
    replyMarkup: {
      inline_keyboard: [[{ text: dict.manageSubscriptionBtn, url: manageUrl }]],
    },
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/plans.test.ts`
Expected: the menu + `sendPlansView` tests PASS. (The i18n `blocked`/`welcomeNeedsPlan`/`newAccountCreated` call-site TS errors in `handlers.ts` are fixed in Task 3; if a compile error about those specific call sites remains, that is expected until Task 3.)

> Still no commit - Task 3 finishes the file.

---

## Task 3: Centralize plan selection (remove site redirects)

**Files:**
- Modify: `apps/bot/src/handlers.ts` (`sendAccountView` 248-312; `handleStart` NONE branch 442-455; `CALLBACK_NEW_ACCOUNT` branch ~486-503; `blocked` call sites ~822 & ~902)
- Modify: `apps/bot/src/__tests__/plans.test.ts`

- [ ] **Step 1: Add the failing Account-nudge test**

Append to `apps/bot/src/__tests__/plans.test.ts` a check that the Account view no longer emits `sub:*` buttons for a NONE user. Because `sendAccountView` is not exported, assert the behavior through the exported `sendPlansView` contract already covered, PLUS a direct string check that the nudge is used. Add:

```ts
describe("account nudge copy", () => {
  it("noPlanNudge points at the Plans button, not the site", () => {
    expect(t("en").noPlanNudge).toContain("💳 Plans");
    expect(t("en").noPlanNudge).not.toMatch(/dashboard|clipclap\.io/);
    expect(t("ru").noPlanNudge).toContain("💳 Тарифы");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/plans.test.ts`
Expected: FAIL - `noPlanNudge` assertion already passes (added in Task 1) BUT the suite still fails to compile due to the remaining `handlers.ts` call sites using the old function signatures. Proceed to fix them.

- [ ] **Step 3: Account view - nudge instead of plan buttons**

In `sendAccountView`, the **no-existing** branch (lines 263-268): replace
```ts
    const keyboard = plansKeyboard(dict);
    await client.sendMessage(
      message.chat.id,
      text,
      keyboard ? { replyMarkup: keyboard } : undefined
    );
    return;
```
with
```ts
    await client.sendMessage(message.chat.id, `${text}\n\n${dict.noPlanNudge}`);
    return;
```

In `sendAccountView`, the **existing + NONE** branch (lines 304-311): replace
```ts
  if (usage.plan === "NONE") {
    const keyboard = plansKeyboard(dict);
    await client.sendMessage(
      message.chat.id,
      text,
      keyboard ? { replyMarkup: keyboard } : undefined
    );
    return;
  }
```
with
```ts
  if (usage.plan === "NONE") {
    await client.sendMessage(message.chat.id, `${text}\n\n${dict.noPlanNudge}`);
    return;
  }
```

- [ ] **Step 4: Onboarding - drop inline plan buttons + fix copy**

In `handleStart`, the NONE branch (lines 442-455): replace
```ts
  if (usage.plan === "NONE") {
    const keyboard = plansKeyboard(dict);
    await client.sendMessage(
      message.chat.id,
      dict.welcomeNeedsPlan(config.appUrl),
      keyboard ? { replyMarkup: keyboard } : undefined
    );
    // Attach the persistent reply menu in a separate follow-up so the user has
    // access to Account/Help/Language even before they pick a plan.
    await client.sendMessage(message.chat.id, dict.menuHint, {
      replyMarkup: buildMainMenu(dict),
    });
    return;
  }
```
with
```ts
  if (usage.plan === "NONE") {
    // The persistent menu (below) carries the 💳 Plans button; welcomeNeedsPlan
    // nudges the user to it, so no inline plan buttons here.
    await client.sendMessage(message.chat.id, dict.welcomeNeedsPlan, {
      replyMarkup: buildMainMenu(dict),
    });
    return;
  }
```

In `handleCallbackQuery`, the `CALLBACK_NEW_ACCOUNT` case: find the block that renders `dict.newAccountCreated(config.appUrl)` together with `plansKeyboard(dict)` (the `editMessageText` call followed by a `sendMessage` of `dict.menuHint`). Replace the `newAccountCreated` call `dict.newAccountCreated(config.appUrl)` with `dict.newAccountCreated`, and remove the `plansKeyboard(dict)` keyboard from that `editMessageText` (pass no `replyMarkup`). The existing follow-up that sends `dict.menuHint` with `buildMainMenu(dict)` stays (it now carries the Plans button). Concretely, that case becomes:
```ts
    case CALLBACK_NEW_ACCOUNT: {
      await resolveTelegramUser(query.from);
      await client
        .editMessageText(
          query.message.chat.id,
          query.message.message_id,
          dict.newAccountCreated
        )
        .catch(() => undefined);
      await client
        .sendMessage(query.message.chat.id, dict.menuHint, {
          replyMarkup: buildMainMenu(dict),
        })
        .catch(() => undefined);
      return;
    }
```
(If the current code differs slightly - e.g. variable names - keep its structure but apply the same two changes: `newAccountCreated` takes no argument, and no `plansKeyboard`.)

- [ ] **Step 5: `blocked` call sites - drop the URL argument**

`blocked` is now `(reason) => string`. Update both call sites (search for `dict.blocked(`): change `dict.blocked(blockedReason, config.appUrl)` to `dict.blocked(blockedReason)` (both occurrences, ~lines 822 and 902).

- [ ] **Step 6: Verify `plansKeyboard` has a single caller**

Run: `grep -n "plansKeyboard(" apps/bot/src/handlers.ts`
Expected: `plansKeyboard` is defined once and called only inside `sendPlansView` (two calls). No calls remain in `sendAccountView`, `handleStart`, or `handleCallbackQuery`.

- [ ] **Step 7: Typecheck + run the full bot suite**

Run:
```bash
docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit
docker compose exec -T -w /app bot npx vitest run apps/bot
```
Expected: tsc clean (no more old-signature call-site errors); all bot tests pass (existing suites + the new `plans.test.ts`).

- [ ] **Step 8: Commit (Tasks 1-3 together)**

```bash
git add apps/bot/src/i18n.ts apps/bot/src/handlers.ts apps/bot/src/__tests__/plans.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): in-bot Plans screen + menu button; drop site-redirect billing copy"
```

---

## Task 4: Live verification + restart

- [ ] **Step 1: Restart the bot to load the changes**

Run:
```bash
docker compose restart bot
docker compose logs --tail=5 bot
```
Expected: bot starts cleanly ("ClipClap Telegram bot starting").

- [ ] **Step 2: Manual smoke (in Telegram @clipclapio_bot)**

- The reply menu shows **💳 Plans / 💳 Тарифы**.
- Tap it as a NON-subscribed user -> plan cards + the 4 subscribe buttons.
- Tap it as a subscribed user -> status line + a single "Manage subscription" button (opens `t.me/tribute`).
- `/start` with no plan and the Account view no longer link to `clipclap.io/dashboard/plans`; they point at 💳 Plans.

---

## Self-Review (completed by plan author)

**Spec coverage:** Plans menu button -> Task 2. `sendPlansView` two states -> Task 2 (impl) + Task 2 tests. Plan-card content (price+minutes) -> Task 1 `plansText`. Subscribed view + Manage->Tribute -> Task 2 (`plansSubscribed` + manage button). Remove site redirects (`welcomeNeedsPlan`/`newAccountCreated`/`blocked`) -> Task 1 (copy) + Task 3 (call sites). Account NONE stops showing `plansKeyboard`, nudges -> Task 3. Keep legitimate non-billing web links -> none of the edited strings carried a non-billing link (all three were subscribe links), and `linkAccountInstructions`/`helpText`/editor links are untouched. Bilingual EN/RU -> Task 1. Non-goals (account linking, in-bot upgrade, web billing) -> untouched.

**Placeholder scan:** none - every step has concrete code and exact commands. The one soft spot (Task 3 Step 4's "if the current code differs slightly") gives an exact target block plus the two invariant changes, not a vague instruction.

**Type consistency:** `menuPlans`/`plansText`/`plansSubscribed(plan, periodEnd)`/`noPlanNudge` are defined in the Dict (Task 1) and used identically in Task 2/3. `welcomeNeedsPlan`/`newAccountCreated` become plain strings and every call site is updated (Task 3 Steps 4). `blocked(reason)` single-arg matches both call sites (Task 3 Step 5). `sendPlansView` signature matches its tests and its `handleMenuAction` call. `usage.subscriptionState.live` confirmed to exist on the `SubscriptionState` returned by `getUsageForUser`.

**Note:** Tasks 1-3 are one cohesive change across two files (`handlers.ts` won't compile between them), so they share a single commit at Task 3 Step 8 - deliberate, called out at each interim step.
