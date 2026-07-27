import { prisma } from "../lib/prisma";
import type { FunnelSurface } from "./funnel.service";

/** Closed by default: an unset or empty ADMIN_EMAILS admits nobody. */
export function isAdminEmail(
  email: string | null | undefined,
  adminEmails: string | undefined
): boolean {
  if (!email || !adminEmails) return false;
  const allowed = adminEmails
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

export interface FunnelRow {
  event: string;
  people: number;
  repeats: number;
}

/** People per funnel step for one surface, or both when surface is undefined. */
export async function getFunnel(surface?: FunnelSurface): Promise<FunnelRow[]> {
  const grouped = await prisma.funnelEvent.groupBy({
    by: ["event"],
    where: surface ? { surface } : undefined,
    _count: { _all: true },
    _sum: { occurrences: true },
  });
  return grouped
    .map((g) => ({
      event: g.event,
      people: g._count._all,
      repeats: (g._sum.occurrences ?? 0) - g._count._all,
    }))
    .sort((a, b) => b.people - a.people);
}

export interface TrafficSummary {
  guests: number;
  pageviews: number;
  byCountry: { country: string | null; guests: number }[];
  topPaths: { path: string; hits: number }[];
  topReferrers: { referrerHost: string; guests: number }[];
}

/** Guest traffic for the last `days` days, crawlers excluded. */
export async function getTraffic(days = 30): Promise<TrafficSummary> {
  const since = new Date(Date.now() - days * 86_400_000);
  const where = { isBot: false, day: { gte: since } };

  const [rows, byCountry, topPaths, topReferrers] = await Promise.all([
    prisma.siteVisit.findMany({ where, select: { visitorHash: true, hits: true } }),
    prisma.siteVisit.groupBy({ by: ["country"], where, _count: { _all: true } }),
    prisma.siteVisit.groupBy({ by: ["path"], where, _sum: { hits: true } }),
    prisma.siteVisit.groupBy({
      by: ["referrerHost"],
      where: { ...where, referrerHost: { not: null } },
      _count: { _all: true },
    }),
  ]);

  return {
    guests: new Set(rows.map((r) => r.visitorHash)).size,
    pageviews: rows.reduce((sum, r) => sum + r.hits, 0),
    byCountry: byCountry
      .map((c) => ({ country: c.country, guests: c._count._all }))
      .sort((a, b) => b.guests - a.guests),
    topPaths: topPaths
      .map((p) => ({ path: p.path, hits: p._sum.hits ?? 0 }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 10),
    topReferrers: topReferrers
      .map((r) => ({ referrerHost: r.referrerHost as string, guests: r._count._all }))
      .sort((a, b) => b.guests - a.guests)
      .slice(0, 10),
  };
}

export interface Totals {
  users: number;
  paying: number;
  jobs: number;
  clips: number;
}

/** Surface-scoped totals: bot = users with a telegramId, web = with an email. */
export async function getTotals(surface?: FunnelSurface): Promise<Totals> {
  const userWhere =
    surface === "bot"
      ? { telegramId: { not: null } }
      : surface === "web"
        ? { email: { not: null } }
        : {};

  const [users, paying, jobs, clips] = await Promise.all([
    prisma.user.count({ where: userWhere }),
    prisma.user.count({ where: { ...userWhere, plan: { not: "NONE" } } }),
    prisma.job.count({ where: { user: userWhere } }),
    prisma.clip.count({ where: { user: userWhere } }),
  ]);
  return { users, paying, jobs, clips };
}
