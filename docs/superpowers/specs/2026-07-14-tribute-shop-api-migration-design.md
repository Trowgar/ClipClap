# Tribute Payments: Channel-Subscription -> Shop API Migration - Design

**Date:** 2026-07-14
**Status:** Pending approval
**Author:** Trowgar

## Problem

Bot subscriptions are currently sold through Tribute's **channel-subscription**
model: the bot shows static URL buttons to pre-configured Tribute products tied
to the private channel `ClipCliap News`. After payment Tribute sends a
`new_subscription`/`renewed_subscription`/`cancelled_subscription` webhook and we
activate the plan. This forces every paying user through a separate channel they
do not actually need - the product is the bot, not the channel.

Tribute now offers a **Shop API** that sells recurring subscriptions **directly
inside the bot**, no channel required. Tribute support (Lilit) confirmed:

> "You do not need to redirect users to a separate paid channel. Your bot can
> remain the product itself, while Tribute handles payment and sends your server
> the payment events needed to manage access."

We are migrating the Telegram/Tribute payment path from the channel model to the
Shop API. **Card-only, no Telegram Stars, no channel.**

### Non-goals

- **No plan-matrix changes.** The tier/period matrix stays exactly as today:
  STARTER (weekly + monthly), PLUS (monthly), MAX (monthly). No `yearly`, no new
  tiers, no `BillingCycle`/`PLAN_LIMITS` changes.
- **No Stripe changes.** The web/Stripe path is untouched.
- **No reconcile-authority upgrade.** We keep the existing push + date-expiry
  safety net for Tribute rather than actively polling order status (deferred).

## Decisions (locked with the user)

| Question | Decision |
|---|---|
| Scope | Mechanism migration only - same plan matrix, `period` in {`weekly`,`monthly`} |
| Cutover | **Hard cutover** - delete the channel-model handler; compensate the 1 live subscriber manually |
| Currency | **EUR**, prices mirror the current Tribute products (see catalog) |
| Stars | **Excluded** - standard (card) orders only; never set `starsAmount` |
| Order -> plan mapping | **Approach A** - dedicated `TributeOrder` table (uuid -> plan/cycle/user), written at order creation |

### Confirmed production state (from DB + Tribute dashboard)

- Exactly **1 active Tribute subscription**: @Maxkornilo (Максим Корнилов),
  `STARTER`/`WEEKLY`, `ACTIVE`. One user to compensate on cutover.
- Current Tribute prices (EUR): **Starter Weekly EUR 3 / Starter Monthly EUR 9 /
  Plus Monthly EUR 29 / Max Monthly EUR 99.**
- Note: **MAX is EUR 99 in Tribute but `priceUsd` is 89 in `plans.ts`.** Tribute
  prices therefore MUST live in a dedicated catalog, not be derived from
  `priceUsd`.

## Price catalog (Tribute orders)

`amount` is in minor units (cents). `currency` = `eur` for all.

| Plan | Cycle | period | amount |
|---|---|---|---|
| STARTER | WEEKLY | `weekly` | 300 |
| STARTER | MONTHLY | `monthly` | 900 |
| PLUS | MONTHLY | `monthly` | 2900 |
| MAX | MONTHLY | `monthly` | 9900 |

(Pre-launch: reconfirm exact amounts against the Tribute dashboard; a EUR 3.00
list price billed at EUR 2.10 net was observed for the one historical order, a
promo artifact that does not affect the amounts we now set ourselves.)

## Architecture

### New / changed components

1. **Outbound Shop API client** - `packages/shared/src/services/tribute-shop.service.ts` (new)
   - `createShopOrder({ plan, billingCycle, telegramId })`:
     `POST {TRIBUTE_API_BASE}/shop/orders` with header `Api-Key: {TRIBUTE_API_KEY}`.
     Request body:
     ```json
     {
       "currency": "eur",
       "amount": 900,
       "period": "monthly",
       "title": "ClipClap Starter (monthly)",
       "description": "ClipClap subscription",
       "customerId": "<telegramId>",
       "successUrl": "https://t.me/clipclapio_bot",
       "failUrl": "https://t.me/clipclapio_bot"
     }
     ```
     Returns `{ uuid, webappPaymentUrl, ... }`. Never sets `starsAmount`
     (guarantees a card/standard order, so all periods auto-renew by card).
   - `cancelShopOrder(uuid)`: `POST /shop/orders/{uuid}/cancel` - defined now,
     wired to a native "cancel" button only if we add one later (not in scope).

2. **Tribute price catalog** - config module mapping
   `(plan, billingCycle) -> { amount, currency, period, title, description }`.
   Replaces the env product matrix (`TRIBUTE_PRODUCT_*_ID/_NAME/_URL`) and the
   `TRIBUTE_TIERS` array + `loadTributeProductIndexFromEnv` /
   `resolveProductBinding` / `extractStartapp` / `normalizeProductName` (all
   deleted). Because we create the order, plan/cycle is known up front and the
   fragile startapp/name resolution disappears entirely.

3. **`TributeOrder` Prisma model** (new):
   ```prisma
   enum TributeOrderStatus { PENDING PAID DUNNING CANCELLED REFUNDED FAILED }

   model TributeOrder {
     id           String            @id @default(cuid())
     orderUuid    String            @unique
     userId       String
     telegramId   String
     plan         Plan
     billingCycle BillingCycle
     amount       Int
     currency     String
     status       TributeOrderStatus @default(PENDING)
     createdAt    DateTime          @default(now())
     updatedAt    DateTime          @updatedAt
     user         User              @relation(fields: [userId], references: [id])
     @@index([userId])
     @@map("tribute_orders")
   }
   ```
   `User` stays authoritative for access. `TributeOrder` is the `uuid -> plan`
   map + an audit trail (needed for refunds and re-subscribes). Order status is
   informational.

4. **Rewritten webhook handler** (`tribute.service.ts`) - see Data flow. Keeps
   the inbox state-machine (`processTributeEvent`, `TributeWebhookEvent`) and the
   HMAC verify (`verifyTributeSignature`, `TRIBUTE_SIGNATURE_HEADER`) unchanged
   in shape. Changes: envelope type, `hashTributeEvent` identity key, event
   canonicalization, dispatch table, and order-based mapping.

5. **Bot flow** (`apps/bot/src/handlers.ts`, `apps/bot/src/index.ts`):
   - `plansKeyboard`: static `url` buttons -> `callback_data` buttons
     (`sub:<PLAN>:<CYCLE>`).
   - New callback handler on `sub:*`: call `createShopOrder`, insert
     `TributeOrder(PENDING)`, edit the message to a single "Pay" button linking
     to `webappPaymentUrl`.
   - Remove `tributeUrls` config + its `index.ts` env wiring.
   - "Manage subscription" keeps linking to `https://t.me/tribute` (unchanged).

### Preserved without change

DB state machine (`plan`, `subscriptionStatus`, `currentPeriodEnd`,
`graceEndsAt`, `dunningSince`); inbox/idempotency (`TributeWebhookEvent` +
`processTributeEvent`); signature verify; gating (`canSubmitJob`); notifications
(`notifyPaymentEvent`); referral accrual; reconcile cron. The order uuid is
stored in the existing `User.tributeSubscriptionId` field, so the reconcile
Tribute branch (date-expiry past grace) keeps working untouched.

## Data flow

### Subscribe

1. User taps `sub:STARTER:MONTHLY`.
2. Bot calls `createShopOrder({ plan:STARTER, cycle:MONTHLY, telegramId })`.
3. On success: insert `TributeOrder(orderUuid, userId, plan, cycle, amount,
   currency, status=PENDING)`; edit message -> "Pay" button to `webappPaymentUrl`.
4. On Shop API failure: show a retry error; **no** `TributeOrder` row written.
5. User pays by card inside the Tribute mini-app.

### Webhook events -> state

Mapping: look up `TributeOrder` by `orderUuid` from the payload (primary);
`customerId == telegramId` is the fallback. Unknown uuid -> treat as
unmapped/FAILED -> 5xx so Tribute retries (should not happen, we mint all uuids).

| Event | User effect | Order status | Side effects |
|---|---|---|---|
| `shopOrder` / `shopOrderPaymentReceived` | ACTIVE, `currentPeriodEnd`=expiry, `tributeSubscriptionId`=uuid, clear dunning/grace | PAID | referral accrual, `subscription_activated` notify |
| `shopOrderChargeSuccess` | extend `currentPeriodEnd`, ACTIVE, clear dunning | PAID | referral accrual, `subscription_renewed` notify |
| `shopOrderChargeFailed` | `DUNNING`, stamp `dunningSince` on transition only | DUNNING | (optional dunning notify) |
| `shopOrderCancelled` | `CANCELED_GRACE` if period live else `CANCELED`, set `graceEndsAt` | CANCELLED | `subscription_canceled` notify |
| `shopOrderRefunded` | `CANCELED`, clear grace | REFUNDED | void referral commission |
| `shopOrderPaymentFailed` | none (never had access) | FAILED | none |

`hashTributeEvent` is re-keyed on Shop API identity: canonical event name +
`orderUuid` + transaction id (or period marker) + `customerId`. Excludes
`sent_at`/`created_at` so retries dedup (same as today).

## Cutover (hard)

Deleted in this change: `resolveProductBinding`, `extractStartapp`,
`normalizeProductName`, `loadTributeProductIndexFromEnv`, `TRIBUTE_TIERS`,
`applySubscription`/`applyCancellation` (snake_case), the snake_case dispatch,
the URL `plansKeyboard`, and env vars `TRIBUTE_PRODUCT_*_ID/_NAME/_URL`.

The single live subscriber (@Maxkornilo, Starter Weekly) is compensated with a
one-off `tsx` script that extends `currentPeriodEnd` (same pattern as the
2026-07-13 webhook-fix replay), then asked to re-subscribe through the new bot
flow. Their old channel subscription in Tribute is cancelled manually in the
dashboard.

## Open items to confirm at implementation

- **Exact Shop API webhook payload/envelope shape** - the wiki serves it via an
  interactive OpenAPI widget we could not scrape. Confirm the event-name field,
  and that `orderUuid`, `customerId`, and the expiry timestamp are present, via
  the OpenAPI JSON or a test webhook, **before** writing the parser. The design
  is resilient regardless because mapping is by the uuid we generate.
- Whether `TRIBUTE_API_KEY` serves **both** outbound `Api-Key` auth and webhook
  HMAC (docs imply yes - "signed with your API key").
- Whether `shopId` is required in `createShopOrder` (`GET /shops` to discover;
  add `TRIBUTE_SHOP_ID` env if so).
- `webappPaymentUrl` button type (`url` vs Telegram `web_app`).
- Enable "recurring payments" for the Tribute Shop in settings (Lilit's note).

## Env changes

- **Remove:** `TRIBUTE_PRODUCT_STARTER_WEEKLY_ID/_NAME/_URL`,
  `TRIBUTE_PRODUCT_STARTER_MONTHLY_*`, `TRIBUTE_PRODUCT_PLUS_MONTHLY_*`,
  `TRIBUTE_PRODUCT_MAX_MONTHLY_*` (12 vars).
- **Keep:** `TRIBUTE_API_KEY`.
- **Add:** `TRIBUTE_API_BASE` (default `https://tribute.tg/api/v1`); optionally
  `TRIBUTE_SHOP_ID` (if required by createOrder).

## Error handling

- `createShopOrder` failure (Tribute down): bot shows a retryable error; no order
  row persisted.
- Webhook signature invalid -> 401. Malformed envelope -> 400.
- Handler error / unknown order uuid -> row `FAILED`, route returns 5xx so
  Tribute retries (unchanged behavior).
- Best-effort side effects (referral accrual, Telegram notify) never roll back a
  paid activation - preserved from current code.

## Testing

Rewrite `packages/shared/src/services/__tests__/tribute.service.test.ts`:

- Signature verify (reuse existing cases).
- Canonicalization of `shopOrder*` event names.
- Each handler: activate / renew / charge-failed(dunning) / cancel(grace vs hard)
  / refund / initial-payment-failed.
- Order mapping by `orderUuid`; fallback by `customerId`; unknown-uuid -> FAILED.
- Idempotency/dedup and the stale/out-of-order guard.

New tests:

- `tribute-shop.service` - `createShopOrder` builds the correct body per
  plan/cycle (mock `fetch`); never includes `starsAmount`.
- Bot callback `sub:*` -> order creation -> Pay button (mock client).

Run in the `bot` and `web` containers per project convention (host Node cannot
run vitest).

## Rollout

1. Ship schema migration (`TributeOrder` + `TributeOrderStatus`) via
   `prisma migrate` (not `db push`).
2. Deploy; set `Api-Key`/webhook URL in Tribute; enable recurring payments.
3. Compensate @Maxkornilo; cancel their old channel sub in Tribute.
4. Smoke test: create an order for each tier, pay one live (or test), verify the
   activation webhook flips the user to ACTIVE.
