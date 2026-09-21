import { prisma } from "../lib/prisma";
import { excludeOwnAccountsWhere, parseOwnAccounts } from "./analytics.service";
import type { FunnelSurface } from "./funnel.service";

export async function getConversionSummary(surface?: FunnelSurface, ownAccounts?: string) {
  const since = new Date(Date.now() - 14 * 86400000);
  const users = await prisma.user.findMany({
    where: { isSynthetic: false, ...excludeOwnAccountsWhere(parseOwnAccounts(ownAccounts)) },
    select: { id: true, telegramId: true },
  });
  const identities = new Map(users.flatMap(u => [[`web:${u.id}`, u.id], ...(u.telegramId ? [[`bot:${u.telegramId}`, u.id]] : [])] as [string, string][]));
  const events = await prisma.conversionEvent.findMany({
    where: { createdAt: { gte: since }, ...(surface ? { surface } : {}) },
    select: { surface: true, subjectId: true, event: true, createdAt: true, detail: true },
    orderBy: { createdAt: "asc" },
  });
  const external = events.filter(e => identities.has(`${e.surface}:${e.subjectId}`));
  const names = ["upload_blocked", "offer_shown", "offer_clicked", "plans_viewed", "checkout_clicked", "checkout_started", "checkout_error", "payment_succeeded", "paid_job_succeeded", "paid_job_empty", "file_fallback_clicked"];
  const rows = names.map(event => {
    const rows = external.filter(e => e.event === event);
    return { event, actions: rows.length, users: new Set(rows.map(e => identities.get(`${e.surface}:${e.subjectId}`))).size };
  });
  const steps = ["offer_shown", "offer_clicked", "checkout_started", "payment_succeeded", "paid_job_succeeded"];
  const reached = new Map<string, number>();
  const cohort = steps.map(event => ({ event, users: 0 }));
  for (const action of external) {
    const userId = identities.get(`${action.surface}:${action.subjectId}`)!;
    const next = reached.get(userId) ?? 0;
    if (action.event !== steps[next]) continue;
    reached.set(userId, next + 1);
    cohort[next].users++;
  }
  const checkoutIds = external.filter(e => e.event === "checkout_started").flatMap(e => {
    const detail = e.detail as Record<string, unknown> | null;
    const id = detail?.sessionId ?? detail?.orderUuid;
    return typeof id === "string" ? [`${detail?.provider}:${id}`] : [];
  });
  return { rows, cohort, checkoutSessions: new Set(checkoutIds).size };
}
