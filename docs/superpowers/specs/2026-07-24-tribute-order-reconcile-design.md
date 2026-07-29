# Tribute Pending-Order Reconciliation - Design

**Date:** 2026-07-24
**Status:** Approved (defaults confirmed by user)
**Author:** Trowgar

## Problem

A Tribute Shop order is created as a `PENDING` `TributeOrder` row when the user
starts checkout. Access is granted only when the `shop_order` (paid) webhook
arrives. Two gaps:

1. **Lost webhook = paid-but-no-access.** If the `shop_order` webhook is lost
   (network, downtime), the order stays `PENDING` forever and a paying customer
   never gets access. This is the real risk.
2. **Abandoned checkouts accumulate.** Tribute confirmed `shop_order_payment_failed`
   is NOT sent when a customer simply abandons the form - the order stays pending.
   These rows accrue as cruft.

Tribute's own recommendation (from support) is to supplement webhooks with
periodic order-status polling. Their Shop API exposes:
- `GET /shop/orders/{uuid}` -> full order incl. `status` (`pending` | `prepaid` |
  `paid` | `failed`), `memberExpiresAt` (recurring), `amount`, `currency`,
  `period`, `memberInTrial`, `memberTrialEndsAt`.
- `GET /shop/orders/{uuid}/status` (status only), `GET /shop/orders` (list).

## Goal

A periodic reconciliation job that pulls the truth from Tribute for `PENDING`
orders and:
- `paid` -> grant access via the SAME apply path the webhook uses (catches lost
  webhooks), idempotently.
- `failed` -> mark the order `FAILED`.
- `pending`/`prepaid` older than a cutoff -> mark `FAILED` (abandoned).

Plus a bundled one-line fix to the refund dedup key.

## Confirmed defaults

- **Cadence:** every 10 minutes (`*/10 * * * *`) - a lost-webhook paying customer
  waits <=10 min, not up to an hour.
- **Abandon cutoff:** a `PENDING` order Tribute still reports as `pending`/`prepaid`
  is marked `FAILED` after 24 hours.
- **Killswitch:** ships behind `TRIBUTE_RECONCILE_LIVE`. When not `"true"`, the job
  still polls Tribute and logs intended actions but performs NO DB writes (dry
  run). Enable after the live test purchase, mirroring the retention sweep rollout.

## Why idempotency is simple here

The reconciler only looks at `PENDING` orders created more than a short grace
(5 min) ago, so the webhook has had ample time to arrive. Two cases:
- Webhook already applied -> the user's `currentPeriodEnd` is already at/after this
  order's `memberExpiresAt`, so the apply path's freshness guard skips (no double
  grant, no double notification).
- Webhook was truly lost -> there is no competing writer; the reconciler applies
  alone.

So a `<=` freshness guard (change the existing `<` to `<=`) makes the apply path
idempotent without any locking. Referral accrual is already deduped by
`externalPaymentId`, so it never double-accrues regardless.

## Design

### 1. Tribute client: `getShopOrder` (`tribute-shop.service.ts`)

```ts
export interface ShopOrderView {
  status: "pending" | "prepaid" | "paid" | "failed";
  memberExpiresAt?: string;
  amount?: number;
  currency?: string;
  period?: string;
  memberInTrial?: boolean;
  memberTrialEndsAt?: string;
}

export async function getShopOrder(uuid: string): Promise<ShopOrderView> {
  const { apiKey, base } = requireConfig();
  const res = await fetch(`${base}/shop/orders/${uuid}`, {
    headers: { "Api-Key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tribute get order failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as ShopOrderView;
}
```

### 2. Extract a shared, idempotent apply path (`tribute.service.ts`)

Extract the grant logic from `applyOrderPayment` into an exported
`applyPaidOrder(order, expiresAt, isRenewal)` that both the webhook handler and the
reconciler call. The only behavioral change is the freshness guard `<` -> `<=`
(idempotent re-apply).

```ts
export async function applyPaidOrder(
  order: TributeOrder,
  expiresAt: Date,
  isRenewal: boolean
): Promise<TributeProcessOutcome> {
  const user = await prisma.user.findUnique({
    where: { id: order.userId },
    select: { id: true, currentPeriodEnd: true },
  });
  if (!user) return { status: "unknown_order", orderUuid: order.orderUuid };
  // Assign (never increment); an equal-or-older period means already applied.
  if (user.currentPeriodEnd && expiresAt <= user.currentPeriodEnd) {
    return { status: "stale_order", orderUuid: order.orderUuid };
  }
  await prisma.user.update({
    where: { id: order.userId },
    data: {
      plan: order.plan,
      billingCycle: order.billingCycle,
      currentPeriodEnd: expiresAt,
      subscriptionStatus: "ACTIVE",
      tributeSubscriptionId: order.orderUuid,
      dunningSince: null,
      graceEndsAt: null,
    },
  });
  if (order.status !== "PAID") {
    await prisma.tributeOrder.update({
      where: { orderUuid: order.orderUuid },
      data: { status: "PAID" },
    });
  }
  await accrueReferral(order, expiresAt);
  try {
    await notifyPaymentEvent(order.userId, {
      kind: isRenewal ? "subscription_renewed" : "subscription_activated",
      plan: order.plan,
      periodEnd: expiresAt,
    });
  } catch (err) {
    console.warn(
      "[tribute] notification failed (activation stands):",
      err instanceof Error ? err.message : err
    );
  }
  return {
    status: isRenewal ? "renewed" : "activated",
    userId: order.userId,
    plan: order.plan,
  };
}
```

`applyOrderPayment` (webhook) becomes a thin wrapper:
```ts
async function applyOrderPayment(envelope, isRenewal) {
  const p = envelope.payload;
  const orderUuid = String(p.uuid ?? "");
  const order = await prisma.tributeOrder.findUnique({ where: { orderUuid } });
  if (!order) return { status: "unknown_order", orderUuid };
  if (!p.memberExpiresAt) {
    throw new Error(`payment event for ${orderUuid} missing memberExpiresAt`);
  }
  return applyPaidOrder(order, new Date(p.memberExpiresAt), isRenewal);
}
```

Existing webhook behavior is unchanged except the `<=` guard; any test that
asserted an equal-period re-apply still activates must be updated to expect
`stale_order` (idempotent skip).

### 3. Refund dedup fix (`tribute.service.ts`, `hashTributeEvent`)

`shop_order_refunded` currently keys on `transactionId`, which Tribute does not
guarantee in the order webhook payload. Add `created_at` so two distinct refunds
never collide while retries of the same event still dedup:
```ts
if (canon === "shoporderrefunded") {
  discriminator = `tx:${p.transactionId ?? ""}:at:${envelope.created_at ?? ""}`;
}
```

### 4. Reconcile service (`packages/shared/src/services/tribute-reconcile.service.ts`)

```ts
export async function reconcilePendingTributeOrders(
  now: Date
): Promise<{ checked: number; activated: number; failed: number; expired: number }> {
  const live = process.env.TRIBUTE_RECONCILE_LIVE === "true";
  const GRACE_MS = 5 * 60_000;      // let the webhook arrive first
  const EXPIRE_MS = 24 * 60 * 60_000; // abandoned cutoff
  const BATCH = 100;

  const orders = await prisma.tributeOrder.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - GRACE_MS) } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  let activated = 0, failed = 0, expired = 0;
  for (const order of orders) {
    let remote: ShopOrderView;
    try {
      remote = await getShopOrder(order.orderUuid);
    } catch (err) {
      console.error("[tribute-reconcile] status fetch failed", { uuid: order.orderUuid, err });
      continue;
    }

    if (remote.status === "paid") {
      if (!remote.memberExpiresAt) {
        console.warn("[tribute-reconcile] paid order without memberExpiresAt", { uuid: order.orderUuid });
        continue;
      }
      if (!live) { console.info("[tribute-reconcile] DRY would activate", { uuid: order.orderUuid }); activated++; continue; }
      const outcome = await applyPaidOrder(order, new Date(remote.memberExpiresAt), false);
      console.info("[tribute-reconcile] activated from poll", { uuid: order.orderUuid, outcome: outcome.status });
      activated++;
    } else if (remote.status === "failed") {
      if (!live) { console.info("[tribute-reconcile] DRY would fail", { uuid: order.orderUuid }); failed++; continue; }
      await prisma.tributeOrder.update({ where: { orderUuid: order.orderUuid }, data: { status: "FAILED" } });
      failed++;
    } else {
      // pending / prepaid
      if (order.createdAt < new Date(now.getTime() - EXPIRE_MS)) {
        if (!live) { console.info("[tribute-reconcile] DRY would expire", { uuid: order.orderUuid }); expired++; continue; }
        await prisma.tributeOrder.update({ where: { orderUuid: order.orderUuid }, data: { status: "FAILED" } });
        expired++;
      }
    }
  }
  return { checked: orders.length, activated, failed, expired };
}
```

`applyPaidOrder`, `accrueReferral` (already), and `getShopOrder` are imported from
their services. `ShopOrderView` from `tribute-shop.service`.

### 5. Scheduling (`lib/referral-queue.ts` + `apps/worker/src/referral-scheduler.ts`)

- `lib/referral-queue.ts`: add `export const TRIBUTE_RECONCILE_JOB = "tribute-order-reconcile";`
  and register in the repeatable-jobs function:
  `await queue.add(TRIBUTE_RECONCILE_JOB, {}, { repeat: { pattern: "*/10 * * * *" }, jobId: TRIBUTE_RECONCILE_JOB });`
- Export `TRIBUTE_RECONCILE_JOB` and `reconcilePendingTributeOrders` from
  `lib/index.ts` / `services` barrel as the siblings are exported.
- `referral-scheduler.ts`: add a branch
  `if (job.name === TRIBUTE_RECONCILE_JOB) { const r = await reconcilePendingTributeOrders(new Date()); console.log("[tribute-reconcile]", r); return; }`.

## Non-goals

- No change to `reconcileSubscriptions` (active-sub state reconcile - complementary).
- No polling of non-`PENDING` orders.
- No new UI. No trial handling (we do not offer trials; a paid recurring order
  always carries `memberExpiresAt`).

## Error handling

- A failed `getShopOrder` for one order logs and continues (never fails the batch).
- `applyPaidOrder` notification failure is caught (access still granted), as today.
- Killswitch off -> reads + logs, zero writes.

## Testing (in the `bot`/`shared` container - vitest)

- `getShopOrder` issues `GET /shop/orders/{uuid}` with the `Api-Key` header and
  parses the status; throws on non-200 (mock `fetch`).
- `applyPaidOrder`: activates a PENDING order (sets ACTIVE + period + PAID +
  notifies); a second call with the same `expiresAt` returns `stale_order` and does
  NOT re-notify (idempotency); an older `expiresAt` returns `stale_order`.
- Webhook regression: `applyOrderPayment` (via `dispatchTributeEvent` / existing
  tests) still activates and renews; update any equal-period test to expect the
  idempotent skip.
- `hashTributeEvent`: two `shop_order_refunded` events with different `created_at`
  (and absent `transactionId`) produce different hashes; same event retried
  (same `created_at`) produces the same hash.
- `reconcilePendingTributeOrders`: paid -> `applyPaidOrder` called (live) / logged
  (dry); failed -> order FAILED; old pending -> FAILED; young pending -> untouched;
  a `getShopOrder` throw skips that order only. Mock `getShopOrder`/`applyPaidOrder`
  + prisma.

Where these run: shared/service tests via the container vitest; the exact command
matches the repo's existing shared test runs.

## Deploy

- No schema change. `@clipclap/shared` rebuild + `referral-scheduler` picks up the
  new repeatable job on worker restart (the scheduler container that runs it).
- Add `TRIBUTE_RECONCILE_LIVE=` to `.env.example` (documented; default off).
- Enable in prod (`TRIBUTE_RECONCILE_LIVE=true`) only after the live test purchase
  verifies the happy path.
- Commit identity `Trowgar <trowgar@yahoo.com>`, no trailer; plain hyphens only.
