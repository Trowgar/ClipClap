# Tribute Webhook Fix + Subscriber Compensation - Design

**Date:** 2026-07-13
**Status:** Revised per design review - pending re-approval
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

### Production audit (completed)

Before compensating anyone, all stored Tribute events were audited:

```
SELECT count(*), count(DISTINCT payload->'payload'->>'telegram_user_id') FROM tribute_webhook_events;
-- total_events = 1, users = 1
SELECT payload->>'name', count(*) FROM tribute_webhook_events GROUP BY 1;
-- new_subscription = 1
```

**Result: exactly one affected subscription event and one affected user
(@Maxkornilo). No renewals, no cancellations, no hidden victims.** The existing
Tribute reconcile path only scans users already in `ACTIVE`/`DUNNING`
([subscription-reconcile.service.ts:37](../../../packages/shared/src/services/subscription-reconcile.service.ts)),
so a user stuck at `NONE` would never auto-recover - manual compensation is
required and sufficient for this single user.

If a future re-run of the audit finds additional events, they must be
reconstructed chronologically (stale/out-of-order guards below) before any
replay; this incident covers the one known event.

### Bug 1 - event name case mismatch

Tribute sends event names in **snake_case** (`new_subscription`,
`renewed_subscription`, `cancelled_subscription`; Tribute also re-delivers
failed webhooks at 5min/15min/30min/1h/10h). The switch in `processTributeEvent`
([tribute.service.ts:107](../../../packages/shared/src/services/tribute.service.ts))
matches **camelCase** (`newSubscription`, ...). Every real event falls through
to `default` -> `ignored_event`.

The existing tests use the fictional camelCase names, so they pass while testing
strings Tribute never emits.

### Bug 2 - product mapping keyed on the wrong fields

`applySubscription` resolves the plan binding via
`productMap[period_id] ?? productMap[subscription_id]`. `productMap` is keyed by
the env product IDs `{UZa, UZd, UZh, UZi}` (`TRIBUTE_PRODUCT_*_ID`). But
`period_id` (396297) and `subscription_id` (219056) are **per-subscriber /
per-period** numbers - they never equal the product IDs. So even with Bug 1
fixed, `applySubscription` returns `unmapped_subscription`.

The stable product code is carried in `web_app_link`
(`.../app?startapp=sUZa` -> `sUZa` -> strip `s` -> `UZa`). Tribute does **not
guarantee `web_app_link` on every subscription event** (their `new_subscription`
example omits it), so `subscription_name` ("Starter Weekly") is a required
fallback key, not a nice-to-have.

### Real webhook payload (reference fixture)

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

Note the nanosecond `expires_at`; JS `Date` truncates to milliseconds
(`2026-07-18T12:44:17.751Z`). Tests must assert the full millisecond timestamp,
not just the date.

## Scope

In scope:
- Fix both routing bugs (event-name normalization, correct product mapping).
- Replace time-dependent idempotency with a durable webhook **inbox
  state-machine** (retryable failures, no silent drops).
- Stale / out-of-order guards for first-time-live `applySubscription` /
  `applyCancellation`.
- PII-safe logging.
- Rewrite tests against the real payload contract.
- Compensate @Maxkornilo via a safe, idempotent replay + lost-access extension.

Out of scope (YAGNI):
- Periodic payment-reconciliation dashboard.
- Changing the referral commission math (`amount` vs `price`).
- Fixing the Tribute-side `ClipCliap News` typo.
- A background worker draining the inbox (the state-machine supports one later;
  this incident processes inline).

## Design

Core changes are in `packages/shared/src/services/tribute.service.ts`, the
Prisma schema, the web route
([apps/web/app/api/payments/tribute/webhook/route.ts](../../../apps/web/app/api/payments/tribute/webhook/route.ts)),
a one-off compensation script, and env config.

### 1. Event name normalization

```ts
function canonicalTributeEventName(name: string): string {
  // "new_subscription" | "newSubscription" | "New-Subscription" -> "newsubscription"
  return name.toLowerCase().replace(/[_\s-]/g, "");
}
```

Match on the canonical form:
- `newsubscription`, `renewedsubscription` -> subscription handler
- `cancelledsubscription`, `canceledsubscription` -> cancellation handler
- otherwise -> `IGNORED`

### 2. Correct product mapping (separate indexes, fail-safe)

Split ingress from business logic. Introduce a typed index instead of one flat
map:

```ts
interface TributeProductIndex {
  byStartappId: Map<string, TributePlanBinding>;      // "UZa" -> STARTER/WEEKLY
  byNormalizedName: Map<string, TributePlanBinding>;  // "starterweekly" -> STARTER/WEEKLY
}
```

`loadTributeProductIndexFromEnv`:
- reads `TRIBUTE_PRODUCT_*_ID` into `byStartappId` and `TRIBUTE_PRODUCT_*_NAME`
  (normalized) into `byNormalizedName`;
- **throws on collision** (two tiers normalizing to the same key) rather than
  silently overwriting;
- in `NODE_ENV=production`, **requires both `_ID` and `_NAME`** for every
  configured tier and throws at load if incomplete (defends against events that
  arrive without `web_app_link`).

Resolver returns the binding and how it was resolved (for observability):

```ts
function resolveProductBinding(payload, index):
  { binding: TributePlanBinding; resolvedBy: "startapp_exact" | "startapp_stripped" | "subscription_name" } | undefined
```

- Primary: `extractStartapp(payload.web_app_link)` -> try exact, then, if it
  begins with `s`, the stripped form. `s`-aliases are computed in the resolver,
  not pre-seeded into the map.
- Fallback: `normalizeProductName(payload.subscription_name)`.
- A successful `subscription_name` fallback is logged at info level (signals the
  deep-link format/ID changed).

Helpers must be defensive:

```ts
function extractStartapp(webAppLink?: string): string | undefined {
  if (!webAppLink?.trim()) return undefined;
  try { return new URL(webAppLink).searchParams.get("startapp")?.trim() || undefined; }
  catch { return undefined; }          // malformed URL -> fall through to name, never 500
}

function normalizeProductName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
```

The old `period_id` / `subscription_id` lookup is removed entirely.

### 3. Webhook inbox state-machine

Replace the "insert-then-hope" dedup with a durable inbox. The `eventHash`
column remains the unique de-dup key, but its **hash inputs change** (below) and
processing status is now tracked explicitly instead of being implied by row
existence.

Prisma:

```prisma
enum TributeWebhookStatus {
  RECEIVED
  PROCESSING
  APPLIED
  IGNORED
  FAILED
}

model TributeWebhookEvent {
  id          String               @id @default(cuid())
  eventHash   String               @unique
  name        String
  payload     Json
  status      TributeWebhookStatus @default(RECEIVED)
  outcome     String?
  attempts    Int                  @default(0)
  lastError   String?
  processedAt DateTime?
  createdAt   DateTime             @default(now())
  updatedAt   DateTime             @updatedAt

  @@index([name, createdAt])
  @@index([status])
  @@map("tribute_webhook_events")
}
```

**Stable idempotency key** (drops `sent_at`, which can differ per retry;
`created_at` is the stable event-creation time):

```ts
const eventHash = sha256([
  canonicalTributeEventName(envelope.name),
  payload.telegram_user_id,
  payload.subscription_id,
  payload.period_id,
  envelope.created_at,
].join("|"));
```

`processTributeEvent` (ingress) flow:
1. Compute `eventHash`. Upsert-insert the row as `RECEIVED` (attempts 0).
2. If the row already exists:
   - `APPLIED` / `IGNORED` -> return `duplicate` (idempotent, HTTP 200).
   - `PROCESSING` -> another delivery holds it; return `duplicate` (HTTP 200).
   - `FAILED` / `RECEIVED` -> eligible for (re)processing; continue to claim.
3. **Atomically claim**: `updateMany where eventHash AND status IN (RECEIVED,
   FAILED) SET status=PROCESSING, attempts=attempts+1`. If `count !== 1`, someone
   else claimed it -> return `duplicate`.
4. Call `dispatchTributeEvent(envelope, index)` (pure normalize + map +
   business).
5. Persist terminal status from the outcome:
   - applied / stale_event / stale_cancellation / cancelled -> `APPLIED`,
     `processedAt=now`;
   - ignored_event -> `IGNORED`;
   - unmapped_subscription or thrown exception -> `FAILED` with `lastError`.

`dispatchTributeEvent` contains normalization, `resolveProductBinding`, and the
`applySubscription` / `applyCancellation` handlers. It performs no ingress or
dedup, so the compensation script can call it directly.

### 4. Route status mapping (retryable failures)

The route maps outcomes to HTTP codes so Tribute's retry schedule works for us:
- `applied` / `duplicate` / `ignored_event` / `cancelled` / `stale_*` -> **200**.
- `unmapped_subscription` / thrown -> **5xx** (Tribute retries; the row is
  `FAILED` and reprocessable after a config fix).

### 5. Stale / out-of-order guards

These handlers run for the first time in production, so ordering must be safe.
Handlers receive the full envelope (need `created_at`), not just `payload`.

`applySubscription` - never move the period backwards:

```ts
if (user.currentPeriodEnd && incomingExpiresAt < user.currentPeriodEnd) {
  return { status: "stale_event" };
}
```

`applyCancellation` - only cancel the subscription the event refers to:

```ts
if (user.tributeSubscriptionId &&
    String(user.tributeSubscriptionId) !== String(payload.subscription_id)) {
  return { status: "stale_cancellation" };   // e.g. late Starter cancel must not kill an active Plus
}
```

### 6. Side effects: activation is authoritative, notifications best-effort

`applySubscription` does three things; their failure modes are now explicit:
1. **User update** - the source of truth; committed first.
2. **Referral accrual** - already idempotent via unique
   `[source, externalPaymentId]` keyed on `period_id`; stays in its own
   try/catch (never rethrows).
3. **Telegram notification** - wrapped in try/catch and sent **after** the user
   commit. A notification failure is logged and does **not** roll back paid
   access or fail the webhook (so a retry/replay never has to redo the payment
   to fix a transient Telegram error). A durable outbox is a possible future
   improvement, not part of this incident.

### 7. PII-safe logging

Never log the full payload (it contains `email`, username). The full envelope is
already stored in `tribute_webhook_events`. On mapping failure log identifiers
only:

```ts
console.error("[tribute] product mapping failed", {
  eventHash, eventName, telegramUserId: payload.telegram_user_id,
  subscriptionId: payload.subscription_id, periodId: payload.period_id,
  channelId: payload.channel_id, subscriptionName: payload.subscription_name,
  startapp,
});
```

### 8. Env additions (no hardcoded names)

```
TRIBUTE_PRODUCT_STARTER_WEEKLY_NAME=Starter Weekly
TRIBUTE_PRODUCT_STARTER_MONTHLY_NAME=Starter Monthly
TRIBUTE_PRODUCT_PLUS_MONTHLY_NAME=Plus Monthly
TRIBUTE_PRODUCT_MAX_MONTHLY_NAME=Max Monthly
```

Documented in `.env.example`. **Deployment step:** these four vars must be added
to the production environment *before* deploying the code, or startup validation
(step 2) will fail. Product names are never hardcoded in source.

### 9. Tests

Rewrite `tribute.service.test.ts` against the real contract. Fixtures use real
snake_case names and the real payload shape. Cases:

1. Real `new_subscription` activates the plan; assert full ms `currentPeriodEnd`.
2. camelCase name still activates (normalization).
3. Mapping via `web_app_link` startapp code (exact and `s`-stripped).
4. Official `new_subscription` **without `web_app_link`** activates via
   `subscription_name` fallback.
5. Malformed `web_app_link` -> no throw, uses name fallback.
6. Empty `startapp=` -> uses fallback.
7. startapp id is case-sensitive.
8. Colliding env mappings -> load/startup throws.
9. Production config missing a `_NAME` -> startup throws.
10. Unmapped event -> `FAILED` outcome + 5xx-mappable + error log (retryable),
    not terminal duplicate.
11. Same event reprocessed after config fix -> succeeds (`FAILED` -> `APPLIED`).
12. Re-delivery of an `APPLIED` event -> `duplicate`, no second notification.
13. Concurrent processing of one `eventHash` -> side effects applied once
    (atomic claim).
14. `renewed_subscription` never shrinks `currentPeriodEnd` (`stale_event`).
15. Cancellation with a non-matching `subscription_id` -> `stale_cancellation`,
    active subscription untouched.
16. Notification failure does not roll back the activated subscription.
17. Renewal extends `currentPeriodEnd` for the matching subscription.
18. Cancellation with future `expires_at` -> `CANCELED_GRACE`; past -> `CANCELED`.

Run in-container: `docker compose exec web npx vitest run tribute`
(binaries at `/app/node_modules/.bin`, per the Prisma-migrations convention).

### 10. Compensation for @Maxkornilo (safe replay + extension)

Policy (decided): **restore access and extend to a full 7 days from the
activation instant** to make the user whole for the ~2 days of lost access.

Idempotent one-off script (`scripts/replay-tribute-event.ts`), run inside a
container (Prisma + in-network postgres), never deleting the stored event:

```
npx tsx scripts/replay-tribute-event.ts --event-hash=<hash> --dry-run
npx tsx scripts/replay-tribute-event.ts --event-hash=<hash> --apply
```

1. **Audit assertion**: confirm exactly one matching stored event; abort if not.
2. **Dry-run**: print sanitized identifiers, the current user subscription
   state, the resolved binding, and whether a newer subscription would be
   overwritten. No writes.
3. **Apply**: call `dispatchTributeEvent` directly (does not touch the inbox
   row's existence). This activates `plan=STARTER`, `billingCycle=WEEKLY`,
   `subscriptionStatus=ACTIVE`, `tributeSubscriptionId=219056`, and sends the
   `subscription_activated` Telegram notification. Referral accrual is a
   harmless no-op (`referredById` is null).
4. **Compensation override** (explicit, logged operator action, separate from
   the pure handler): set `currentPeriodEnd = <activation instant> + 7 days`
   instead of the payload's `expires_at`. This keeps the business handler pure
   (it uses `expires_at`); the extension is an auditable operator step.
5. **Mark inbox row** `APPLIED`, record `outcome`, `processedAt`.
6. **Idempotent guard**: if the user already has an equal-or-newer active
   subscription, the script makes no change and exits:
   `"Event already applied and user already has the expected subscription. No action taken."`
   It also refuses to overwrite a strictly newer subscription state.
7. If the current time is already past the original `expires_at`, the script
   still applies the 7-days-from-now extension (it must not write an already-past
   `currentPeriodEnd` as `ACTIVE`).

## Migration & deployment order

1. Add the four `TRIBUTE_PRODUCT_*_NAME` vars to the production environment.
2. Create and apply the Prisma migration (enum + inbox columns) via
   `migrate deploy` in-container (not `db push`). The single existing row
   defaults to `RECEIVED`; the replay marks it `APPLIED`.
3. Deploy the code.
4. Run the compensation script `--dry-run`, verify, then `--apply`.

## Verification

1. `docker compose exec web npx vitest run tribute` - all green.
2. In-container typecheck.
3. `migrate deploy` applies cleanly; `tribute_webhook_events` has the new
   columns.
4. Compensation dry-run shows the expected transition; `--apply` sets the
   `users` row to active Starter/Weekly with `currentPeriodEnd` = activation +
   7 days; the Telegram **send call succeeds and returns a message id** (delivery
   to the user is not asserted).
5. Re-run the script -> idempotent no-op.
6. Safe prod smoke: re-post the **identical** stored envelope to the endpoint
   and confirm `outcome.status = "duplicate"` (no side effects). No fresh-`sent_at`
   replay against production.

## Open questions

None.
