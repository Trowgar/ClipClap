# Billing Hardening — Design

**Date:** 2026-05-30
**Status:** Approved (pending written-spec review)
**Scope:** Close four holes in subscription/billing so access state cannot silently
drift out of sync with the payment provider, and so webhook redelivery cannot cause
incorrect state transitions or duplicate side effects.

## Background

Subscription renewal charges are driven entirely by Stripe / Tribute; ClipClap only
reacts to webhooks and stores `currentPeriodEnd`. Audit of the renewal path surfaced
four holes:

1. **Access depends only on `subscriptionStatus`.** `canSubmitJob` and the upload
   presign route never compare `currentPeriodEnd` to now, and there is no reconcile
   cron. A user whose renewal webhook is missed (or a manually-seeded DB row) stays
   `ACTIVE` forever, and the usage window falls back to a rolling 30-day window — i.e.
   effectively unlimited free access.
2. **Stripe webhook has no event dedup.** Tribute dedups via `TributeWebhookEvent`;
   the Stripe route does not. A redelivered stale `invoice.payment_failed` after a
   success can re-flip `ACTIVE → DUNNING` (the guard is `dunningSince: null`, which the
   success reset to null); renewals can send duplicate notifications.
3. **`getPeriodStart` month drift.** It subtracts a fixed 7/30 days; for monthly cycles
   on 28/29/31-day months the usage window misaligns by 1-3 days vs Stripe's calendar
   month. Quota accounting only — not billing.
4. **`customer.subscription.updated` ignores `subscription.status`.** It maps only the
   price → plan/cycle/period. Stripe can change status (`past_due`, `active`) without a
   dedicated invoice/delete event, leaving local status stale.

The 30-day end-of-month case that prompted this (subscribed Apr 30, renews May 30) is
**not** buggy: the 30th exists in every month and Stripe anchors correctly. These fixes
are defense-in-depth, not a fix for that specific date.

## Decisions

- **Scope:** all four holes.
- **Hole #1 approach:** both a runtime grace buffer in the access guard **and** an
  hourly reconcile cron (Stripe is source of truth; Tribute is push-only → date-based
  fallback).
- **Grace buffer:** `SUBSCRIPTION_GRACE_BUFFER_DAYS = 3`.
- **DUNNING policy (behavior change):** DUNNING keeps access while
  `currentPeriodEnd + grace > now`, then is blocked / reconciled to `CANCELED`.
  Previously DUNNING blocked immediately. Chosen to not cut off a paying user on the
  first retry failure (Stripe Smart Retries run on days 3/7/12).

---

## Section 1 — Access defense-in-depth (grace buffer + reconcile cron)

### 1A. Unified runtime guard

Single source of truth for "may this user consume paid resources": `canSubmitJob`
([packages/shared/src/services/usage.service.ts](../../../packages/shared/src/services/usage.service.ts)).

New gate logic (replaces the current status switch):

```
NONE / status NONE                 → block ("No active subscription…")
CANCELED / CANCELED_GRACE          → block ("Subscription canceled…")
ACTIVE / DUNNING:
    if currentPeriodEnd is null
       or currentPeriodEnd + SUBSCRIPTION_GRACE_BUFFER_DAYS <= now
                                   → block ("Subscription period ended; renew…")
    else                           → fall through to quota check
quota check (existing)             → unchanged
```

`SUBSCRIPTION_GRACE_BUFFER_DAYS` lives in a new `packages/shared/src/config/billing.ts`.

**Entry-point audit (already mostly unified):**

| Entry point | Today | Action |
|---|---|---|
| `api/jobs/route.ts` | calls `canSubmitJob` | none |
| bot `handleVideo` / `handleVideoUrl` → `getSubmissionBlocker` → `canSubmitJob` | guarded | none |
| `api/uploads/route.ts` | manual status checks, no quota/date | **replace manual block with `canSubmitJob(userId, 0)`** |

For the presign route, duration is unknown at presign time, so pass `0` — the call
still enforces status, the new date buffer, and "already over quota". This is a coarse
gate: exact minute enforcement happens later at job submit (`api/jobs/route.ts`) with
the real source duration. Note a user sitting *exactly* at the limit (`remaining = 0`)
passes presign (`used + 0 > limit` is false) but is then blocked at submit once the real
duration is known — acceptable, since presign only hands out an upload URL. The
plan-specific file-size check stays separate.

`CANCELED_GRACE` is blocked here — same as today's behavior
([usage.service.ts:139-141](../../../packages/shared/src/services/usage.service.ts)), so
this is not a behavior change: a canceled-but-in-grace user can read existing clips but
cannot create new work.

**Rule recorded for the future:** every resource-consuming entry point (web upload,
job submit, URL import, bot job creation, any future premium-only action) must go
through `canSubmitJob`. Do not re-implement status/date checks inline.

### 1B. Reconcile cron

New repeatable job `subscription-reconcile` added to the existing `referral-maintenance`
BullMQ queue (hourly, alongside `hold-release`), registered in
[registerReferralSchedules](../../../packages/shared/src/lib/referral-queue.ts) and
handled in the scheduler's name switch
([apps/worker/src/referral-scheduler.ts](../../../apps/worker/src/referral-scheduler.ts)).
Logic lives in a new `packages/shared/src/services/subscription-reconcile.service.ts`
exporting `reconcileSubscriptions(now: Date)`.

Selection: users with `subscriptionStatus IN (ACTIVE, DUNNING)` and
`currentPeriodEnd < now - skew` (small skew, e.g. 5 min, to avoid racing a just-firing
renewal webhook).

- **Stripe users** (`stripeSubscriptionId` set): `stripe.subscriptions.retrieve`, then
  apply the truth — fresh `currentPeriodStart` / `currentPeriodEnd` and status map:
  - `active` / `trialing` → `ACTIVE` (clear `dunningSince`)
  - `past_due` / `unpaid` → `DUNNING` (stamp `dunningSince` only if null)
  - `canceled` / `incomplete_expired` → `CANCELED`
- **Tribute users** (`tributeSubscriptionId` set, no pull API): date-based fallback —
  if `currentPeriodEnd + grace < now` and still `ACTIVE`/`DUNNING` → `CANCELED`
  (the renewal webhook never arrived).

**Every status transition is logged with a reason**, e.g.
`[reconcile] user=<id> ACTIVE→CANCELED reason=tribute_period_expired_grace_elapsed`.

**Future edge cases (noted, not implemented now):** skip reconciliation for
admin/manual subscriptions or bonus access (e.g. a future `subscriptionSource=MANUAL`
or `accessOverrideUntil`). No such field exists today.

---

## Section 2 — Stripe webhook dedup

New Prisma model mirroring `TributeWebhookEvent`:

```prisma
model StripeWebhookEvent {
  eventId   String   @id
  type      String
  createdAt DateTime @default(now())
}
```

In `handleWebhook` ([packages/shared/src/services/billing.service.ts](../../../packages/shared/src/services/billing.service.ts)),
after `constructEvent`:

```
1. if StripeWebhookEvent(event.id) exists → return (already processed; route 200)
2. run the existing switch
3. create StripeWebhookEvent { eventId: event.id, type: event.type }
   (try/catch the unique violation → treat as duplicate)
```

Recording **after** successful processing (not before, unlike Tribute) means a handler
that throws mid-way returns non-2xx and Stripe retries the event rather than skipping it.

**Limitation (recorded in spec):** dedup protects against retries of already-processed
events. Two *concurrent* deliveries of the same event can both pass step 1 before either
reaches step 3, so business side effects that can duplicate under concurrent delivery
must remain idempotent. Referral accrual already is (unique on external payment id);
duplicate notifications under concurrent delivery are tolerated.

The route returns `200` for duplicates (not an error).

---

## Section 3 — `getPeriodStart` calendar-correct window

Add a stored period start so the window comes from the provider rather than back-math.

- New Prisma field `User.currentPeriodStart DateTime?`.
- Populate from `subscription.current_period_start` in the three Stripe write sites:
  `checkout.session.completed`, `invoice.payment_succeeded`,
  `customer.subscription.updated`. Tribute has no period-start in its payload → leaves
  it null.
- `getPeriodStart(cycle, currentPeriodStart, currentPeriodEnd)`:
  - if `currentPeriodStart` present → **return it directly**, regardless of whether
    `currentPeriodEnd` is in the past. The usage window must stay anchored to the actual
    billing period even during DUNNING/grace; access vs. grace is decided separately by
    `canSubmitJob`. (Pinning the window to the provider's period start also means it does
    not drift just because we are a few days past period end.)
  - else fallback (no stored start — e.g. Tribute, legacy rows): derive from
    `currentPeriodEnd` when present: `WEEKLY` → `end - 7 days`; `MONTHLY` →
    `end.setMonth(end.getMonth()-1)` (calendar month, not fixed 30 days).
  - if no period info at all → rolling window from now (`-7d` / `-1 month`).

Calendar-month fallback still has JS `setMonth` overflow on 31-day anchors (e.g. Mar 31
− 1 month → Mar 3), but those are exactly the cases where the stored
`currentPeriodStart` is available and used directly, so the fallback overflow is not hit
for live Stripe subscriptions.

---

## Section 4 — `customer.subscription.updated` reads status (light)

In the `customer.subscription.updated` handler, after the existing price→plan/cycle map,
also read `subscription.status` and apply:

- `active` / `trialing` → `subscriptionStatus = ACTIVE`, `dunningSince = null`
- `past_due` / `unpaid` → `subscriptionStatus = DUNNING`, stamp `dunningSince` only if null
- other statuses (`canceled`, etc.) → leave to `customer.subscription.deleted` + the
  reconcile cron (no grace logic duplicated here)

Also store `currentPeriodStart` / `currentPeriodEnd` (per Section 3).

`cancel_at_period_end` is **not** persisted: `getSubscription` already reads it live from
Stripe for the dashboard ("active until X, will not renew"), so no new field is needed.

---

## Data model changes

```prisma
model User {
  // …
  currentPeriodStart DateTime?   // new
}

model StripeWebhookEvent {        // new
  eventId   String   @id
  type      String
  createdAt DateTime @default(now())
}
```

Applied in dev via `npx prisma db push` (per project workflow — no migration files).

## Testing

- `getPeriodStart`: stored-start path; calendar-month fallback incl. end-of-month
  (Mar 30, May 30) and weekly; null-period fallback.
- `canSubmitJob`: ACTIVE within/after grace; DUNNING within grace (allowed) vs after
  grace (blocked); CANCELED/CANCELED_GRACE/NONE blocked; quota interplay.
- presign guard: user who has used all minutes → presign blocked; user exactly at limit
  → presign allowed but submit blocked.
- `reconcileSubscriptions`: Stripe status map (active/past_due/canceled); Tribute
  date-fallback → CANCELED; ACTIVE-but-not-expired left untouched; transition logging.
- Webhook dedup: duplicate event id skipped (no side effects); record-after-success;
  unique-violation race treated as duplicate; 200 on duplicate.
- `customer.subscription.updated`: status map to ACTIVE/DUNNING with `dunningSince`
  guard; period fields stored.

## Out of scope

- Tribute pull/reconcile beyond date fallback (no API).
- Persisting `cancelAtPeriodEnd` / `canceledAt` fields (UI uses live Stripe read).
- Admin/manual-override subscription source (noted as a future edge case).
- Full cancellation/grace logic inside `customer.subscription.updated`.
- Ordering protection against stale-but-distinct events: dedup keys on `event.id`, so an
  *older* event with a *different* id arriving late could still overwrite fresher state.
  The hourly reconcile cron corrects this within an hour. A future hardening could ignore
  an event whose `event.created` predates the last provider sync; out of scope for MVP.
