import { prisma } from "../lib/prisma";
import { getShopOrder, type ShopOrderView } from "./tribute-shop.service";
import { applyPaidOrder } from "./tribute.service";

// Hourly poll for PENDING Tribute orders: catches a missed/lost webhook by
// asking Tribute directly. Behind a killswitch - when off, every branch below
// still runs (so counts reflect what WOULD happen) but no write occurs.
export async function reconcilePendingTributeOrders(
  now: Date
): Promise<{ checked: number; activated: number; failed: number; expired: number }> {
  const live = process.env.TRIBUTE_RECONCILE_LIVE === "true";
  const GRACE_MS = 5 * 60_000;
  const EXPIRE_MS = 24 * 60 * 60_000;
  const BATCH = 100;

  const orders = await prisma.tributeOrder.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - GRACE_MS) } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  let activated = 0;
  let failed = 0;
  let expired = 0;

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
        console.warn("[tribute-reconcile] paid order without memberExpiresAt", {
          uuid: order.orderUuid,
        });
        continue;
      }
      if (!live) {
        console.info("[tribute-reconcile] DRY would activate", { uuid: order.orderUuid });
        activated++;
        continue;
      }
      const outcome = await applyPaidOrder(order, new Date(remote.memberExpiresAt), false);
      console.info("[tribute-reconcile] activated from poll", {
        uuid: order.orderUuid,
        outcome: outcome.status,
      });
      activated++;
    } else if (remote.status === "failed") {
      if (!live) {
        console.info("[tribute-reconcile] DRY would fail", { uuid: order.orderUuid });
        failed++;
        continue;
      }
      await prisma.tributeOrder.update({
        where: { orderUuid: order.orderUuid },
        data: { status: "FAILED" },
      });
      failed++;
    } else {
      // pending / prepaid
      if (order.createdAt < new Date(now.getTime() - EXPIRE_MS)) {
        if (!live) {
          console.info("[tribute-reconcile] DRY would expire", { uuid: order.orderUuid });
          expired++;
          continue;
        }
        await prisma.tributeOrder.update({
          where: { orderUuid: order.orderUuid },
          data: { status: "FAILED" },
        });
        expired++;
      }
    }
  }

  return { checked: orders.length, activated, failed, expired };
}
