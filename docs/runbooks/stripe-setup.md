# Stripe Product Setup

Live account: `acct_1U4OqdDroBbNEpEw` ("ClipClap", LV, USD prices) - bootstrapped
2026-08-17 via the API. The earlier sandbox `acct_1TRzG4KHvvEvnQqn` ("clipclap
sandbox", test mode, EUR prices) is retired; its customer/subscription ids were
nulled out of `users` because they do not resolve in the live account.

Everything below is idempotent to recreate by hand in the Dashboard, but read
the webhook section first - one Dashboard default silently breaks the handlers.

## Subscription products

1. **ClipClap Starter**
   - Price 1: `$3.00 USD recurring weekly` → `STRIPE_STARTER_WEEKLY_PRICE_ID` (lookup_key `starter_weekly`)
   - Price 2: `$9.00 USD recurring monthly` → `STRIPE_STARTER_MONTHLY_PRICE_ID` (lookup_key `starter_monthly`)

2. **ClipClap Plus** - `$29.00 USD monthly` → `STRIPE_PLUS_MONTHLY_PRICE_ID` (`plus_monthly`)

3. **ClipClap Max** - `$89.00 USD monthly` → `STRIPE_MAX_MONTHLY_PRICE_ID` (`max_monthly`)

## One-time top-up products

4. **ClipClap 100-minute top-up** - `$6.00 USD one-time` → `STRIPE_TOPUP_SMALL_PRICE_ID` (`topup_100`)

5. **ClipClap 300-minute top-up** - `$15.00 USD one-time` → `STRIPE_TOPUP_LARGE_PRICE_ID` (`topup_300`)

Every product carries `tax_code: txcd_10103000` (Software as a service - personal
use). The live account came with **Managed Payments** enabled by default (Stripe
as merchant of record: it computes and remits VAT/sales tax, at a higher fee than
plain processing), and Managed Payments refuses Checkout for a product without a
tax code - the first live checkout failed with "the product tax code is missing".
The code is harmless if Managed Payments is later switched off
(Settings → Managed payments), so keep it on new products either way.

Managed Payments also refuses Checkout on the SDK's pinned `2025-02-24.acacia`
("Managed Payments is not supported on API version..."), so both
`checkout.sessions.create` calls pass `{ apiVersion: CHECKOUT_API_VERSION }`
(`2025-03-31.basil`, exported from `billing.service.ts`) as the per-request
option. Only those two calls - the response is used for `session.url` alone.
The rest of the client and the webhook endpoint stay on acacia (see below).
The tests assert the option, and removing it makes three of them fail.

Prices are USD on purpose: the UI renders `$`, and the referral accrual in
`billing.service.ts` records `exchangeRateToUsd: 1`. Do not create EUR prices
without changing both.

## Webhook endpoint

URL: `https://clipclap.io/api/billing/webhook` → signing secret into `STRIPE_WEBHOOK_SECRET`.

Events (all seven are handled in `billing.service.ts handleWebhook`):

- `checkout.session.completed`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`

**API version must be pinned to `2025-02-24.acacia`** - the version the
installed SDK (`stripe@17.x`) pins. The handlers read `invoice.subscription` and
`subscription.current_period_start/end` straight off the event payload, and
Stripe moved both in `2025-03-31.basil` (`invoice.parent.subscription_details`,
per-item periods). An endpoint created in the Dashboard defaults to the account's
current API version (2026-xx), so payloads arrive without those fields:
`invoice.*` handlers silently no-op and `customer.subscription.updated` throws on
`new Date(NaN)`. Create the endpoint via the API with `api_version` set, or pick
the version explicitly in the Dashboard. If the SDK is ever upgraded past 17,
re-pin the endpoint to the SDK's version and re-check those field reads.

Sanity probe after deploy: `curl -X POST https://clipclap.io/api/billing/webhook
-H 'stripe-signature: t=1,v1=x' -d '{}'` must answer 400 with Stripe's "No
signatures found matching" text - that proves the route is reachable and the
secret is loaded (a "Missing stripe-signature" answer means the header was
dropped upstream; a 500 means the env is not loaded).

## Customer Portal

A default portal configuration exists in live (`bpc_1U5Q72DroBbNEpEwVazHxCz8`):
invoice history + payment-method update + cancel at period end, plan switching
disabled (we handle upgrades in our own UI), return URL
`https://clipclap.io/dashboard/settings`. Editable under Settings → Billing →
Customer portal. `billingPortal.sessions.create` needs a default configuration to
exist, so a fresh account with none configured returns 500 from
`/api/billing/portal`.

## Rolling the env

`.env` is read at container creation, not on `docker compose restart`. After
changing any `STRIPE_*` value: `docker compose up -d --no-deps web
worker-finalize` (the only two services that call Stripe - web for
checkout/webhook/portal/top-up, worker-finalize for the subscription reconcile
cron), then the usual per-container `prisma generate` and shared build.
