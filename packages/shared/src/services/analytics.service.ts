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
  "signed_up",
  "app_opened",
  "email_verified",
  "video_submitted",
] as const;

/** Retired steps, kept out of FUNNEL_ORDER on purpose.
 *
 *  `first_screen_new_account` counted a tap on the "New account" button of the
 *  bot's two-button onboarding prompt. That prompt was removed - it asked about
 *  our account topology before delivering anything - so the event can never be
 *  written again. Left in FUNNEL_ORDER it would draw a permanent zero at the top
 *  of the chart, which reads as a broken funnel rather than a deleted screen.
 *  The historical rows stay in the table; nothing deletes them. */
export const RETIRED_FUNNEL_EVENTS = ["first_screen_new_account"] as const;

/** Recorded, but not steps on the way to anything - so not part of the funnel,
 *  for the same reason refusals are not.
 *
 *  `earn_advertisers_tapped` measures interest in an offer that does not exist
 *  yet; it is a poll, not a stage. Putting it in FUNNEL_ORDER would draw it as a
 *  cliff between two unrelated stages and make the drop-offs on either side
 *  meaningless. Read it directly when deciding whether to build the brokerage.
 *
 *  Nothing listed here is drawn on the funnel chart. They are rendered under it
 *  by getSideActions instead, as counts with no percentage and no drop-off -
 *  which is exactly the hole the test in analytics.service.test.ts exists to
 *  catch, so a name only belongs here after someone has decided it is not a
 *  stage, and only with a label in SIDE_ACTION_LABELS. */
// video_queued is a branch off video_submitted (the submission waited for a
// slot instead of being refused), not a stage everyone passes through.
//
// first_screen_link_account was a main-path step until 2026-08-24, and both
// things that go wrong when a branch is put on the main path went wrong. It was
// step two of six because it once counted the "I already have an account"
// button of the two-button first screen, which every stranger saw; that screen
// was deleted on 2026-07-30 and the event moved to /link and the Settings
// button, where only somebody who already owns a web account has any reason to
// press it. Seven people ever have. So (a) it was permanently the "biggest
// drop" - 7 against 66 - reported in red as if a product defect were losing 89%
// of everybody, and (b) getFunnel advanced prevPeople to 7, so the step after
// it drew "Created an account 68 -> 971% of previous". A branch on the main
// path does not just misreport itself, it misreports its neighbour.
//
// The three checkout events landed on 2026-08-23 in FUNNEL_EVENTS and in
// neither list, which left them written to the table and rendered nowhere -
// and the guard test red. They are not stages either: plans_opened is not on
// the way to a video, and checkout_error is a failure on our side, the
// upload_rejected_* of the payment path. Counting them here answers the
// question they were added for (opened prices -> started a checkout -> paid)
// without inventing a cliff between "submitted a video" and "opened Plans".
export const SIDE_ACTION_EVENTS = [
  "first_screen_link_account",
  "earn_advertisers_tapped",
  "video_queued",
  "plans_opened",
  "checkout_started",
  "checkout_error",
] as const;

/** What each side action is called on /admin. Deliberately says what was
 *  RECORDED, not what was achieved: `first_screen_link_account` fires when a
 *  link code is handed over, and as of 2026-08-24 none of the seven codes the
 *  bot has issued was ever redeemed - "Linked an account" was the page
 *  asserting an outcome the event knows nothing about. */
const SIDE_ACTION_LABELS: Record<(typeof SIDE_ACTION_EVENTS)[number], string> = {
  first_screen_link_account: "Started an account link",
  earn_advertisers_tapped: "Asked about advertisers",
  video_queued: "Waited for a free slot",
  plans_opened: "Opened the plans screen",
  checkout_started: "Started a checkout",
  checkout_error: "Checkout failed on our side",
};

/** An event that is recorded but missing from FUNNEL_ORDER is invisible here -
 *  getFunnel walks this list, not the table - so adding a step to
 *  FUNNEL_EVENTS without adding it here writes data nobody will ever read. A
 *  test in analytics.service.test.ts turns that into a red test.
 *
 *  `email_verified` sits between opening the app and submitting because that is
 *  where the wall is: an unverified web account is shown the "Confirm your
 *  email" panel in place of the upload form, so it can open the dashboard and
 *  can never reach a submission. It has no rows at all on `bot` - a Telegram
 *  account is anchored by its phone-backed id - and getFunnel skips empty steps
 *  rather than drawing a hard zero.
 *
 *  It is also the one step in this list that most accounts CANNOT pass, which
 *  is not the same as failing to: 97 of prod's 105 anchors are a telegramId or
 *  a Google row and neither is ever shown the wall. It is therefore listed in
 *  SCOPED_STEPS and drawn against its own denominator instead of against the
 *  step above it. */
const FUNNEL_LABELS: Record<(typeof FUNNEL_ORDER)[number], string> = {
  start_first_screen: "Saw the welcome screen",
  signed_up: "Created an account",
  app_opened: "Opened the app",
  email_verified: "Confirmed their email",
  video_submitted: "Submitted a video",
};

/**
 * A step that only part of the population can ever reach, and the size of that
 * part.
 *
 * `people` on such a step must NOT be read against the step above it, because
 * the step above counts everybody. `email_verified` is the case this exists
 * for: on 2026-07-30 prod held 69 accounts anchored by a telegramId, 28 by
 * Google and 8 by nothing but an email, and only that last 8 are ever shown the
 * confirmation wall. Divided by `app_opened` the step reads as a 92%
 * catastrophe that is really a definition.
 */
export interface FunnelStepScope {
  /** How many accounts the step can apply to at all. */
  applicableTo: number;
  /** `people` as a percentage of `applicableTo`, null when that is 0. */
  pctOfApplicable: number | null;
  /** Rendered next to the number. Says what the denominator IS. */
  note: string;
}

export interface FunnelStep {
  event: string;
  label: string;
  people: number;
  repeats: number;
  /** % of the previous non-zero step ON THE MAIN PATH, null for the first one
   *  and null for every scoped step - see `scope`. */
  pctOfPrev: number | null;
  /** True for the step that LOST the most people relative to its predecessor.
   *  Never true for a step that gained people, and never true for a scoped one. */
  biggestDrop: boolean;
  /** Non-null when this step applies to only part of the population. */
  scope: FunnelStepScope | null;
}

/**
 * How many accounts the email wall can apply to.
 *
 * Anyone with a telegramId is anchored by a phone-backed id and is never asked
 * to confirm anything; anyone with a google row had the mailbox verified by
 * Google before the identity was issued. What is left is the population that
 * must open a confirmation link before it can submit - the exact set
 * isTrialAnchored sends to the emailVerified branch. Keep the two in step: this
 * is the denominator that makes `email_verified` mean something, and if it
 * stops matching the gate the number becomes decorative.
 *
 * Counted from `users`, while `people` on the step is counted from
 * `funnel_events`. Two sources, on purpose - there is no event for "this
 * account is walled", and synthesising one from a rendered panel would turn a
 * refusal count into a page-view count (see the note above uploadRejectedEvent).
 * The consequence is that the figure is a live headcount and the numerator is
 * historical, so a step can read over 100% if the population shrinks. Better
 * that than a denominator that is wrong by 92%.
 */
async function emailWalledAccounts(surface?: FunnelSurface): Promise<number> {
  return prisma.user.count({
    where: {
      ...surfaceWhere(surface),
      ...excludeSyntheticWhere(),
      telegramId: null,
      accounts: { none: { provider: "google" } },
    },
  });
}

/** Steps whose denominator is a population rather than the step above them. */
const SCOPED_STEPS: Partial<
  Record<
    (typeof FUNNEL_ORDER)[number],
    { note: string; applicableTo: (surface?: FunnelSurface) => Promise<number> }
  >
> = {
  email_verified: {
    note: "of the accounts that have to confirm an email - Telegram and Google accounts never see this wall",
    applicableTo: emailWalledAccounts,
  },
};

/**
 * Funnel steps for one surface (or both), in true funnel order with the
 * drop-off from each step's predecessor. Steps with no rows are skipped
 * entirely rather than shown as a hard zero.
 *
 * A SCOPED STEP IS DRAWN BUT DOES NOT LINK THE CHAIN. It carries its own
 * denominator, it is not eligible for "biggest drop", and the step after it
 * takes its percentage from the last unscoped step instead - so `video_submitted`
 * is compared to `app_opened`, which is a comparison of two numbers that count
 * the same people. Deleting the step instead would be worse: it is the only
 * measure of the email wall there is.
 */
export async function getFunnel(surface?: FunnelSurface): Promise<FunnelStep[]> {
  const grouped = await prisma.funnelEvent.groupBy({
    by: ["event"],
    where: {
      ...(surface ? { surface } : {}),
      ...(await excludeSyntheticSubjectsWhere()),
    },
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

    const scoping = SCOPED_STEPS[event];
    if (scoping) {
      const applicableTo = await scoping.applicableTo(surface);
      steps.push({
        event,
        label: FUNNEL_LABELS[event],
        people: row.people,
        repeats: row.repeats,
        pctOfPrev: null,
        biggestDrop: false,
        scope: {
          applicableTo,
          pctOfApplicable:
            applicableTo > 0
              ? Math.round((row.people / applicableTo) * 100)
              : null,
          note: scoping.note,
        },
      });
      // prevPeople is deliberately NOT advanced: the next step on the main path
      // compares against the last step that counted everybody.
      continue;
    }

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
      scope: null,
    });
    prevPeople = row.people;
  }

  // The largest LOSS between two consecutive main-path steps.
  //
  // This was Math.abs, which made a step that GAINED people eligible - and it
  // won: `signed_up` and `email_verified` only exist for accounts created after
  // 2026-07-29 while `app_opened` fires for every account there has ever been,
  // so app_opened genuinely rises, and /admin drew the rise in red under the
  // words "biggest drop". A drop is a decrease; a step that grew is reported as
  // exactly nothing.
  //
  // Scoped steps are skipped on both sides of the comparison, which is what
  // `mainPath` is for: comparing a conditional step to the one before it is the
  // same category error in a smaller font.
  const mainPath = steps.filter((step) => step.scope === null);
  let biggestDrop: FunnelStep | null = null;
  let biggestDropAmount = 0;
  for (let i = 1; i < mainPath.length; i++) {
    const drop = mainPath[i - 1].people - mainPath[i].people;
    if (drop > biggestDropAmount) {
      biggestDropAmount = drop;
      biggestDrop = mainPath[i];
    }
  }
  if (biggestDrop) biggestDrop.biggestDrop = true;

  return steps;
}

export interface SideAction {
  event: string;
  label: string;
  people: number;
  repeats: number;
}

/**
 * The events in SIDE_ACTION_EVENTS, in that order, with the empty ones dropped.
 *
 * No percentage and no drop-off flag, on purpose: none of these has a
 * denominator. Nobody has to open the plans screen on the way to anything, so
 * "11% of the step above" would be a number about the chart's own row order
 * rather than about a person - which is precisely what put a permanent red
 * "biggest drop" on a link nobody is asked to make.
 */
export async function getSideActions(
  surface?: FunnelSurface
): Promise<SideAction[]> {
  const grouped = await prisma.funnelEvent.groupBy({
    by: ["event"],
    where: {
      event: { in: [...SIDE_ACTION_EVENTS] },
      ...(surface ? { surface } : {}),
      ...(await excludeSyntheticSubjectsWhere()),
    },
    _count: { _all: true },
    _sum: { occurrences: true },
  });
  const byEvent = new Map(grouped.map((g) => [g.event, g]));

  return SIDE_ACTION_EVENTS.flatMap((event) => {
    const row = byEvent.get(event);
    if (!row || row._count._all === 0) return [];
    return [
      {
        event,
        label: SIDE_ACTION_LABELS[event],
        people: row._count._all,
        repeats: (row._sum.occurrences ?? 0) - row._count._all,
      },
    ];
  });
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
      ...(await excludeSyntheticSubjectsWhere()),
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

/**
 * A Prisma User where-clause dropping rows nobody ever signed up for - the
 * accounts a test or a proof script minted.
 *
 * Third member of the same family as surfaceWhere and excludeOwnAccountsWhere,
 * and spread beside them for the same reason: one clause per question, merged
 * on distinct keys, so a caller cannot answer one of the three and forget
 * another. All three narrow the same `users` table.
 *
 * It reads a COLUMN where excludeOwnAccountsWhere reads a list, because the two
 * populations are knowable in different ways. The owner's accounts can be
 * enumerated in .env; a proof script invents its address the moment it runs,
 * so there is nothing to put in a list until after the damage is done.
 *
 * And it is applied to the plain totals as well as the external ones, which the
 * own-account clause deliberately is not. An own account is a real account that
 * happens to be the owner's, so `users` counting it is a true statement about
 * the table. A synthetic row is not an account anybody has: a total that
 * includes two proof-script signups is not inclusive, it is wrong by two.
 *
 * `isSynthetic: false` rather than `{ not: true }` - the column is NOT NULL
 * with a default, so unlike email and telegramId there is no third state for
 * three-valued logic to swallow.
 */
export function excludeSyntheticWhere() {
  return { isSynthetic: false };
}

/**
 * The funnel_events rows that belong to synthetic users.
 *
 * `funnel_events` has no foreign key to `users` - recordFunnelEvent is handed a
 * bare subject id, deliberately, because the top of the bot funnel fires for a
 * stranger who has no row yet. The link is by convention: a `web` subject id is
 * a User.id, a `bot` one is a User.telegramId. Both namespaces are collected
 * here, so a synthetic account is dropped from the funnel whichever surface it
 * was created through.
 *
 * Excluding on READ and not in the recorder is the deliberate choice:
 *   - the recorder cannot know. It runs before any user lookup, on a stranger's
 *     first interaction, and it is documented never to throw or delay - adding
 *     a `users` read there buys a query and a failure mode on the hottest
 *     telemetry path in the product.
 *   - a reserved subject-id convention cannot reach the web surface at all: the
 *     id there is a cuid Prisma mints, which no test chooses.
 *   - an explicit parameter cannot reach it either. The one test path that
 *     lands here (tests/api.integration.test.ts) arrives over HTTP through
 *     /api/register; there is no argument to pass through a public route, and
 *     one that existed would let anyone erase themselves from the funnel.
 *   - and read-side exclusion is retroactive, which the other three are not. It
 *     covers rows already written, including rows written by a test run that
 *     predates the flag entirely.
 *
 * This is also how the rest of this file already works. Nothing here deletes a
 * row - retired events keep their history, own accounts keep their rows - the
 * reading is what decides what counts.
 */
async function syntheticSubjectIds(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { isSynthetic: true },
    select: { id: true, telegramId: true },
  });
  return rows.flatMap((u) => (u.telegramId ? [u.id, u.telegramId] : [u.id]));
}

/** funnel_events where-clause with synthetic subjects removed, empty when
 *  there are none - an empty `notIn` is a filter nobody needs. */
async function excludeSyntheticSubjectsWhere(): Promise<{
  subjectId?: { notIn: string[] };
}> {
  const ids = await syntheticSubjectIds();
  return ids.length > 0 ? { subjectId: { notIn: ids } } : {};
}

export interface Totals {
  /** Every real user, the owner's own accounts included. Synthetic rows are
   *  not "real users the owner happens to have made" and are in none of these
   *  figures - see excludeSyntheticWhere. */
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
  // Synthetic rows are excluded from BOTH, so `users` stays the population the
  // parenthetical on /admin claims it is and `users - externalUsers` still
  // equals the owner's own accounts and nothing else.
  const userWhere = { ...surfaceWhere(surface), ...excludeSyntheticWhere() };
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
  const externalWhere = {
    ...surfaceWhere(surface),
    ...excludeSyntheticWhere(),
    ...excludeOwnAccountsWhere(own),
  };

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

export interface FeedbackSummary {
  /** Rated clips by verdict. The empty-string verdict is a note or a reason
   *  arriving before any tap - reported as its own bucket rather than folded
   *  into one it does not belong to. */
  verdicts: { verdict: string; count: number }[];
  reasons: { reason: string; count: number }[];
  /** Clips that were delivered at all, for the response rate. */
  clipsDelivered: number;
  clipsRated: number;
}

export async function getFeedbackSummary(
  surface?: FunnelSurface
): Promise<FeedbackSummary> {
  const where = surface ? { surface } : {};
  const [verdicts, reasons, clipsDelivered, clipsRated] = await Promise.all([
    prisma.clipFeedback.groupBy({
      by: ["verdict"],
      where,
      _count: { _all: true },
    }),
    prisma.clipFeedback.groupBy({
      by: ["reason"],
      where: { ...where, reason: { not: null } },
      _count: { _all: true },
    }),
    prisma.clip.count(),
    prisma.clipFeedback.count({ where }),
  ]);

  return {
    verdicts: verdicts.map((v) => ({ verdict: v.verdict, count: v._count._all })),
    reasons: reasons.map((r) => ({ reason: r.reason ?? "-", count: r._count._all })),
    clipsDelivered,
    clipsRated,
  };
}

export interface FeedbackRow {
  id: string;
  clipId: string;
  jobId: string;
  surface: string;
  verdict: string;
  reason: string | null;
  note: string | null;
  evidenceKey: string | null;
  title: string | null;
  createdAt: Date;
}

/** Most recent answers, newest first. */
export async function getFeedbackRows(
  surface?: FunnelSurface,
  take = 50
): Promise<FeedbackRow[]> {
  const rows = await prisma.clipFeedback.findMany({
    where: surface ? { surface } : {},
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      clipId: true,
      jobId: true,
      surface: true,
      verdict: true,
      reason: true,
      note: true,
      evidenceKey: true,
      snapshot: true,
      createdAt: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    clipId: r.clipId,
    jobId: r.jobId,
    surface: r.surface,
    verdict: r.verdict,
    reason: r.reason,
    note: r.note,
    evidenceKey: r.evidenceKey,
    // The clip may be long gone - deleteProject hard-deletes jobs and clips
    // cascade - so the frozen snapshot is the only surviving title.
    title: (r.snapshot as { title?: string } | null)?.title ?? null,
    createdAt: r.createdAt,
  }));
}
