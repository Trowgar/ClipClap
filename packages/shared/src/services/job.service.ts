import { Prisma as PrismaNamespace } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getStageQueue } from "../lib/queues";
import { getPlanLimits } from "../config/plans";
import type { Job, JobStatus, Prisma } from "@prisma/client";
import type { CreateJobInput } from "../types";

// Destructured rather than imported by name: `Prisma` is already taken above as
// a type-only import for the namespace's types, and the error class is a value.
const { PrismaClientKnownRequestError } = PrismaNamespace;

/**
 * A job that has not reached a terminal state yet - what "in flight" counts.
 *
 * Exported and defined once because two surfaces used to keep their own copy of
 * this list and the count they produced is now load-bearing: it is the number
 * the concurrency limit is enforced against, inside a lock. Two lists that
 * drift would mean two different definitions of the limit.
 */
export const ACTIVE_JOB_STATUSES = [
  "PENDING",
  "DOWNLOADING",
  "TRANSCRIBING",
  "ANALYZING",
  "CUTTING",
] as const satisfies readonly JobStatus[];

/**
 * The outcome of a submission.
 *
 * A refusal is a value, not an exception, because it is an ordinary answer to
 * an ordinary request - the caller has copy to show for it and, on the web, a
 * funnel event to record. It also carries the numbers the copy states, so the
 * message a user reads cannot disagree with the count that actually refused
 * them.
 *
 * `busy` is the same idea applied to the one case that used to escape as an
 * exception: the per-user lock was held by somebody else for longer than we are
 * willing to wait. That reached the web route as an uncaught P2028, which the
 * user saw as a bare 500 after twenty-three seconds and which /admin could not
 * see at all, because nothing records a funnel event for a thrown request. It
 * carries no numbers - there is nothing true to say about a queue we gave up
 * on - and the honest copy is "try again in a moment".
 */
export type CreateJobResult =
  | { status: "created"; job: Job }
  | { status: "concurrent_limit"; inFlight: number; limit: number }
  | { status: "busy" };

/**
 * How long a submission is willing to wait for this account's lock.
 *
 * The work under the lock is three statements and finishes in single-digit
 * milliseconds, so five seconds is not a budget - it is a ceiling on somebody
 * else's pathology. Two things can hold the lock that long: a submission that
 * is itself stuck, or an operator holding it by hand from psql. Both should end
 * in "try again in a moment", not in a request that hangs for twenty-three
 * seconds and then 500s.
 *
 * It is NOT the same knob as the transaction timeout, and that confusion is the
 * bug this closes. `timeout: 15_000` bounds how long the interactive
 * transaction may live, and Prisma only notices it has been exceeded when the
 * NEXT statement is issued - so a query blocked inside the lock is not
 * interrupted at 15s at all. Measured: the lock was released at 22.6s and only
 * then did Prisma raise P2028, at 22.7s. lock_timeout is enforced by Postgres
 * on the blocked statement itself, which is the only place that can see it.
 */
const LOCK_WAIT_MS = 5_000;

/** Postgres SQLSTATE for a statement cancelled by lock_timeout. */
const PG_LOCK_NOT_AVAILABLE = "55P03";

/**
 * True when this error is the lock wait above running out, or the transaction
 * dying because it did.
 *
 * Two codes, because two mechanisms can report the same event. P2010 with
 * SQLSTATE 55P03 is the ordinary path - Postgres cancelled the blocked
 * `pg_advisory_xact_lock` and Prisma passed the raw failure through. P2028 is
 * the belt: if a transaction ever manages to outlive its own timeout for any
 * reason, the request is still one that waited too long on a queue, and the
 * user is owed the same "try again" rather than a stack trace. Deliberately
 * narrow beyond that - a connection failure or a constraint violation must
 * still surface as an error, because reporting one of those as "busy" would
 * tell a user to retry something that will never work.
 */
function isLockContention(err: unknown): boolean {
  if (!(err instanceof PrismaClientKnownRequestError)) return false;
  if (err.code === "P2028") return true;
  return (
    err.code === "P2010" &&
    (err.meta as { code?: string } | undefined)?.code === PG_LOCK_NOT_AVAILABLE
  );
}

/**
 * BullMQ priority for a job running on the free allowance.
 *
 * Verified against the installed bullmq 5 rather than assumed: moveToActive-11
 * does `RPOPLPUSH(wait -> active)` FIRST and only reaches the prioritized set
 * when `wait` comes back empty, and addJob only routes a job into the
 * prioritized set when `opts.priority` is truthy. So a paid job - which passes
 * no priority at all and therefore lands in `wait` - is taken before every free
 * job that is waiting, and a paying user can never queue behind a free one.
 *
 * The exact number does not matter while this is the only priority in the
 * system; it matters that it is > 0, which is what moves the job off the wait
 * list. Left at 10 so a future "slightly less urgent than paid" tier has room
 * underneath it.
 */
const FREE_JOB_PRIORITY = 10;

/**
 * Creates the Job row and, for a free account, its reservation - then enqueues.
 *
 * The transaction is the point. This function is the only place a video job is
 * enqueued, and the download stage can be picked up by a worker the instant the
 * add lands. Charging after the add is therefore a real race, not a theoretical
 * one: the worker can reach TRANSCRIBE - where the money actually leaves - with
 * no ledger row yet written, and a crash between the two leaves free work that
 * was never charged and an allowance that never went down. Row and reservation
 * commit together, and the enqueue happens only once they have.
 *
 * A P2002 from the freeUsage insert is deliberately NOT swallowed here, unlike
 * in chargeFreeSeconds. That function is idempotent because it is called with a
 * jobId that already exists; here the jobId was minted by the line above it
 * inside the same transaction, so a unique-constraint hit on
 * (userId, jobId, kind) means a cuid collided or something is writing rows we
 * do not know about - neither of which should quietly produce an enqueued job.
 * It is also not survivable in place: Postgres aborts the surrounding
 * transaction on the failed statement, so "catch and carry on" would only
 * produce a confusing error at commit instead of a clear one here.
 *
 * THE CONCURRENCY LIMIT IS ENFORCED HERE, UNDER A LOCK, and that is the second
 * reason this function exists as the single door.
 *
 * Both surfaces used to count in-flight jobs and then create - a read-then-write
 * with nothing between the two, which is not a limit at all under concurrency.
 * Six simultaneous uploads on one free account all read zero, all passed, and
 * all created: six jobs and six CHARGE rows against a limit of one. Reproduced
 * against this database, not reasoned about. It shows on the upload path
 * because a pasted URL is probed with yt-dlp first and those seconds of latency
 * serialise the submissions by accident; an upload goes straight to this code.
 *
 * It is worth more than a tidy limit. plans.ts says in as many words that
 * NONE's concurrentJobsLimit of 1 is the ONLY thing holding the zero-clip
 * forgiveness cap shut, and source-recheck reads the balance and then writes it,
 * so N concurrent uploads each reserve zero seconds, each re-check reads the
 * same untouched balance, and one account transcribes N times its allowance.
 * Every one of those depends on this count meaning something.
 *
 * The lock follows withdrawal.service, which solved the same shape of problem
 * for double-spend: pg_advisory_xact_lock inside the transaction, keyed on the
 * user. Per user, so two people submitting at the same instant do not queue
 * behind each other. Transaction-scoped, so it is released by the commit or the
 * rollback and cannot leak on a thrown request - a session-level lock would be
 * wrong here twice over, since Prisma pools connections and the one that took
 * the lock is not the one that would release it. Taken FIRST and alone: one lock
 * per transaction, always in the same place, has no ordering to get wrong, so
 * this cannot deadlock with anything - including a withdrawal, which uses a
 * different key in the same namespace and would at worst wait.
 *
 * The limit is read from the user row INSIDE the transaction rather than passed
 * in. A caller that forgot the argument would silently get no limit at all, and
 * the plan can change between a caller's read and this one.
 */
export async function createJob(
  input: CreateJobInput
): Promise<CreateJobResult> {
  let result: CreateJobResult;
  try {
    result = await prisma.$transaction(
      async (tx): Promise<CreateJobResult> => {
        // SET LOCAL, so it dies with the transaction and cannot leak onto the
        // next request to borrow this pooled connection. It has to be issued
        // INSIDE the transaction and before the lock; a lock_timeout set anywhere
        // else applies to nothing that matters here.
        //
        // $executeRawUnsafe and an interpolated number because SET does not take
        // bind parameters - "SET LOCAL lock_timeout = $1" is a syntax error. The
        // value is a module constant, never anything a caller supplies, so there
        // is nothing here for an injection to reach.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);

        // The subquery-and-constant shape is not decoration: pg_advisory_xact_lock
        // returns void and $queryRaw cannot deserialize that. The classid is a
        // literal in the SQL rather than a bound parameter, because Prisma binds a
        // JS number as int8 and there is no pg_advisory_xact_lock(int4, int8).
        // Classid 1 keeps job submission in its own namespace, away from
        // withdrawal.service's 0.
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${input.userId}), 1)) AS _lock`;

        const user = await tx.user.findUniqueOrThrow({
          where: { id: input.userId },
          select: { plan: true, billingCycle: true },
        });
        const limit = getPlanLimits(
          user.plan,
          user.billingCycle ?? "MONTHLY"
        ).concurrentJobsLimit;

        // Committed rows only, which is exactly right: the caller that got here
        // first has already committed its Job row by the time it releases the
        // lock, so this count sees it. Read Committed is enough for the same
        // reason it is enough in withdrawal.service.
        const inFlight = await tx.job.count({
          where: {
            userId: input.userId,
            status: { in: [...ACTIVE_JOB_STATUSES] },
          },
        });
        if (inFlight >= limit) {
          return { status: "concurrent_limit", inFlight, limit };
        }

        const created = await tx.job.create({
          data: {
            userId: input.userId,
            sourceUrl: input.sourceUrl,
            sourceKey: input.sourceKey,
            originalFilename: input.originalFilename,
            subtitles: input.subtitles ?? true,
            sourceDurationSec: input.sourceDurationSec,
            status: "PENDING",
          },
        });

        if (input.freeCharge) {
          await tx.freeUsage.create({
            data: {
              userId: input.userId,
              jobId: created.id,
              kind: "CHARGE",
              seconds: input.freeCharge.seconds,
              estimatedCostUsd: input.freeCharge.estimatedCostUsd,
            },
          });
        }

        return { status: "created", job: created };
      },
      // Wider than the 5s default, because the body now waits on a lock: several
      // submissions from one account queue up, and the last one in a burst must
      // not be failed by a timeout for having waited its turn. The work under the
      // lock is three statements, so this is headroom, not an expectation.
      //
      // It must stay comfortably ABOVE LOCK_WAIT_MS. This number does not bound
      // the wait - lock_timeout does - it only decides which of the two reports a
      // stuck submission, and lock_timeout is the one that can say why.
      { timeout: 15_000, maxWait: 10_000 }
    );
  } catch (err) {
    if (!isLockContention(err)) throw err;
    // Greppable and rate-limited by its own rarity: on a per-user lock held for
    // milliseconds, waiting out five whole seconds means something is wrong -
    // a wedged transaction, or a hand-held lock in psql - and the line is what
    // connects "users are being told to try again" to that cause.
    console.warn(
      `[jobs] submission for user ${input.userId} gave up waiting ${LOCK_WAIT_MS}ms ` +
        `for the per-user lock; refusing as busy`
    );
    return { status: "busy" };
  }

  // A refusal never reaches the queue. The enqueue also stays outside the
  // transaction: a worker can pick the download up the instant the add lands,
  // and it must not be able to do that before the Job row and its reservation
  // have committed.
  if (result.status !== "created") return result;
  const job = result.job;

  await getStageQueue("download").add(
    "download",
    {
      jobId: job.id,
      userId: job.userId,
    },
    // Only free jobs carry a priority. Passing one for paid jobs would move
    // them OFF the wait list into the prioritized set, which - per the read of
    // moveToActive above - is the slower of the two, so "being explicit" would
    // make paying users worse off.
    input.freeCharge ? { priority: FREE_JOB_PRIORITY } : undefined
  );

  return result;
}

export async function getJob(
  jobId: string,
  userId: string
): Promise<Job | null> {
  return prisma.job.findFirst({
    where: { id: jobId, userId },
    include: { clips: true },
  });
}

export async function getUserJobs(userId: string): Promise<Job[]> {
  return prisma.job.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { clips: true },
    take: 50,
  });
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  extra?: { error?: string; transcription?: string; highlights?: unknown }
): Promise<Job> {
  return prisma.job.update({
    where: { id: jobId },
    data: {
      status,
      ...(extra?.error ? { error: extra.error } : {}),
      ...(extra?.transcription ? { transcription: extra.transcription } : {}),
      ...(extra?.highlights
        ? { highlights: extra.highlights as Prisma.InputJsonValue }
        : {}),
    },
  });
}
