/**
 * Reports test rows still sitting in the production database.
 *
 * The analytics exclusion means a forgotten cleanup no longer inflates the
 * numbers - but it also means a forgotten cleanup is now completely silent, and
 * silence was the original problem wearing a different hat. This is the other
 * half: run it and "did I clean up?" becomes a question with an answer, instead
 * of something you find out from a chart in three weeks.
 *
 * Two kinds of debris, because there are two ways for it to exist:
 *   - FLAGGED: rows with isSynthetic set. Working as designed, invisible to
 *     analytics, and still taking up space with real R2 objects behind their
 *     clips.
 *   - UNFLAGGED: rows with a test-shaped address that nothing marked. These are
 *     the dangerous ones - they ARE in every figure on /admin. A row gets here
 *     by predating the flag, or by being created through a surface that cannot
 *     set it (tests/api.integration.test.ts registers over HTTP), or by a proof
 *     script that used prisma.user.create instead of createSyntheticUser.
 *
 * READ-ONLY. It reports, it never deletes: deciding what to delete from a
 * production database is a human's job, and a cleanup script that runs
 * unattended is the thing you write just before you delete a real account.
 *
 * Exits 1 when it finds anything, so it can be a check rather than a habit.
 *
 * Usage (inside a worker container - the worker resolves @clipclap/shared to
 * dist, so `npm run build -w @clipclap/shared` and `prisma generate` must have
 * run since the isSynthetic migration):
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/find-test-debris.ts"
 */
import { prisma, SYNTHETIC_EMAIL_DOMAINS } from "@clipclap/shared";

export interface DebrisRow {
  id: string;
  email: string | null;
  telegramId: string | null;
  createdAt: Date;
  /** Whole hours since the row was created, at the moment of the report. */
  ageHours: number;
  jobs: number;
  clips: number;
  /** funnel_events rows keyed by this user, in either subject-id namespace. */
  funnelEvents: number;
}

export interface DebrisReport {
  /** Rows marked isSynthetic: excluded from analytics, still present. */
  flagged: DebrisRow[];
  /** Rows with a test-shaped address that nothing marked - these still count
   *  towards every figure on /admin. */
  unflagged: DebrisRow[];
}

/** Total rows to answer for. The exit code and the "clean" message key off
 *  this and nothing else, so the two can never disagree. */
export function debrisCount(report: DebrisReport): number {
  return report.flagged.length + report.unflagged.length;
}

function ageHours(createdAt: Date, now: Date): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / 3_600_000);
}

/**
 * Every synthetic or test-shaped user, with what hangs off it.
 *
 * Jobs and clips are counted through _count rather than a second query per
 * user: the row count here is expected to be zero, and when it is not it is
 * expected to be small, but a per-row query would still be a loop over a table
 * whose size a forgotten test run controls.
 */
export async function collectDebris(now: Date = new Date()): Promise<DebrisReport> {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { isSynthetic: true },
        // endsWith rather than contains: `evil@notreally-test.local.com` is not
        // a fixture, and a substring match would call it one.
        ...SYNTHETIC_EMAIL_DOMAINS.map((domain) => ({
          email: { endsWith: `@${domain}` },
        })),
      ],
    },
    select: {
      id: true,
      email: true,
      telegramId: true,
      isSynthetic: true,
      createdAt: true,
      _count: { select: { jobs: true, clips: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // funnel_events has no foreign key to users - the subject id is a User.id on
  // `web` and a User.telegramId on `bot` - so the link is made here by hand,
  // in one grouped read rather than one read per user.
  const subjectIds = users.flatMap((u) =>
    u.telegramId ? [u.id, u.telegramId] : [u.id]
  );
  const eventsBySubject = new Map<string, number>();
  if (subjectIds.length > 0) {
    const grouped = await prisma.funnelEvent.groupBy({
      by: ["subjectId"],
      where: { subjectId: { in: subjectIds } },
      _count: { _all: true },
    });
    for (const g of grouped) eventsBySubject.set(g.subjectId, g._count._all);
  }

  const report: DebrisReport = { flagged: [], unflagged: [] };
  for (const u of users) {
    const row: DebrisRow = {
      id: u.id,
      email: u.email,
      telegramId: u.telegramId,
      createdAt: u.createdAt,
      ageHours: ageHours(u.createdAt, now),
      jobs: u._count.jobs,
      clips: u._count.clips,
      funnelEvents:
        (eventsBySubject.get(u.id) ?? 0) +
        (u.telegramId ? (eventsBySubject.get(u.telegramId) ?? 0) : 0),
    };
    // isSynthetic wins over the address shape: the flag is the authority, and a
    // marked row is already out of the figures whatever it is called.
    if (u.isSynthetic) report.flagged.push(row);
    else report.unflagged.push(row);
  }
  return report;
}

function describe(row: DebrisRow): string {
  const who = row.email ?? (row.telegramId ? `tg:${row.telegramId}` : row.id);
  const age =
    row.ageHours < 48
      ? `${row.ageHours}h old`
      : `${Math.floor(row.ageHours / 24)}d old`;
  return `  ${who} (${row.id}) - ${age}, ${row.jobs} job(s), ${row.clips} clip(s), ${row.funnelEvents} funnel event(s)`;
}

/** The whole report as text. Empty string when there is nothing to say, so a
 *  clean run prints one line and not a heading over a void. */
export function formatDebris(report: DebrisReport): string {
  const lines: string[] = [];
  if (report.unflagged.length > 0) {
    lines.push(
      `UNFLAGGED test-shaped accounts (${report.unflagged.length}) - THESE ARE STILL COUNTED IN /admin:`
    );
    lines.push(...report.unflagged.map(describe));
    lines.push(
      "  Mark them with markSyntheticByEmail, or delete them - but they cannot stay as they are."
    );
  }
  if (report.flagged.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `Synthetic accounts (${report.flagged.length}) - excluded from analytics, still in the database:`
    );
    lines.push(...report.flagged.map(describe));
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const report = await collectDebris();
  const total = debrisCount(report);
  if (total === 0) {
    console.log("[find-test-debris] clean - no test accounts in the database");
    return 0;
  }
  console.log(formatDebris(report));
  return 1;
}

// Run only when invoked as a script. Importing this file for its exports - the
// tests do - must not open a database connection or call process.exit.
const invokedDirectly = (process.argv[1] ?? "").includes("find-test-debris");

if (invokedDirectly) {
  // Disconnect before exiting rather than in a .finally after process.exit,
  // which never runs. The explicit exit stays because importing
  // @clipclap/shared can leave queue handles open and hang the process.
  main()
    .then(async (code) => {
      await prisma.$disconnect();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
