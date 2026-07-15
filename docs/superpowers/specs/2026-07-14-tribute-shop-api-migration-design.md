# Tribute Payments: Channel-Subscription -> Shop API Migration - Design

**Date:** 2026-07-14
**Status:** Revised per review - pending re-approval
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
- **No transaction-level reconciliation.** Transaction-level reconciliation,
  automated refund handling, and referral commission voiding are deferred.
  Refund events are recorded and surfaced for manual review but do NOT
  automatically modify subscription access or referral ledger entries. (Tribute
  refunds are per-transaction, not per-subscription: `shop_order_refunded`
  carries a `transactionId` and may leave `memberStatus=active`, while success
  events carry no `transactionId` - a correct ledger needs a separate
  `/shop/orders/{uuid}/transactions` sync, which is out of scope here.)
- **No durable checkout-intent recovery.** Durable checkout-intent persistence
  and automatic recovery of remotely created orders after ambiguous Shop API
  failures are deferred. Checkout correlation IDs are included in the Tribute
  order `comment` for observability and future recovery work.

## Decisions (locked with the user)

| Question | Decision |
|---|---|
| Scope | Mechanism migration only - same plan matrix, `period` in {`weekly`,`monthly`} |
| Cutover | **Hard cutover** - delete the channel-model handler; compensate the 1 live subscriber manually |
| Currency | **EUR**, prices mirror the current Tribute products (see catalog) |
| Stars | **Excluded** - standard (card) orders only; never set `starsAmount` |
| Order -> plan mapping | **Approach A** - dedicated `TributeOrder` table; mapped **only** by `orderUuid` (see below) |
| Event-name matching | Keep `canonicalTributeEventName` (case/underscore-insensitive) - robust to the unresolved snake_case-vs-camelCase question |
| Refund | **Audit-only** - record + alert, never auto-change access or referral (Q1) |
| Duplicate orders | Minimal dedupe (lock + reuse fresh PENDING + best-effort cancel on insert failure); durable orphan recovery deferred (Q2) |

### Confirmed production state (from DB + Tribute dashboard)

- Exactly **1 active Tribute subscription**: @Maxkornilo (Максим Корнилов),
  `STARTER`/`WEEKLY`, `ACTIVE`. One user to compensate on cutover.
- Current Tribute prices (EUR): **Starter Weekly EUR 3 / Starter Monthly EUR 9 /
  Plus Monthly EUR 29 / Max Monthly EUR 89.** These match `priceUsd` in
  `plans.ts` numerically; the difference is currency (EUR vs a USD display
  label), so order amounts still live in a dedicated EUR catalog rather than
  being read from `priceUsd`.

## Price catalog (Tribute orders)

`amount` is in minor units (cents). `currency` = `eur` for all.

| Plan | Cycle | period | amount |
|---|---|---|---|
| STARTER | WEEKLY | `weekly` | 300 |
| STARTER | MONTHLY | `monthly` | 900 |
| PLUS | MONTHLY | `monthly` | 2900 |
| MAX | MONTHLY | `monthly` | 8900 |

(Pre-launch: reconfirm exact amounts against the Tribute dashboard.)

## Architecture

### New / changed components

1. **Outbound Shop API client** - `packages/shared/src/services/tribute-shop.service.ts` (new)
   - `createShopOrder({ plan, billingCycle, telegramId, checkoutIntentId })`:
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
       "comment": "clipclap-checkout:<checkoutIntentId>",
       "successUrl": "https://t.me/clipclapio_bot",
       "failUrl": "https://t.me/clipclapio_bot"
     }
     ```
     Returns `{ uuid, webappPaymentUrl, ... }`. Never sets `starsAmount`
     (guarantees a card/standard order - "Bank cards: Always available" for all
     periods per the docs). `customerId` is sent for Tribute-side record only; it
     is **not** returned in webhooks, so we never map by it. `checkoutIntentId`
     is a locally generated correlation id echoed in `comment` for observability.
   - `cancelShopOrder(uuid)`: `POST /shop/orders/{uuid}/cancel`. Used now for the
     best-effort cleanup when Tribute returned a `uuid` but our local insert
     failed; also available for a future native "cancel" button (not in scope).

2. **Tribute price catalog** - config module mapping
   `(plan, billingCycle) -> { amount, currency, period, title, description }`.
   Replaces the env product matrix (`TRIBUTE_PRODUCT_*_ID/_NAME/_URL`) and the
   `TRIBUTE_TIERS` array + `loadTributeProductIndexFromEnv` /
   `resolveProductBinding` / `extractStartapp` / `normalizeProductName` (all
   deleted). Because we create the order, plan/cycle is known up front and the
   fragile startapp/name resolution disappears entirely.

3. **`TributeOrder` Prisma model** (new):
   ```prisma
   enum TributeOrderStatus { PENDING PAID DUNNING CANCELLED FAILED }

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
     @@index([userId, plan, billingCycle, status])
     @@map("tribute_orders")
   }
   ```
   `User` stays authoritative for access. `TributeOrder` is the `orderUuid ->
   plan` map + an audit trail. No `REFUNDED` status: a refund is a
   transaction-level fact, not a valid state of the whole recurring order.

4. **Rewritten webhook handler** (`tribute.service.ts`) - see Data flow. Keeps
   the inbox state-machine (`processTributeEvent`, `TributeWebhookEvent`), the
   HMAC verify (`verifyTributeSignature`, `TRIBUTE_SIGNATURE_HEADER`), and
   `canonicalTributeEventName` unchanged. Changes: envelope type, per-event-type
   `hashTributeEvent` keys, dispatch table, and order-uuid-based mapping.

5. **Bot flow** (`apps/bot/src/handlers.ts`, `apps/bot/src/index.ts`):
   - `plansKeyboard`: static `url` buttons -> `callback_data` buttons
     (`sub:<PLAN>:<CYCLE>`).
   - New callback handler on `sub:*` (see Subscribe flow) with a per-user lock.
   - Remove `tributeUrls` config + its `index.ts` env wiring.
   - "Manage subscription" keeps linking to `https://t.me/tribute` (unchanged).

### Preserved without change

DB state machine (`plan`, `subscriptionStatus`, `currentPeriodEnd`,
`graceEndsAt`, `dunningSince`); inbox/idempotency (`TributeWebhookEvent` +
`processTributeEvent`); signature verify; gating (`canSubmitJob` /
`getSubscriptionState`); notifications (`notifyPaymentEvent`); referral accrual;
reconcile cron. The order uuid is stored in the existing
`User.tributeSubscriptionId` field, so the reconcile Tribute branch (date-expiry
past grace) keeps working untouched.

Note on `DUNNING`: `canSubmitJob` gates on `getSubscriptionState().live`, and
**DUNNING is a live phase** (`usage.service.ts` - "ACTIVE/DUNNING entries are
never read (guarded by state.live)"). Setting `DUNNING` on a failed charge does
**not** revoke access; the user keeps working until `currentPeriodEnd + grace`.

## Data flow

### Subscribe

1. User taps `sub:STARTER:MONTHLY`.
2. Acquire a short per-user callback lock (debounce). If a **fresh** `PENDING`
   `TributeOrder` for the same `user + plan + cycle` exists (created within
   ~15 min), reuse it and re-show its Pay button instead of creating a new order.
3. Otherwise generate `checkoutIntentId`, call
   `createShopOrder({ ..., checkoutIntentId })`.
4. On success, insert `TributeOrder(orderUuid, userId, plan, cycle, amount,
   currency, status=PENDING)`. **Only after a successful insert** edit the
   message to a single "Pay" button linking to `webappPaymentUrl` (a `url`
   inline button - Tribute returns a `t.me/tribute/app?startapp=...` direct
   link).
5. If Tribute returned a `uuid` but the local insert failed: best-effort
   `cancelShopOrder(uuid)` + a critical log with `checkoutIntentId`; show a
   retryable error. Never blind-retry `POST /shop/orders` inside the same
   callback (no idempotency key exists in the API, so a retry could mint a second
   recurring order).
6. On Shop API failure (no `uuid`): show a retryable error; no local row.
7. User pays by card inside the Tribute mini-app.

### Webhook events -> state

**Mapping is by `orderUuid` only** (`payload.uuid -> TributeOrder.orderUuid`).
`customerId` is not present in webhook payloads, so there is no fallback. An
unknown `orderUuid` is a processing failure (row `FAILED` in
`TributeWebhookEvent`, route 5xx so Tribute retries) - never an activation.

**Stale-order guard:** cancel / charge-failed / refund events mutate `User`
access **only** when `order.orderUuid === user.tributeSubscriptionId`. For a
superseded order they are audit-only (no `User` change). This mirrors the
existing channel-model `stale_cancellation` guard.

| Event (canonical) | User effect | Order status | Side effects |
|---|---|---|---|
| `shopOrder` / `shopOrderPaymentReceived` | ACTIVE, `currentPeriodEnd = memberExpiresAt`, `tributeSubscriptionId = uuid`, clear dunning/grace | PAID | referral accrual, `subscription_activated` notify |
| `shopOrderChargeSuccess` | `currentPeriodEnd = memberExpiresAt` (assign, never increment), ACTIVE, clear dunning | PAID | referral accrual, `subscription_renewed` notify |
| `shopOrderChargeFailed` | `DUNNING` + stamp `dunningSince` on transition only; **skip if a newer charge_success already advanced `currentPeriodEnd`** (out-of-order guard). Access unchanged (DUNNING is live). | DUNNING | (optional dunning notify) |
| `shopOrderCancelled` | `CANCELED_GRACE` if `memberExpiresAt` is future else `CANCELED`; `graceEndsAt = memberExpiresAt` | CANCELLED | `subscription_canceled` notify |
| `shopOrderRefunded` | **none** (audit-only) | **unchanged** | structured warn/alert with `orderUuid`, `transactionId`, `amount`; **no** referral void |
| `shopOrderPaymentFailed` | none (never had access) | FAILED | none |

`currentPeriodEnd`/`graceEndsAt` are always **assigned** from
`payload.memberExpiresAt`, never arithmetically incremented - so a duplicate
delivery is a no-op, not a double extension.

Referral accrual (activation + renewal) uses `amount`/`currency` from the
`TributeOrder` row and `externalPaymentId = ${orderUuid}:${memberExpiresAt}` (a
stable per-period key), so it does not depend on a `transactionId` that success
webhooks may omit.

### Idempotency hash keys (`hashTributeEvent`, per event type)

Excludes `sent_at` (varies per delivery attempt); each key carries a stable
per-occurrence discriminator so two genuine events never collide:

| Event | Hash key |
|---|---|
| `shopOrder` / `shopOrderPaymentReceived` | `name + uuid + memberExpiresAt` |
| `shopOrderChargeSuccess` | `name + uuid + memberExpiresAt` |
| `shopOrderChargeFailed` | `name + uuid + created_at` |
| `shopOrderCancelled` | `name + uuid + memberExpiresAt` |
| `shopOrderRefunded` | `name + uuid + transactionId` |
| `shopOrderPaymentFailed` | `name + uuid + created_at` |

(Assumes `created_at` is stable across delivery retries while `sent_at` varies -
confirm against a real retried delivery at implementation.)

## Cutover (hard)

Deleted in this change: `resolveProductBinding`, `extractStartapp`,
`normalizeProductName`, `loadTributeProductIndexFromEnv`, `TRIBUTE_TIERS`,
`applySubscription`/`applyCancellation` (snake_case), the snake_case dispatch,
the URL `plansKeyboard`, and env vars `TRIBUTE_PRODUCT_*_ID/_NAME/_URL`.

Legacy events (`new_subscription`/`renewed_subscription`/
`cancelled_subscription`) canonicalize to tokens that are not in the new dispatch
table, so they fall to the default branch -> `ignored_event` -> **HTTP 200**
(IGNORED in the inbox). This already prevents a retry storm from delayed
deliveries; explicit legacy `case` labels are added only for a clear log line.

The single live subscriber (@Maxkornilo, Starter Weekly) is compensated with a
one-off `tsx` script that extends `currentPeriodEnd` (same pattern as the
2026-07-13 webhook-fix replay), then asked to re-subscribe through the new bot
flow. Their old channel subscription in Tribute is cancelled manually in the
dashboard.

## Open items to confirm at implementation

- **Exact Shop API webhook event-name literals and payload shape.** The wiki
  renders these from an external OpenAPI spec (`spec="shop-en"`) that could not
  be scraped verbatim; two automated fetches disagreed on casing
  (camelCase vs snake_case). Confirm the literal event strings and that
  `uuid`, `memberExpiresAt`, `transactionId`, and `created_at` are present, via
  the OpenAPI JSON or a real test webhook. The design is casing-robust
  (`canonicalTributeEventName`) and maps by the `uuid` we mint, so this does not
  block the architecture - only the final field/enum names.
- `webappPaymentUrl` button type (`url` assumed; confirm it opens the Tribute
  Mini App correctly).

### Resolved (no longer open)

- `shopId` is **optional** (defaults to the account's first shop) - no
  `TRIBUTE_SHOP_ID` needed unless multi-shop.
- The **same** `TRIBUTE_API_KEY` serves both outbound `Api-Key` auth and webhook
  HMAC.
- `comment` is accepted on create and returned on read (used for the checkout
  correlation id).

## Env changes

- **Remove:** `TRIBUTE_PRODUCT_STARTER_WEEKLY_ID/_NAME/_URL`,
  `TRIBUTE_PRODUCT_STARTER_MONTHLY_*`, `TRIBUTE_PRODUCT_PLUS_MONTHLY_*`,
  `TRIBUTE_PRODUCT_MAX_MONTHLY_*` (12 vars).
- **Keep:** `TRIBUTE_API_KEY`.
- **Add:** `TRIBUTE_API_BASE` (default `https://tribute.tg/api/v1`).

## Error handling

- **Payment failure vs processing failure are distinct.** `TributeOrder.status =
  FAILED` is set **only** on a confirmed `shopOrderPaymentFailed`. Handler/infra
  errors (Prisma, Telegram) and unknown-uuid events set
  `TributeWebhookEvent.status = FAILED` (+ `lastError`, `attempts`) and return
  5xx so Tribute retries; the `TributeOrder` row keeps its last confirmed status.
- `createShopOrder` failure (no uuid): retryable bot error; no local row.
- `uuid` returned but local insert failed: best-effort `cancelShopOrder(uuid)` +
  critical log; retryable bot error.
- Webhook signature invalid -> 401. Malformed envelope -> 400.
- Best-effort side effects (referral accrual, Telegram notify) never roll back a
  paid activation - preserved from current code.

## Testing

Rewrite `packages/shared/src/services/__tests__/tribute.service.test.ts`:

- Signature verify (reuse existing cases).
- Canonicalization of `shopOrder*` event names (both snake_case and camelCase
  inputs map to the same handler).
- Each handler: activate / renew (assign, not increment - duplicate delivery is a
  no-op) / charge-failed sets DUNNING but keeps access / cancel (grace vs hard) /
  refund is audit-only (no `User` or order-status change, no referral void) /
  initial-payment-failed.
- Mapping by `orderUuid`; unknown uuid -> processing FAILED, no activation.
- Stale-order guard: a cancel/charge_failed/refund for a superseded order is
  audit-only.
- Out-of-order guard: charge_failed after a newer charge_success does not
  downgrade access.
- Per-event-type dedup keys; retried delivery (same `uuid`+discriminator, varying
  `sent_at`) dedups.

New tests:

- `tribute-shop.service` - `createShopOrder` builds the correct body per
  plan/cycle (mock `fetch`); never includes `starsAmount`; includes the
  `comment` correlation id.
- Bot callback `sub:*` - lock/debounce; reuse of a fresh PENDING order; Pay
  button shown only after a successful insert; best-effort cancel when insert
  fails after a returned uuid.

Run in the `bot` and `web` containers per project convention (host Node cannot
run vitest).

## Rollout

1. Ship schema migration (`TributeOrder` + `TributeOrderStatus`) via
   `prisma migrate` (not `db push`).
2. In Tribute, set the `Api-Key` + webhook URL and enable recurring payments.
   Pre-flight check `GET /shop`: `recurrent == true`, `onlyStars == false`,
   `status == 1`.
3. Deploy. Compensate @Maxkornilo; cancel their old channel sub in Tribute.
4. Smoke test: create an order for each tier, pay one live (or test), verify the
   activation webhook flips the user to ACTIVE with `currentPeriodEnd =
   memberExpiresAt`.
