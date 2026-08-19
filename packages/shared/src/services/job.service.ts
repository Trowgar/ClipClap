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
 *
 * `queued` is the third: at the cap with the queue flag on, the row is
 * created and charged exactly as `created`, but it waits for a slot instead
 * of being refused. See SUBMISSION_QUEUE below.
 */
export type CreateJobResult =
  | { status: "created"; job: Job }
  /** Created and charged, but WAITING for a concurrency slot. `position` is
   *  1-based among this user's waiting jobs (1 = next in line). Only emitted
   *  when SUBMISSION_QUEUE=on; the flag off reproduces concurrent_limit. */
  | { status: "queued"; job: Job; position: number }
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

/** Kill switch, read per call like YTDLP_PROXY: only the exact literal "on"
 *  queues; anything else refuses at the cap exactly as before the queue
 *  existed. The RELEASE path deliberately does not consult this - turning the
 *  flag off must drain the queue, not strand it. */
export function submissionQueueEnabled(): boolean {
  return process.env.SUBMISSION_QUEUE === "on";
}

/** Deterministic BullMQ id for a job's download add. BullMQ ignores an add
 *  whose id it has already seen, which makes a double release (completion
 *  hook and stall guard racing) a no-op instead of a double download. */
function downloadJobId(jobId: string): string {
  return `dl:${jobId}`;
}

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
        // enqueuedAt: { not: null } excludes rows that are WAITING in the
        // queue, not running - counting them here would mean one queued job
        // permanently blocks the slot the queue exists to eventually give it.
        const inFlight = await tx.job.count({
          where: {
            userId: input.userId,
            status: { in: [...ACTIVE_JOB_STATUSES] },
            enqueuedAt: { not: null },
          },
        });
        const atCapacity = inFlight >= limit;
        if (atCapacity && !submissionQueueEnabled()) {
          return { status: "concurrent_limit", inFlight, limit };
        }

        const created = await tx.job.create({
          data: {
            userId: input.userId,
            sourceUrl: input.sourceUrl,
            sourceKey: input.sourceKey,
            sourceFingerprint: input.sourceFingerprint ?? null,
            originalFilename: input.originalFilename,
            subtitles: input.subtitles ?? true,
            sourceDurationSec: input.sourceDurationSec,
            status: "PENDING",
            // NULL is the queue: this row is created and charged but not yet
            // handed to BullMQ. The freeUsage reservation below is written
            // either way - a queued job has reserved its seconds the moment
            // the user was told "got it", not the moment a worker starts it.
            enqueuedAt: atCapacity ? null : new Date(),
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

        if (atCapacity) {
          // 1-based among this user's waiting rows, self included - the row
          // above is visible to this count because it is the same transaction.
          const position = await tx.job.count({
            where: { userId: input.userId, status: "PENDING", enqueuedAt: null },
          });
          return { status: "queued", job: created, position };
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

  // A refusal never reaches the queue, and neither does a `queued` row - it is
  // handed to BullMQ later, by releaseNextQueued, once a slot actually opens.
  // The enqueue also stays outside the transaction: a worker can pick the
  // download up the instant the add lands, and it must not be able to do that
  // before the Job row and its reservation have committed.
  if (result.status !== "created") return result;
  const job = result.job;

  await getStageQueue("download").add(
    "download",
    {
      jobId: job.id,
      userId: job.userId,
    },
    {
      // Deterministic id, not a generated one: releaseNextQueued adds the
      // same job again if a stall-guard sweep and a completion hook both race
      // to release it, and BullMQ silently ignores an add whose id it has
      // already seen. A createJob-started job never gets a second add, but
      // the id is set unconditionally so both paths agree on what it is.
      jobId: downloadJobId(job.id),
      // Only free jobs carry a priority. Passing one for paid jobs would move
      // them OFF the wait list into the prioritized set, which - per the read
      // of moveToActive above - is the slower of the two, so "being explicit"
      // would make paying users worse off.
      ...(input.freeCharge ? { priority: FREE_JOB_PRIORITY } : {}),
    }
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

/**
 * A resent source, if this user already has a job for it that makes a new run
 * pointless: one still RUNNING (a second copy of the same work), or one that
 * finished with clips that are still in storage (they can be handed back for
 * free). A FAILED job, a job whose clips were swept, or a job with no clips is
 * NOT a duplicate - resending after those is the legitimate retry.
 *
 * Fingerprints came in on 2026-08-18; older jobs have none and never match.
 */
export type DuplicateJob =
  | { kind: "active"; job: Pick<Job, "id" | "status" | "createdAt"> }
  | {
      kind: "completed";
      job: Pick<Job, "id" | "status" | "createdAt">;
      clips: Array<{
        id: string;
        title: string | null;
        telegramFileId: string | null;
        storageKey: string;
      }>;
    };

export async function findDuplicateJob(
  userId: string,
  fingerprint: string | null | undefined
): Promise<DuplicateJob | null> {
  if (!fingerprint) return null;
  const now = new Date();
  const candidates = await prisma.job.findMany({
    where: { userId, sourceFingerprint: fingerprint },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      status: true,
      createdAt: true,
      clips: {
        where: { deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        orderBy: { startTime: "asc" },
        select: { id: true, title: true, telegramFileId: true, storageKey: true },
      },
    },
  });
  for (const job of candidates) {
    if ((ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status)) {
      return { kind: "active", job };
    }
    if (job.status === "DONE" && job.clips.length > 0) {
      return { kind: "completed", job, clips: job.clips };
    }
  }
  return null;
}

/** How long an active job may go without touching its row before the stall
 *  guard presumes its worker dead and stops counting it against the limit.
 *  Every stage updates Job.status (and thus updatedAt) as it runs, so a 3h
 *  silence is not a slow job - it is a job nobody is running. */
export const QUEUE_STALL_MS = 3 * 60 * 60 * 1000;

/**
 * Hand the oldest waiting jobs to BullMQ while this user has free slots.
 *
 * Runs under the SAME advisory lock as createJob, so a submission and a
 * release can never both read a stale count. NEVER throws: it is called from
 * worker event handlers and an hourly sweep, and a failed release is repaired
 * by the next completion or the stall guard - taking a worker down over it
 * would cost more than the wait.
 *
 * `staleBefore` is the stall guard's view: actives whose updatedAt is older
 * stop holding a slot. The normal hooks pass nothing and trust every active.
 */
export async function releaseNextQueued(
  userId: string,
  opts: { staleBefore?: Date } = {}
): Promise<Job[]> {
  let released: Job[] = [];
  try {
    released = await prisma.$transaction(
      async (tx): Promise<Job[]> => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${userId}), 1)) AS _lock`;

        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { plan: true, billingCycle: true },
        });
        const limit = getPlanLimits(
          user.plan,
          user.billingCycle ?? "MONTHLY"
        ).concurrentJobsLimit;

        const active = await tx.job.count({
          where: {
            userId,
            status: { in: [...ACTIVE_JOB_STATUSES] },
            enqueuedAt: { not: null },
            ...(opts.staleBefore ? { updatedAt: { gte: opts.staleBefore } } : {}),
          },
        });
        const slots = limit - active;
        if (slots <= 0) return [];

        const next = await tx.job.findMany({
          where: { userId, status: "PENDING", enqueuedAt: null },
          orderBy: { createdAt: "asc" },
          take: slots,
        });
        const now = new Date();
        for (const job of next) {
          await tx.job.update({
            where: { id: job.id },
            data: { enqueuedAt: now },
          });
        }
        return next;
      },
      { timeout: 15_000, maxWait: 10_000 }
    );
  } catch (err) {
    // Includes lock contention AND a user row deleted mid-flight. Both are
    // repaired by the next release attempt; neither may take the caller down.
    console.warn(
      `[queue] release for user ${userId} failed:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }

  // Outside the transaction for the same reason createJob enqueues outside:
  // a worker may pick the download up the instant the add lands.
  //
  // Each job gets its own try/catch. This loop must never throw - it is
  // called from an hourly sweep that visits every user with a waiting job in
  // one pass, and one user's transient Redis/DB failure must not abort the
  // release for every user still to come. A failure here is also worse than
  // one in the transaction above: the row already has enqueuedAt stamped, so
  // neither createJob's in-flight count nor this function's own "waiting"
  // query will ever consider it again - a stamped-but-never-added job is
  // invisible to every other repair path there is. The catch below undoes
  // the stamp so the row falls back into the waiting pool for the next
  // release attempt to retry. If the add actually landed despite the error
  // (say, it succeeded but the acknowledgement was lost), the retry costs
  // nothing: downloadJobId is deterministic, so BullMQ ignores the second add
  // for an id it has already seen.
  const actuallyReleased: Job[] = [];
  for (const job of released) {
    try {
      const freeCharged = await prisma.freeUsage.findFirst({
        where: { jobId: job.id, kind: "CHARGE" },
        select: { id: true },
      });
      await getStageQueue("download").add(
        "download",
        { jobId: job.id, userId: job.userId },
        {
          jobId: downloadJobId(job.id),
          ...(freeCharged ? { priority: FREE_JOB_PRIORITY } : {}),
        }
      );
      console.log(`[queue] released job ${job.id} for user ${job.userId}`);
      actuallyReleased.push(job);
    } catch (err) {
      console.error(`[queue] could not enqueue released job ${job.id}:`, err);
      try {
        await prisma.job.update({
          where: { id: job.id },
          data: { enqueuedAt: null },
        });
      } catch (undoErr) {
        // Nothing further to do: the job is stranded until an operator or a
        // future sweep notices it by hand. A second failure here must not
        // throw either - the loop still owes every remaining job its try.
        console.error(
          `[queue] could not un-stamp job ${job.id} after a failed enqueue:`,
          undoErr
        );
      }
    }
  }
  return actuallyReleased;
}

/**
 * The hourly stall guard: for every user with a waiting job, run a release
 * that refuses to count actives silent for QUEUE_STALL_MS as slot-holders.
 * A dead worker must not hold somebody's queue forever; a healthy active has
 * touched its row within the window and keeps its slot.
 */
export async function releaseStalledQueues(now: Date): Promise<number> {
  const users = await prisma.job.groupBy({
    by: ["userId"],
    where: { status: "PENDING", enqueuedAt: null },
  });
  const staleBefore = new Date(now.getTime() - QUEUE_STALL_MS);
  let releasedTotal = 0;
  for (const { userId } of users) {
    const released = await releaseNextQueued(userId, { staleBefore });
    releasedTotal += released.length;
  }
  if (releasedTotal > 0) {
    console.warn(`[queue] stall guard released ${releasedTotal} job(s)`);
  }
  return releasedTotal;
}
