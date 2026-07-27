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

/**
 * Whether this user may see the admin page by email.
 *
 * The email alone is NOT sufficient: registration is open and self-service, so
 * anyone could claim an address (the unique index is case-sensitive while this
 * check is not, so even a case variant of the owner's address would pass). We
 * additionally require a federated identity - a google/telegram account row -
 * which a self-registered credentials account does not have.
 */
export async function isAdminUser(
  userId: string | undefined,
  email: string | null | undefined,
  adminEmails: string | undefined
): Promise<boolean> {
  if (!userId || !isAdminEmail(email, adminEmails)) return false;
  const federated = await prisma.account.count({
    where: { userId, provider: { in: ["google", "telegram"] } },
  });
  return federated > 0;
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
  /**
   * Distinct visitor-hashes seen in the window, NOT unique people: the salt
   * behind visitorHash rotates daily by design (see site-visit.service), so a
   * daily returner counts once per day they show up. Named visitorDays rather
   * than guests so the number is not read as a headcount.
   */
  visitorDays: number;
  pageviews: number;
  byCountry: { country: string | null; guests: number }[];
  topPaths: { path: string; hits: number }[];
  topReferrers: { referrerHost: string; guests: number }[];
}

/** Guest traffic for the last `days` days, crawlers excluded. */
export async function getTraffic(days = 30): Promise<TrafficSummary> {
  // Truncate to midnight UTC: `day` is a DATE column, so comparing it to a
  // timestamp that still carries the current time-of-day would silently drop
  // the oldest day in the window.
  const since = new Date(Date.now() - days * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const where = { isBot: false, day: { gte: since } };

  const [rows, byCountry, topPaths, topReferrers] = await Promise.all([
    prisma.siteVisit.findMany({ where, select: { visitorHash: true, hits: true } }),
    // Grouped with visitorHash and reduced below: _count._all would count
    // site_visits ROWS (one per visitor per path per day), not visitors - one
    // guest viewing 5 pages would otherwise look like 5 guests.
    prisma.siteVisit.groupBy({ by: ["country", "visitorHash"], where }),
    prisma.siteVisit.groupBy({ by: ["path"], where, _sum: { hits: true } }),
    prisma.siteVisit.groupBy({
      by: ["referrerHost", "visitorHash"],
      where: { ...where, referrerHost: { not: null } },
    }),
  ]);

  const countByKey = <T extends Record<string, unknown>>(
    grouped: T[],
    key: keyof T
  ): Map<unknown, number> => {
    const seen = new Map<unknown, Set<string>>();
    for (const g of grouped) {
      const k = g[key];
      const set = seen.get(k) ?? new Set<string>();
      set.add(g.visitorHash as string);
      seen.set(k, set);
    }
    const counts = new Map<unknown, number>();
    for (const [k, set] of seen) counts.set(k, set.size);
    return counts;
  };

  const countryCounts = countByKey(byCountry, "country");
  const referrerCounts = countByKey(topReferrers, "referrerHost");

  return {
    visitorDays: new Set(rows.map((r) => r.visitorHash)).size,
    pageviews: rows.reduce((sum, r) => sum + r.hits, 0),
    byCountry: [...countryCounts.entries()]
      .map(([country, guests]) => ({ country: country as string | null, guests }))
      .sort((a, b) => b.guests - a.guests),
    topPaths: topPaths
      .map((p) => ({ path: p.path, hits: p._sum.hits ?? 0 }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 10),
    topReferrers: [...referrerCounts.entries()]
      .map(([referrerHost, guests]) => ({ referrerHost: referrerHost as string, guests }))
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
