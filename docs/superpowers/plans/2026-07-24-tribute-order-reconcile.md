# Tribute Pending-Order Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A 10-minute reconciliation job that polls Tribute for `PENDING` orders and grants access on lost webhooks, marks failed/abandoned orders, behind a killswitch. Plus a refund dedup-key fix.

**Architecture:** New `getShopOrder` client method; extract a shared idempotent `applyPaidOrder` used by both the webhook and the reconciler; new `reconcilePendingTributeOrders` service; a `*/10 * * * *` BullMQ repeatable job in the existing referral scheduler.

**Spec:** `docs/superpowers/specs/2026-07-24-tribute-order-reconcile-design.md`

**Repo facts:**
- Shared tests: `docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/<file>`
- Shared typecheck/build: `docker compose exec -T -w /app bot npm run build -w @clipclap/shared` (runs `tsc`)
- Host Node 18 cannot run these - use the container.
- Plain hyphens only; commit identity `Trowgar <trowgar@yahoo.com>`, no trailer.
- Branch: `feat/tribute-order-reconcile`.
- Pre-existing uncommitted `apps/web/lib/auth.ts` + `apps/web/lib/telegram-provider.ts` - never touch/stage.
- Baseline: existing tribute tests are green (26 tests).

---

### Task 1: `getShopOrder` client + refund dedup fix

**Files:**
- Modify: `packages/shared/src/services/tribute-shop.service.ts`
- Modify: `packages/shared/src/services/tribute.service.ts` (one line in `hashTributeEvent`)
- Test: `packages/shared/src/services/__tests__/tribute-shop.service.test.ts`, `.../tribute.service.test.ts`

- [ ] **Step 1: Failing test for `getShopOrder`**

Add to `tribute-shop.service.test.ts` (follow the file's existing `fetch`-mock style):
```ts
describe("getShopOrder", () => {
  it("GETs /shop/orders/{uuid} with the Api-Key header and returns the parsed order", async () => {
    process.env.TRIBUTE_API_KEY = "k";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "paid", memberExpiresAt: "2026-08-01T00:00:00Z" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getShopOrder } = await import("../tribute-shop.service");
    const order = await getShopOrder("uuid-1");
    expect(order.status).toBe("paid");
    expect(order.memberExpiresAt).toBe("2026-08-01T00:00:00Z");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/shop/orders/uuid-1");
    expect((init as any).headers["Api-Key"]).toBe("k");
  });

  it("throws on a non-200 response", async () => {
    process.env.TRIBUTE_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "nope" }));
    const { getShopOrder } = await import("../tribute-shop.service");
    await expect(getShopOrder("x")).rejects.toThrow(/404/);
  });
});
```
(Match the existing test file's imports/mock helpers; if it already stubs `fetch` a particular way, reuse it.)

- [ ] **Step 2: Run, verify FAIL**

`docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/tribute-shop.service.test.ts`

- [ ] **Step 3: Implement `getShopOrder`**

In `tribute-shop.service.ts`, add:
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

- [ ] **Step 4: Failing test for the refund dedup fix**

Add to `tribute.service.test.ts`:
```ts
it("dedups refunds by created_at so distinct refunds do not collide without transactionId", () => {
  const base = { name: "shop_order_refunded", sent_at: "x", payload: { uuid: "u1" } };
  const a = hashTributeEvent({ ...base, created_at: "2026-07-01T00:00:00Z" } as any);
  const b = hashTributeEvent({ ...base, created_at: "2026-07-02T00:00:00Z" } as any);
  const aRetry = hashTributeEvent({ ...base, created_at: "2026-07-01T00:00:00Z" } as any);
  expect(a).not.toBe(b);   // distinct refunds
  expect(a).toBe(aRetry);  // same event retried
});
```
(Ensure `hashTributeEvent` is imported in the test file.)

- [ ] **Step 5: Run, verify FAIL** (both refunds currently hash equal)

`docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/tribute.service.test.ts`

- [ ] **Step 6: Apply the refund dedup fix**

In `tribute.service.ts` `hashTributeEvent`, change the refunded branch:
```ts
  if (canon === "shoporderrefunded") {
    discriminator = `tx:${p.transactionId ?? ""}:at:${envelope.created_at ?? ""}`;
```

- [ ] **Step 7: Run both test files, verify PASS**

`docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/tribute-shop.service.test.ts packages/shared/src/services/__tests__/tribute.service.test.ts`

- [ ] **Step 8: Build shared (typecheck)**

`docker compose exec -T -w /app bot npm run build -w @clipclap/shared`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/services/tribute-shop.service.ts packages/shared/src/services/tribute.service.ts packages/shared/src/services/__tests__/tribute-shop.service.test.ts packages/shared/src/services/__tests__/tribute.service.test.ts
git commit -m "feat(tribute): getShopOrder status client + created_at refund dedup"
```

---

### Task 2: Extract shared idempotent `applyPaidOrder`

**Files:**
- Modify: `packages/shared/src/services/tribute.service.ts`
- Test: `packages/shared/src/services/__tests__/tribute.service.test.ts`

- [ ] **Step 1: Idempotency test**

Add to `tribute.service.test.ts` a test that applying the same paid order twice activates once then skips. Follow the file's existing prisma-mock style (inspect how it mocks `prisma.user`/`prisma.tributeOrder` and `notifyPaymentEvent`). Assert: first call -> status `activated` and `notifyPaymentEvent` called; second call with the same `expiresAt` (now the user's `currentPeriodEnd`) -> status `stale_order` and `notifyPaymentEvent` NOT called again. Import `applyPaidOrder` from `../tribute.service`.

If the existing suite already exercises `applyOrderPayment` activation via `processTributeEvent`, keep those; only add the direct `applyPaidOrder` idempotency test here.

- [ ] **Step 2: Run, verify FAIL** (`applyPaidOrder` not exported)

`docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/tribute.service.test.ts`

- [ ] **Step 3: Extract `applyPaidOrder`**

In `tribute.service.ts`, add the exported function (verbatim from the spec):
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

- [ ] **Step 4: Rewrite `applyOrderPayment` as a thin wrapper**

Replace the body of `applyOrderPayment` (keep its signature) with:
```ts
async function applyOrderPayment(
  envelope: TributeShopWebhookEnvelope,
  isRenewal: boolean
): Promise<TributeProcessOutcome> {
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

- [ ] **Step 5: Run the full tribute suite, fix any equal-period test**

`docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/tribute.service.test.ts`
Expected: PASS. If a pre-existing test applied the exact same `expiresAt` twice and expected a second activation, update it to expect `stale_order` (the intended idempotent behavior). Do NOT weaken any other assertion.

- [ ] **Step 6: Build shared**

`docker compose exec -T -w /app bot npm run build -w @clipclap/shared` -> PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/services/tribute.service.ts packages/shared/src/services/__tests__/tribute.service.test.ts
git commit -m "refactor(tribute): extract idempotent applyPaidOrder shared by webhook + reconcile"
```

---

### Task 3: `reconcilePendingTributeOrders` service

**Files:**
- Create: `packages/shared/src/services/tribute-reconcile.service.ts`
- Modify: `packages/shared/src/services/index.ts` (barrel export)
- Test: `packages/shared/src/services/__tests__/tribute-reconcile.service.test.ts`

- [ ] **Step 1: Failing tests**

Create `tribute-reconcile.service.test.ts`. Mock `prisma` (`tributeOrder.findMany`, `tributeOrder.update`), and mock `../tribute-shop.service` `getShopOrder` and `../tribute.service` `applyPaidOrder`. Cover:
- `TRIBUTE_RECONCILE_LIVE=true`, order status `paid` with `memberExpiresAt` -> `applyPaidOrder` called with the order + parsed date + `false`; result `activated: 1`.
- status `failed` -> `tributeOrder.update` to `FAILED`; `failed: 1`.
- status `pending`, `createdAt` older than 24h -> update to `FAILED`; `expired: 1`.
- status `pending`, `createdAt` recent -> NOT updated.
- `getShopOrder` throws for one order -> that order skipped, loop continues.
- killswitch off (`TRIBUTE_RECONCILE_LIVE` unset) -> no `applyPaidOrder`/`update` calls (counts still increment), i.e. dry run.

Use a fixed `now` (`new Date("2026-07-24T12:00:00Z")`) and craft `createdAt` around it. Restore env in `afterEach`.

- [ ] **Step 2: Run, verify FAIL**

`docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/tribute-reconcile.service.test.ts`

- [ ] **Step 3: Implement the service**

Create `tribute-reconcile.service.ts` (verbatim from the spec's section 4), importing:
```ts
import type { TributeOrder } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getShopOrder, type ShopOrderView } from "./tribute-shop.service";
import { applyPaidOrder } from "./tribute.service";
```
Then the `reconcilePendingTributeOrders(now)` function exactly as specified (killswitch via `process.env.TRIBUTE_RECONCILE_LIVE === "true"`, GRACE 5 min, EXPIRE 24 h, BATCH 100, per-order try/catch, dry-run logging when not live).

- [ ] **Step 4: Barrel export**

In `packages/shared/src/services/index.ts`, next to `runRetentionSweep`, add:
```ts
export { reconcilePendingTributeOrders } from "./tribute-reconcile.service";
```
Also export `getShopOrder` and `applyPaidOrder` if the barrel is where the worker imports service functions (match how `reconcileSubscriptions`/`runRetentionSweep` are exposed to the worker; add whichever re-exports are missing so `apps/worker` can import `reconcilePendingTributeOrders`).

- [ ] **Step 5: Run tests, verify PASS**

`docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/tribute-reconcile.service.test.ts`

- [ ] **Step 6: Build shared**

`docker compose exec -T -w /app bot npm run build -w @clipclap/shared` -> PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/services/tribute-reconcile.service.ts packages/shared/src/services/index.ts packages/shared/src/services/__tests__/tribute-reconcile.service.test.ts
git commit -m "feat(tribute): reconcilePendingTributeOrders sweep (killswitch TRIBUTE_RECONCILE_LIVE)"
```

---

### Task 4: Schedule the job + wire the scheduler + verify

**Files:**
- Modify: `packages/shared/src/lib/referral-queue.ts`
- Modify: `packages/shared/src/lib/index.ts` (export the job name if siblings are)
- Modify: `apps/worker/src/referral-scheduler.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the job name + registration**

In `packages/shared/src/lib/referral-queue.ts`:
- Add `export const TRIBUTE_RECONCILE_JOB = "tribute-order-reconcile";` beside the other job-name consts.
- In `registerReferralSchedules`, add:
```ts
  await queue.add(TRIBUTE_RECONCILE_JOB, {}, { repeat: { pattern: "*/10 * * * *" }, jobId: TRIBUTE_RECONCILE_JOB });
```

- [ ] **Step 2: Export the job name**

In `packages/shared/src/lib/index.ts`, add `TRIBUTE_RECONCILE_JOB` to the re-export list where `RETENTION_SWEEP_JOB` is exported.

- [ ] **Step 3: Wire the scheduler branch**

In `apps/worker/src/referral-scheduler.ts`:
- Add `TRIBUTE_RECONCILE_JOB` and `reconcilePendingTributeOrders` to the imports from `@clipclap/shared`.
- Add a branch in the worker processor:
```ts
      if (job.name === TRIBUTE_RECONCILE_JOB) {
        const r = await reconcilePendingTributeOrders(new Date());
        console.log(
          `[tribute-reconcile] checked=${r.checked} activated=${r.activated} failed=${r.failed} expired=${r.expired}`
        );
        return;
      }
```

- [ ] **Step 4: Document the killswitch**

In `.env.example`, add near other feature flags:
```
# Tribute pending-order reconciliation: "true" enables DB writes (grant/fail/expire).
# Leave empty for dry-run (logs only). Enable after verifying a live test purchase.
TRIBUTE_RECONCILE_LIVE=
```

- [ ] **Step 5: Build shared + typecheck worker**

```bash
docker compose exec -T -w /app bot npm run build -w @clipclap/shared
docker compose exec -T -w /app/apps/worker worker-render npx tsc --noEmit
```
(If `worker-render` is not the right service name for a shell, use any worker-* service that mounts apps/worker; the goal is to typecheck `apps/worker`.)
Expected: PASS.

- [ ] **Step 6: Full shared tribute suite**

`docker compose exec -T -w /app bot npx vitest run packages/shared/src/services/__tests__/tribute.service.test.ts packages/shared/src/services/__tests__/tribute-shop.service.test.ts packages/shared/src/services/__tests__/tribute-reconcile.service.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/lib/referral-queue.ts packages/shared/src/lib/index.ts apps/worker/src/referral-scheduler.ts .env.example
git commit -m "feat(tribute): schedule 10-min pending-order reconcile job"
```

---

### Task 5: Verification (coordinator-run)

- [ ] Full shared tribute + reconcile tests green.
- [ ] `npm run build -w @clipclap/shared` clean; `apps/worker` typechecks.
- [ ] Restart the worker service that runs the referral scheduler; confirm the new
  repeatable job registers and a dry-run tick logs `[tribute-reconcile] checked=...`
  with zero writes (killswitch still off).
- [ ] Final review of the branch diff, then merge to main + push.
- [ ] Post-merge (separate, after the live test purchase): set `TRIBUTE_RECONCILE_LIVE=true`
  in prod `.env`, recreate the scheduler worker container, re-run `prisma generate`
  per-container + shared build.
