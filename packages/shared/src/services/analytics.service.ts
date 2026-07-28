import { prisma } from "../lib/prisma";
import { startOfLocalDay } from "../config/analytics";
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
 * Providers that PROVE the address: only Google, which verified the mailbox
 * before issuing the identity, and which @auth/core refuses to link onto an
 * existing same-email user (allowDangerousEmailAccountLinking is off).
 *
 * `telegram` deliberately does NOT count. A telegram account row says nothing
 * about the email, and any logged-in user can mint one for themselves through
 * /api/auth/telegram/link/redeem - so accepting it turned the gate back into
 * "email alone", one link away: register an unclaimed ADMIN_EMAILS address at
 * /api/register (open, self-service), link any telegram account, be admin.
 * Telegram admins do not need this path anyway - they enter through the Mini
 * App, which checks the id against REFERRAL_ADMIN_TELEGRAM_IDS.
 */
const ADMIN_PROOF_PROVIDERS = ["google"];

/**
 * Whether this user may see the admin page by email.
 *
 * The email alone is NOT sufficient: registration is open and self-service, so
 * anyone could claim an address (the unique index is case-sensitive while this
 * check is not, so even a case variant of the owner's address would pass). We
 * additionally require an identity that proves the address - see
 * ADMIN_PROOF_PROVIDERS for why that list is exactly one provider long.
 */
export async function isAdminUser(
  userId: string | undefined,
  email: string | null | undefined,
  adminEmails: string | undefined
): Promise<boolean> {
  if (!userId || !isAdminEmail(email, adminEmails)) return false;
  const federated = await prisma.account.count({
    where: { userId, provider: { in: ADMIN_PROOF_PROVIDERS } },
  });
  return federated > 0;
}

/** @deprecated kept for callers that have not moved to FunnelStep yet. */
export interface FunnelRow {
  event: string;
  people: number;
  repeats: number;
}

/** Funnel steps in the order a person actually passes them. Refusals are not
 *  steps - they are branches off `video_submitted` and are reported separately
 *  by getRefusals. */
const FUNNEL_ORDER = [
  "start_first_screen",
  "first_screen_new_account",
  "first_screen_link_account",
  "app_opened",
  "video_submitted",
] as const;

const FUNNEL_LABELS: Record<(typeof FUNNEL_ORDER)[number], string> = {
  start_first_screen: "Saw the first screen",
  first_screen_new_account: "Created an account",
  first_screen_link_account: "Linked an account",
  app_opened: "Opened the app",
  video_submitted: "Submitted a video",
};

export interface FunnelStep {
  event: string;
  label: string;
  people: number;
  repeats: number;
  /** % of the previous non-zero step, null for the first one. */
  pctOfPrev: number | null;
  /** True for the step with the largest absolute drop from its predecessor. */
  biggestDrop: boolean;
}

/**
 * Funnel steps for one surface (or both), in true funnel order with the
 * drop-off from each step's predecessor. Steps with no rows are skipped
 * entirely rather than shown as a hard zero.
 */
export async function getFunnel(surface?: FunnelSurface): Promise<FunnelStep[]> {
  const grouped = await prisma.funnelEvent.groupBy({
    by: ["event"],
    where: surface ? { surface } : undefined,
    _count: { _all: true },
    _sum: { occurrences: true },
  });
  const byEvent = new Map(
    grouped.map((g) => [
      g.event,
      { people: g._count._all, repeats: (g._sum.occurrences ?? 0) - g._count._all },
    ])
  );

  const steps: FunnelStep[] = [];
  let prevPeople: number | null = null;
  for (const event of FUNNEL_ORDER) {
    const row = byEvent.get(event);
    if (!row || row.people === 0) continue;
    const pctOfPrev =
      prevPeople === null || prevPeople === 0
        ? null
        : Math.round((row.people / prevPeople) * 100);
    steps.push({
      event,
      label: FUNNEL_LABELS[event],
      people: row.people,
      repeats: row.repeats,
      pctOfPrev,
      biggestDrop: false,
    });
    prevPeople = row.people;
  }

  // Largest absolute drop between two consecutive surviving steps.
  let biggestDropIdx = -1;
  let biggestDropAmount = 0;
  for (let i = 1; i < steps.length; i++) {
    const drop = Math.abs(steps[i - 1].people - steps[i].people);
    if (drop > biggestDropAmount) {
      biggestDropAmount = drop;
      biggestDropIdx = i;
    }
  }
  if (biggestDropIdx >= 0) steps[biggestDropIdx].biggestDrop = true;

  return steps;
}

export interface RefusalRow {
  reason: string;
  people: number;
}

/** Upload refusals by reason - branches off video_submitted, not funnel steps. */
export async function getRefusals(surface?: FunnelSurface): Promise<RefusalRow[]> {
  const grouped = await prisma.funnelEvent.groupBy({
    by: ["event"],
    where: {
      ...(surface ? { surface } : {}),
      event: { startsWith: "upload_rejected_" },
    },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({
      reason: g.event.replace(/^upload_rejected_/, ""),
      people: g._count._all,
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

  const [visitors, totals, byCountry, topPaths, topReferrers] = await Promise.all([
    // Grouped, not findMany: one row per visitor-day rather than one per
    // (visitor, path, day). The path is attacker-influenced - every extensionless
    // URL on the site is tracked, including 404s - so a row-per-path read grows
    // without a bound anyone controls.
    prisma.siteVisit.groupBy({ by: ["visitorHash"], where }),
    prisma.siteVisit.aggregate({ where, _sum: { hits: true } }),
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
    visitorDays: visitors.length,
    pageviews: totals._sum.hits ?? 0,
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

/** Splits the comma-separated own-accounts list into emails and telegram ids. */
export function parseOwnAccounts(raw: string | undefined): {
  emails: string[];
  telegramIds: string[];
} {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    emails: parts.filter((p) => p.includes("@")).map((p) => p.toLowerCase()),
    telegramIds: parts.filter((p) => !p.includes("@")),
  };
}

/** Surface scoping shared by getTotals and getPulse: bot = telegramId set, web = email set. */
function surfaceWhere(surface?: FunnelSurface) {
  return surface === "bot"
    ? { telegramId: { not: null } }
    : surface === "web"
      ? { email: { not: null } }
      : {};
}

/**
 * A Prisma User where-clause excluding the owner's own accounts, empty when
 * none are configured.
 *
 * Written as an AND of null-tolerant negations rather than the obvious
 * `NOT { OR: [{email in}, {telegramId in}] }`. Both columns are nullable, and
 * in SQL's three-valued logic a telegram-only user (email IS NULL) makes
 * `email IN (...)` evaluate to NULL, so `NULL OR FALSE` is NULL and `NOT NULL`
 * is NULL - the row fails the filter and every account without an email
 * silently disappears. Measured on the real table: the naive form returned 2
 * of 101 users instead of 98.
 */
export function excludeOwnAccountsWhere(own: {
  emails: string[];
  telegramIds: string[];
}) {
  const clauses = [];
  if (own.emails.length) {
    clauses.push({ OR: [{ email: null }, { email: { notIn: own.emails } }] });
  }
  if (own.telegramIds.length) {
    clauses.push({
      OR: [{ telegramId: null }, { telegramId: { notIn: own.telegramIds } }],
    });
  }
  return clauses.length ? { AND: clauses } : {};
}

export interface Totals {
  /** All users, including the owner's own. */
  users: number;
  /** Users excluding the owner's own accounts. */
  externalUsers: number;
  /** plan != NONE, all users. */
  paying: number;
  /** plan != NONE AND subscriptionStatus = ACTIVE AND not an own account. */
  externalPayingActive: number;
  jobs: number;
  externalJobs: number;
  clips: number;
  /** Clips owned by someone other than the owner - the honest one. */
  externalClips: number;
}

/** Surface-scoped totals: bot = users with a telegramId, web = with an email. */
export async function getTotals(
  surface?: FunnelSurface,
  ownAccounts?: string
): Promise<Totals> {
  const userWhere = surfaceWhere(surface);
  const own = parseOwnAccounts(ownAccounts);
  const externalWhere = { ...userWhere, ...excludeOwnAccountsWhere(own) };

  const [
    users,
    externalUsers,
    paying,
    externalPayingActive,
    jobs,
    externalJobs,
    clips,
    externalClips,
  ] = await Promise.all([
    prisma.user.count({ where: userWhere }),
    prisma.user.count({ where: externalWhere }),
    prisma.user.count({ where: { ...userWhere, plan: { not: "NONE" } } }),
    prisma.user.count({
      where: { ...externalWhere, plan: { not: "NONE" }, subscriptionStatus: "ACTIVE" },
    }),
    prisma.job.count({ where: { user: userWhere } }),
    prisma.job.count({ where: { user: externalWhere } }),
    prisma.clip.count({ where: { user: userWhere } }),
    prisma.clip.count({ where: { user: externalWhere } }),
  ]);
  return {
    users,
    externalUsers,
    paying,
    externalPayingActive,
    jobs,
    externalJobs,
    clips,
    externalClips,
  };
}

export interface PulseWindow {
  newUsers: number;
  jobs: number;
  clips: number;
}
export interface Pulse {
  today: PulseWindow;
  last7: PulseWindow;
  last30: PulseWindow;
}

/** New users / jobs / clips in the last 1, 7 and 30 days, EXTERNAL only. */
export async function getPulse(
  surface: FunnelSurface | undefined,
  ownAccounts: string | undefined
): Promise<Pulse> {
  const own = parseOwnAccounts(ownAccounts);
  const externalWhere = { ...surfaceWhere(surface), ...excludeOwnAccountsWhere(own) };

  // The same boundary the users table bolds by. Two definitions of "today" on
  // one page is a bug, not a rounding difference.
  const todayStart = startOfLocalDay();
  const last7Start = new Date(Date.now() - 7 * 86_400_000);
  const last30Start = new Date(Date.now() - 30 * 86_400_000);

  const windowFor = async (since: Date): Promise<PulseWindow> => {
    const [newUsers, jobs, clips] = await Promise.all([
      prisma.user.count({ where: { ...externalWhere, createdAt: { gte: since } } }),
      prisma.job.count({ where: { createdAt: { gte: since }, user: externalWhere } }),
      prisma.clip.count({ where: { createdAt: { gte: since }, user: externalWhere } }),
    ]);
    return { newUsers, jobs, clips };
  };

  const [today, last7, last30] = await Promise.all([
    windowFor(todayStart),
    windowFor(last7Start),
    windowFor(last30Start),
  ]);

  return { today, last7, last30 };
}
