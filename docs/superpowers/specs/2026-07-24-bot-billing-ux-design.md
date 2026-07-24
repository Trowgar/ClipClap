# Bot Billing UX: In-Bot Plans & Subscription - Design

**Date:** 2026-07-24
**Status:** Pending approval
**Author:** Trowgar

## Problem

The Telegram bot's subscription flow leaks users to the website. The copy in
`welcomeNeedsPlan`, `blocked` (no-plan / expired case), and `newAccountCreated`
tells users to go to `clipclap.io` to subscribe, and there is no clear in-bot
entry point for plans. The in-bot purchase mechanic already exists (the
`sub:PLAN:CYCLE` inline buttons + `handleSubscribeCallback`, shipped with the
Tribute Shop API migration), but it is only surfaced inside the Account view when
`plan === NONE`, and the surrounding copy still points at the site.

## Goal

Make bot billing **dead simple and fully in-bot**: a dedicated "Plans" menu
button opens a screen that describes the tiers and lets the user subscribe (pay
in Tribute); once subscribed they use the service; to cancel or change they go to
Tribute. Guiding principle (from the owner): *"paid in Tribute -> use the
service; didn't like it -> cancel in Tribute -> done."*

## Non-goals

- **Web<->bot account linking is untouched.** It already exists
  (`CALLBACK_LINK_ACCOUNT` / `createBotInitiatedLink`) and is for advanced users;
  this work does not change it.
- **No in-bot upgrade / plan-change for subscribed users.** Subscribed users get
  view + "Manage subscription" (-> Tribute) only. This deliberately avoids the
  duplicate-order / double-billing risk (an explicit non-goal of the migration).
- **No web-billing changes.** Stripe / web dashboard untouched.
- **Legitimate web links stay.** Clip-editor and dashboard links (e.g.
  `handlers.ts:378`) are real web features, not billing redirects, and are left
  as-is.

## Design

### 1. "Plans" menu button

Add a `plans` `MenuAction` and a `menuPlans` dict label, wired into
`matchMenuAction`, `buildMainMenu`, and `handleMenuAction`. Reply-keyboard layout
(5 buttons):

```
[ 💳 Plans     | 👤 Account  ]
[ 🤝 Affiliate | ❓ Help     ]
[ ⚙️ Settings              ]
```

(Emoji optional; current menu buttons have none - the implementation may keep
them text-only to match existing style. The exact emoji/labels are a plan-level
copy detail.)

### 2. `sendPlansView(client, message, dict, config, existing)`

Loads the user's usage (`getUsageForUser`) to branch on subscription state
(reusing `usage.subscriptionState` liveness, the same source `canSubmitJob` and
the Account card use). Two states:

**A. No live plan** (`existing` is null, or `plan === NONE`, or state not live):
a short plans message + the existing `plansKeyboard(dict)` inline buttons
(`sub:STARTER:WEEKLY`, `sub:STARTER:MONTHLY`, `sub:PLUS:MONTHLY`,
`sub:MAX:MONTHLY`). Content (lean - price + minutes only, the metric a clipper
cares about; numbers from `plans.ts`):

```
💳 ClipClap Plans
Pay once — start using. Cancel anytime in Tribute.

🌱 Starter — €3/wk · €9/mo — 75 / 270 min
🚀 Plus — €29/mo — 1000 min
👑 Max — €89/mo — 3500 min

Pick a plan below 👇
```

**B. Subscribed** (state live): a short status line + a single "Manage
subscription" button. No buy buttons.

```
You're on Plus ✅  Active until 2026-08-14.
Manage or cancel your subscription in Tribute.
```

Button: reuse the existing manage logic from `sendAccountView` -
`usage.paymentProvider === "tribute" ? "https://t.me/tribute" :
`${config.appUrl}/dashboard/plans``. For bot subscribers this resolves to
Tribute. Detailed usage (minutes used/limit, storage) stays in the **Account**
card - Plans stays intentionally minimal.

### 3. Remove the site redirects (billing copy)

- `welcomeNeedsPlan`, `blocked` (the no-plan / expired reason), and
  `newAccountCreated` no longer point the user to the site to **subscribe**; they
  nudge to the persistent **💳 Plans** menu button instead. Implementation must
  read each string first: only replace the *subscribe* nudge, and keep any
  legitimate non-billing web reference (e.g. a general "open the web app" link in
  `newAccountCreated`). Drop the `appUrl` argument only from messages where it
  becomes entirely unused after the change; update those call sites accordingly.
- `blocked` for a quota-exceeded reason keeps explaining the limit (the reason
  string already does) without a site link.
- **Account view when `NONE`**: stop rendering `plansKeyboard` inside the Account
  card. Replace it with a one-line nudge ("No active plan - tap 💳 Plans to
  choose one."). Plan selection now lives solely in the Plans view.

### Components / files

| File | Change |
|---|---|
| `apps/bot/src/handlers.ts` | Add `plans` to `MenuAction`, `matchMenuAction`, `buildMainMenu`, `handleMenuAction`; add `sendPlansView`; simplify `sendAccountView` (NONE -> nudge, not `plansKeyboard`); update `blocked`/`welcomeNeedsPlan`/`newAccountCreated` call sites |
| `apps/bot/src/i18n.ts` | Add `menuPlans`, `plansIntro`/plans copy, `plansSubscribed(plan, periodEnd)`, `noPlanNudge`; edit `welcomeNeedsPlan`/`blocked`/`newAccountCreated` copy (EN + RU) |
| `apps/bot/src/__tests__/plans.test.ts` (new) | Tests (below) |

Bilingual EN/RU throughout (Russian when locale starts with `ru`).

## Error handling

`getUsageForUser` failure in `sendPlansView` is unlikely (same call the Account
card makes); if it throws it propagates to the poll loop's catch (consistent with
existing menu handlers). No new external calls in this view (the order/Tribute
call only happens later, on a `sub:*` tap, which already has its own error
handling).

## Testing (in the `bot` container)

- `matchMenuAction` recognizes the new Plans label (EN + RU) -> `"plans"`.
- `sendPlansView` routing: no-user / `NONE` / expired -> plans message + the 4
  `sub:*` inline buttons; live subscriber -> status line + a single manage button
  (no `sub:*` buttons), with the manage URL `https://t.me/tribute` for a Tribute
  subscriber.
- The plans copy contains the correct prices (€3/€9/€29/€89) and minute figures
  (75/270/1000/3500).
- Regression: `welcomeNeedsPlan`, the no-plan `blocked` message, and
  `newAccountCreated` no longer contain a raw `clipclap.io` / `/dashboard` URL
  (they reference the Plans button instead).
- `buildMainMenu` includes the Plans button.

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/...`
(host Node cannot run vitest).
