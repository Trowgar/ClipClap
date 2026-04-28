# Stripe Product Setup

Required for ClipClap launch v1. Create in Stripe Dashboard, test mode first.

## Subscription products

1. **ClipClap Starter**
   - Price 1: `$3.00 USD recurring weekly` → `STRIPE_STARTER_WEEKLY_PRICE_ID`
   - Price 2: `$9.00 USD recurring monthly` → `STRIPE_STARTER_MONTHLY_PRICE_ID`

2. **ClipClap Plus** — `$29.00 USD monthly` → `STRIPE_PLUS_MONTHLY_PRICE_ID`

3. **ClipClap Max** — `$89.00 USD monthly` → `STRIPE_MAX_MONTHLY_PRICE_ID`

## One-time top-up products

4. **ClipClap 100-minute top-up** — `$6.00 USD one-time` → `STRIPE_TOPUP_SMALL_PRICE_ID`

5. **ClipClap 300-minute top-up** — `$15.00 USD one-time` → `STRIPE_TOPUP_LARGE_PRICE_ID`

## Customer Portal

Settings → Billing → Customer portal:
- Enable: cancel subscription, update payment method
- Disable: plan switching (we handle upgrades through our own UI)
- Set default return URL to `https://clipclap.io/dashboard/settings`
