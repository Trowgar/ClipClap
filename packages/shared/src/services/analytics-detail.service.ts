import type {
  AnalyzeEngine,
  JobStatus,
  JobStepName,
  JobStepStatus,
  Plan,
  SubscriptionStatus,
  TelegramDeliveryStatus,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isLocalToday } from "../config/analytics";
import { parseOwnAccounts } from "./analytics.service";

/** Rows per page. Chosen for a phone screen, where the Mini App lives. */
export const PAGE_SIZE = 25;

export interface Page {
  page: number;
  pageSize: number;
  skip: number;
  totalPages: number;
  /** 1-based index of the first row shown, 0 when the table is empty. */
  from: number;
  /** 1-based index of the last row shown, 0 when the table is empty. */
  to: number;
  total: number;
}

/**
 * Resolves a requested page against a row count.
 *
 * Clamps rather than rejects: `?page=99` comes from a stale bookmark or a
 * shrinking table, and the last page is a more useful answer than an empty one.
 */
export function paginate(total: number, requested: number, pageSize = PAGE_SIZE): Page {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requested) || 1), totalPages);
  const skip = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    skip,
    totalPages,
    from: total === 0 ? 0 : skip + 1,
    to: Math.min(skip + pageSize, total),
    total,
  };
}

export interface GuestPath {
  path: string;
  hits: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface GuestRow {
  day: Date;
  visitorHash: string;
  country: string | null;
  referrerHost: string | null;
  views: number;
  /**
   * Seconds between the first and last REQUEST of this visitor-day, or null
   * when there was only one. It is a floor, never a measurement: nothing
   * records how long the last page stayed open.
   */
  durationSec: number | null;
  paths: GuestPath[];
}

/**
 * Guests, one row per visitor-day, newest first.
 *
 * Not one row per person: the salt behind visitorHash rotates daily by design
 * (see site-visit.service), so "the same visitor tomorrow" is unknowable.
 */
export async function getWebGuests(
  requestedPage: number,
  pageSize = PAGE_SIZE
): Promise<{ rows: GuestRow[]; page: Page }> {
  const where = { isBot: false };

  // Every call aggregates the WHOLE history: no day bound, no cache, and
  // site_visits has no retention sweep to bound it either. Deliberate for now -
  // paging back through everything is the point - and cheap at the current
  // scale, where Postgres groups the rows and V8 sorts them in single-digit
  // milliseconds. The thing to watch is the hash aggregate spilling to disk
  // once distinct visitor-days pass roughly work_mem, which is where a
  // `day >= ...` bound or a raw DISTINCT count has to arrive.
  const groups = await prisma.siteVisit.groupBy({
    by: ["day", "visitorHash"],
    where,
    _sum: { hits: true },
    _min: { firstSeenAt: true },
    _max: { lastSeenAt: true },
  });

  groups.sort((a, b) => {
    const byDay = b.day.getTime() - a.day.getTime();
    if (byDay !== 0) return byDay;
    return (
      (b._max.lastSeenAt?.getTime() ?? 0) - (a._max.lastSeenAt?.getTime() ?? 0)
    );
  });

  const page = paginate(groups.length, requestedPage, pageSize);
  const slice = groups.slice(page.skip, page.skip + page.pageSize);
  // An empty OR array matches every row in Prisma, so never send one.
  if (slice.length === 0) return { rows: [], page };

  const visits = await prisma.siteVisit.findMany({
    where: {
      OR: slice.map((g) => ({ day: g.day, visitorHash: g.visitorHash })),
    },
    select: {
      day: true,
      visitorHash: true,
      country: true,
      referrerHost: true,
      path: true,
      hits: true,
      firstSeenAt: true,
      lastSeenAt: true,
    },
    orderBy: [{ firstSeenAt: "asc" }, { path: "asc" }],
  });

  const key = (day: Date, hash: string): string => `${day.toISOString()}|${hash}`;
  const byKey = new Map<string, typeof visits>();
  for (const v of visits) {
    const k = key(v.day, v.visitorHash);
    byKey.set(k, [...(byKey.get(k) ?? []), v]);
  }

  const rows = slice.map((g): GuestRow => {
    const own = byKey.get(key(g.day, g.visitorHash)) ?? [];
    const views = g._sum.hits ?? 0;
    const spanMs =
      (g._max.lastSeenAt?.getTime() ?? 0) - (g._min.firstSeenAt?.getTime() ?? 0);
    return {
      day: g.day,
      visitorHash: g.visitorHash,
      // A visitor-day can only have one country and one referrer in practice;
      // take the first non-null rather than inventing a merge rule.
      country: own.find((v) => v.country)?.country ?? null,
      referrerHost: own.find((v) => v.referrerHost)?.referrerHost ?? null,
      views,
      durationSec: views <= 1 ? null : Math.round(spanMs / 1000),
      paths: own.map((v) => ({
        path: v.path,
        hits: v.hits,
        firstSeenAt: v.firstSeenAt,
        lastSeenAt: v.lastSeenAt,
      })),
    };
  });

  return { rows, page };
}

export interface UserJob {
  id: string;
  createdAt: Date;
  status: JobStatus;
  source: string;
  sourceDurationSec: number | null;
  clipsGenerated: number;
  analyzeEngine: AnalyzeEngine | null;
  error: string | null;
  processingMs: number | null;
  estimatedTotalCostUsd: number | null;
  steps: { step: JobStepName; status: JobStepStatus; error: string | null; ms: number | null }[];
  delivery: { status: TelegramDeliveryStatus; error: string | null } | null;
}

export interface UserEvent {
  event: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface UserDetail {
  jobs: UserJob[];
  events: UserEvent[];
}

/**
 * Everything held about the users on one page, keyed by user id.
 *
 * Fetched for the page rather than per row so the accordion needs no client
 * JS: the whole table, expanded content included, is one server render.
 */
export async function getBotUserDetails(
  users: { id: string; telegramId: string | null }[]
): Promise<Record<string, UserDetail>> {
  if (users.length === 0) return {};

  const userIds = users.map((u) => u.id);
  const telegramIds = users
    .map((u) => u.telegramId)
    .filter((id): id is string => id !== null);

  const [jobs, events] = await Promise.all([
    prisma.job.findMany({
      where: { userId: { in: userIds } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        userId: true,
        createdAt: true,
        status: true,
        sourceUrl: true,
        originalFilename: true,
        sourceDurationSec: true,
        clipsGenerated: true,
        analyzeEngine: true,
        error: true,
        processingMs: true,
        estimatedTotalCostUsd: true,
        steps: {
          // Pipeline order. Steps are upserted as each stage runs, so createdAt
          // ascending is DOWNLOAD through FINALIZE. Without this Postgres is
          // free to return them in any order and the accordion would read as
          // though the pipeline ran backwards.
          orderBy: { createdAt: "asc" },
          select: {
            step: true,
            status: true,
            error: true,
            startedAt: true,
            finishedAt: true,
          },
        },
        telegramDelivery: { select: { status: true, error: true } },
      },
    }),
    // Empty `in` lists match nothing in Prisma, which is the right answer here,
    // but skip the round trip when there is nothing to ask about.
    telegramIds.length === 0
      ? Promise.resolve([])
      : prisma.funnelEvent.findMany({
          where: { surface: "bot", subjectId: { in: telegramIds } },
          orderBy: { firstSeenAt: "asc" },
          select: {
            subjectId: true,
            event: true,
            occurrences: true,
            firstSeenAt: true,
            lastSeenAt: true,
          },
        }),
  ]);

  const byTelegramId = new Map(
    users.filter((u) => u.telegramId).map((u) => [u.telegramId as string, u.id])
  );

  const details: Record<string, UserDetail> = {};
  for (const u of users) details[u.id] = { jobs: [], events: [] };

  for (const j of jobs) {
    details[j.userId]?.jobs.push({
      id: j.id,
      createdAt: j.createdAt,
      status: j.status,
      source: j.sourceUrl ?? j.originalFilename ?? "-",
      sourceDurationSec: j.sourceDurationSec,
      clipsGenerated: j.clipsGenerated,
      analyzeEngine: j.analyzeEngine,
      error: j.error,
      processingMs: j.processingMs,
      estimatedTotalCostUsd: j.estimatedTotalCostUsd,
      steps: j.steps.map((s) => ({
        step: s.step,
        status: s.status,
        error: s.error,
        ms:
          s.startedAt && s.finishedAt
            ? s.finishedAt.getTime() - s.startedAt.getTime()
            : null,
      })),
      delivery: j.telegramDelivery
        ? { status: j.telegramDelivery.status, error: j.telegramDelivery.error }
        : null,
    });
  }

  for (const e of events) {
    const userId = byTelegramId.get(e.subjectId);
    if (!userId) continue;
    details[userId]?.events.push({
      event: e.event,
      occurrences: e.occurrences,
      firstSeenAt: e.firstSeenAt,
      lastSeenAt: e.lastSeenAt,
    });
  }

  return details;
}

export interface UserRow {
  id: string;
  telegramId: string | null;
  /** Display name, falling back to the telegram id when the profile has none. */
  label: string;
  locale: string | null;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  referralCode: string | null;
  /** Who referred them, by name or telegram id, null when nobody did. */
  referredBy: string | null;
  createdAt: Date;
  jobs: number;
  clips: number;
  /** Registered inside the current Riga day. */
  isToday: boolean;
  /** Listed in ANALYTICS_OWN_ACCOUNTS. Marked, never hidden - the list has to
   *  be complete to be useful, while the aggregates above it have to exclude
   *  these accounts to be honest. Different jobs. */
  isOwn: boolean;
}

/** Telegram users, newest registration first. */
export async function getBotUsers(
  requestedPage: number,
  ownAccounts: string | undefined,
  now: Date = new Date(),
  pageSize = PAGE_SIZE
): Promise<{ rows: UserRow[]; page: Page }> {
  const where = { telegramId: { not: null } };
  const total = await prisma.user.count({ where });
  const page = paginate(total, requestedPage, pageSize);

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: page.skip,
    take: page.pageSize,
    select: {
      id: true,
      telegramId: true,
      email: true,
      name: true,
      telegramLocale: true,
      plan: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      referralCode: true,
      referredBy: { select: { name: true, telegramId: true } },
      createdAt: true,
      _count: { select: { jobs: true, clips: true } },
    },
  });

  // One parser, shared with the aggregates above the table, so the two can
  // never disagree about who counts as an own account.
  const own = parseOwnAccounts(ownAccounts);

  const rows = users.map(
    (u): UserRow => ({
      id: u.id,
      telegramId: u.telegramId,
      label: u.name ?? u.telegramId ?? u.id,
      locale: u.telegramLocale,
      plan: u.plan,
      subscriptionStatus: u.subscriptionStatus,
      currentPeriodEnd: u.currentPeriodEnd,
      referralCode: u.referralCode,
      referredBy: u.referredBy
        ? (u.referredBy.name ?? u.referredBy.telegramId ?? "unknown")
        : null,
      createdAt: u.createdAt,
      jobs: u._count.jobs,
      clips: u._count.clips,
      isToday: isLocalToday(u.createdAt, now),
      isOwn:
        (u.telegramId !== null && own.telegramIds.includes(u.telegramId)) ||
        (u.email !== null && own.emails.includes(u.email.toLowerCase())),
    })
  );

  return { rows, page };
}
