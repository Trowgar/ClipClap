# Tribute Webhook Fix + Subscriber Compensation - Design

**Date:** 2026-07-13
**Status:** Approved, pending implementation
**Author:** Trowgar

## Problem

On 2026-07-11 12:44 UTC a user (@Maxkornilo, Максим Корнилов, `telegram_user_id`
332548055) subscribed to **Starter Weekly** (€3, `subscription_id` 219056,
`period_id` 396297, expires 2026-07-18) through Tribute. The webhook arrived,
passed signature verification, and was persisted in `tribute_webhook_events`,
**but the plan was never activated**. The user's row still reads
`plan=NONE`, `subscriptionStatus=NONE`, `currentPeriodEnd=NULL`,
`tributeSubscriptionId=NULL`. No Telegram notification, no referral accrual.

This is not a one-off glitch: the entire Tribute subscription flow has never
worked in production. Two independent bugs each block activation.

### Bug 1 - event name case mismatch

Tribute sends event names in **snake_case** (`new_subscription`,
`renewed_subscription`, `cancelled_subscription`). The switch in
`processTributeEvent` ([packages/shared/src/services/tribute.service.ts:107](../../../packages/shared/src/services/tribute.service.ts))
matches **camelCase** (`newSubscription`, ...). Every real event falls through
to `default` -> `ignored_event`. The dedup row is still written, so a naive
webhook re-send would be silently swallowed.

The existing tests use the fictional camelCase names, so they pass while
testing strings Tribute never emits.

### Bug 2 - product mapping keyed on the wrong fields

`applySubscription` resolves the plan binding via:

```ts
const binding =
  (payload.period_id ? productMap[payload.period_id] : undefined) ??
  productMap[payload.subscription_id];
```

`productMap` is keyed by the env product IDs `{UZa, UZd, UZh, UZi}`
(`TRIBUTE_PRODUCT_*_ID`). But `period_id` (396297) and `subscription_id`
(219056) are **per-subscriber / per-period** numbers - they never equal the
product IDs. So even with Bug 1 fixed, `applySubscription` returns
`unmapped_subscription` and the plan is not applied.

The only payload field carrying the stable product code is `web_app_link`:

```
"web_app_link": "https://t.me/tribute/app?startapp=sUZa"
```

`sUZa` -> strip leading `s` -> `UZa` = `TRIBUTE_PRODUCT_STARTER_WEEKLY_ID`.
No other field identifies the product (`subscription_name`="Starter Weekly",
`channel_name`="ClipCliap News", `channel_id`=479363 is shared across plans).

### Real webhook payload (reference)

```json
{
  "name": "new_subscription",
  "payload": {
    "type": "regular", "price": 300, "amount": 210, "period": "weekly",
    "user_id": 55286756, "currency": "eur", "period_id": 396297,
    "channel_id": 479363, "expires_at": "2026-07-18T12:44:17.751630949Z",
    "trb_user_id": "T-55286756", "channel_name": "ClipCliap News",
    "web_app_link": "https://t.me/tribute/app?startapp=sUZa",
    "subscription_id": 219056, "telegram_user_id": 332548055,
    "subscription_name": "Starter Weekly", "telegram_username": "Maxkornilo"
  },
  "sent_at": "2026-07-11T12:44:17.888898822Z",
  "created_at": "2026-07-11T12:44:17.787225Z"
}
```

## Scope

In scope: fix both bugs, rewrite tests against the real payload, and replay the
stored event to compensate @Maxkornilo.

Out of scope (YAGNI):
- Periodic payment reconciliation monitoring / dashboard.
- Changing the referral commission calculation (`amount` vs `price`).
- Fixing the `ClipCliap News` typo (Tribute-side).

## Design

All changes are in `packages/shared/src/services/tribute.service.ts` and its
test, plus a one-off compensation script and env additions. The web route
([apps/web/app/api/payments/tribute/webhook/route.ts](../../../apps/web/app/api/payments/tribute/webhook/route.ts))
does not change.

### 1. Event name normalization

Add a pure helper and match on its output:

```ts
function canonicalTributeEventName(name: string): string {
  // "new_subscription" | "newSubscription" | "New-Subscription" -> "newsubscription"
  return name.toLowerCase().replace(/[_\s-]/g, "");
}
```

`processTributeEvent` switches on `canonicalTributeEventName(envelope.name)`:
- `newsubscription`, `renewedsubscription` -> `applySubscription`
- `cancelledsubscription`, `canceledsubscription` -> `applyCancellation`
- otherwise -> `ignored_event`

Accepts both the real snake_case events and the legacy camelCase strings;
tolerant to hyphens/spaces and the one/two-`l` "cancel(l)ed" spelling.

### 2. Correct product mapping (stable key + fallback)

Replace the `period_id`/`subscription_id` lookup with:

```ts
function resolveProductBinding(
  payload: TributeSubscriptionPayload,
  productMap: TributeProductMap
): TributePlanBinding | undefined {
  // Primary: startapp code from web_app_link.
  //   ".../app?startapp=sUZa" -> "sUZa"; also try stripped "UZa".
  // Fallback: normalized subscription_name -> "starterweekly".
}
```

`loadTributeProductMapFromEnv` registers each product under **multiple keys** so
the lookup is tolerant:
- the raw ID (`UZa`) and the `s`-prefixed form (`sUZa`),
- the normalized product name (e.g. `starterweekly`) taken from a new optional
  env var per tier.

The `startapp` value is parsed from `web_app_link` (URL query param `startapp`),
matched against the map trying both the raw and `s`-stripped forms. If that
misses, the normalized `subscription_name` is tried. The old
`period_id`/`subscription_id` lookup is removed entirely.

### 3. Env additions (no hardcoded product names)

Add optional per-tier name vars mirroring the existing `_ID` vars:

```
TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME=Starter Weekly
TRIBUTE_PRODUCT_STARTER_MONTHLY_NAME=Starter Monthly
TRIBUTE_PRODUCT_PLUS_MONTHLY_NAME=Plus Monthly
TRIBUTE_PRODUCT_MAX_MONTHLY_NAME=Max Monthly
```

Document them in `.env.example`. They are optional: if unset, only the
`web_app_link` code path is active for that tier. Product names are never
hardcoded in source.

### 4. Fail loudly, never drop a payment silently

- When `resolveProductBinding` returns `undefined`, log at **error** level with
  the full payload (currently the handler only returns a status). This surfaces
  in `docker compose logs web`.
- The event is already persisted in `tribute_webhook_events` before mapping, so
  any mapping miss remains replayable after a config fix. No change needed;
  called out here as a relied-upon property.

### 5. Tests

Rewrite `packages/shared/src/services/__tests__/tribute.service.test.ts`:
- Fixtures use the **real** snake_case event names and real payload shape
  (including `web_app_link` and `subscription_name`).
- New cases:
  - (a) camelCase name still activates the plan (normalization).
  - (b) mapping resolves via `web_app_link` startapp code.
  - (c) mapping falls back to `subscription_name`.
  - (d) total miss -> `unmapped_subscription` and an error log.
- Existing dedup, renewal, and cancellation cases retained, updated to real
  names/payload.

Run inside the container: `docker compose exec web npx vitest run tribute`
(binaries at `/app/node_modules/.bin`, per the Prisma-migrations convention).

### 6. Compensation for @Maxkornilo (replay)

One-off script, executed **inside a container** (Prisma + in-network postgres):

1. Load the stored envelope from `tribute_webhook_events`
   (`new_subscription`, telegram 332548055).
2. Delete its dedup row by `eventHash`.
3. Call the fixed `processTributeEvent(envelope, productMap)`.
4. Expected result: `plan=STARTER`, `billingCycle=WEEKLY`,
   `subscriptionStatus=ACTIVE`, `currentPeriodEnd=2026-07-18`,
   `tributeSubscriptionId=219056`; a `subscription_activated` Telegram
   notification is sent; referral accrual is a harmless no-op (user has no
   referrer, `referredById` is null).
5. Verify the `users` row before/after.

## Verification

1. `docker compose exec web npx vitest run tribute` - all green.
2. Typecheck in-container.
3. Run the compensation script; confirm the `users` row transitions to the
   expected active Starter/Weekly state and the Telegram message is delivered.
4. Optional smoke: re-post a copy of the stored webhook (with a fresh
   `sent_at`) to the endpoint and confirm `outcome.status = "applied"`.

## Open questions

None. Fallback product names resolved via optional `TRIBUTE_PRODUCT_*_NAME`
env vars (no hardcoding).
