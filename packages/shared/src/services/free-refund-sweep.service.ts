import { prisma } from "../lib/prisma";
import { refundFailedJob } from "./free-tier.service";

/**
 * How long a job must have been completely silent before the sweep calls it
 * dead.
 *
 * Not "how long since it failed": status FAILED is written on EVERY BullMQ
 * attempt, not only the last one, so a job can look terminal while attempt 2
 * is about to start. What is measured instead is silence - no job_steps row
 * for the job touched since the cutoff - because every stage upserts its step
 * row on start, on completion and on failure, so any attempt in flight or
 * about to begin moves that timestamp and resets the clock.
 *
 * Six hours, and the number is not chosen from the backoff. BullMQ's own
 * backoff is exponential from a 5000 ms base over 3 attempts (2 for render),
 * so the gap it introduces between attempts is measured in SECONDS and would
 * justify a threshold of minutes. What can actually delay a retry by hours is
 * queue depth: the render queue runs at concurrency 1 with a 30-minute lock,
 * so twelve long renders ahead of a retry is six hours of waiting during which
 * nothing touches the job at all. Six hours is that worst case, and it is also
 * an order of magnitude beyond any end-to-end job this pipeline has actually
 * run.
 *
 * The error is asymmetric, and it points the safe way. Too LATE costs a user
 * some hours before their allowance is back. Too EARLY would matter only if a
 * job that had been silent for six hours then succeeded - which needs a retry
 * that is still pending after six hours AND goes on to produce clips - and
 * even then the damage is one free run, because refundFailedJob is idempotent
 * and cannot double-release. Six hours buys a wide margin against a cost that
 * is small in both directions, and returns the allowance the same day.
 */
export const REFUND_SWEEP_SILENCE_HOURS = 6;

const MS_PER_HOUR = 60 * 60 * 1000;

/** A job silent since before this instant has no attempt left to come. */
export function refundSweepCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - REFUND_SWEEP_SILENCE_HOURS * MS_PER_HOUR);
}

/** Rows settled per run. Same reasoning as the retention sweep's page: this
 *  shares the finalize worker with real jobs, and a first pass over a backlog
 *  nobody has ever swept should not hold it for minutes. A backlog drains over
 *  successive hours; nothing here is urgent. */
export const REFUND_SWEEP_PAGE_SIZE = 200;

export interface RefundSweepResult {
  /** Reservations released by this run. */
  refunded: number;
  /** Candidates that threw and will be retried next hour. */
  failed: number;
  /** True when the killswitch turned the run off. */
  disabled: boolean;
}

interface RefundCandidate {
  userId: string;
  jobId: string;
  seconds: number;
}

/**
 * The unsettled reservations of jobs that died before finalize.
 *
 * Raw SQL, deliberately, and this is the one place in the service layer that
 * needs it. free_usage.jobId is a bare String with NO foreign key - a relation
 * would reintroduce the delete-resets-the-ledger hole the table exists to
 * close - so Prisma cannot join the ledger to the jobs, and the question being
 * asked is a join: "charges whose job is dead and whose refund is missing".
 *
 * Doing it in two Prisma queries instead would break the paging, which is the
 * part that has to be right. This selector is SELF-DRAINING: a row leaves it
 * for ever the moment its refund is written, so a page of 200 ordered oldest
 * first is always 200 rows that need work. Selecting failed jobs first and
 * filtering afterwards is not: a paid account's failed job matches the job
 * half of the condition permanently and never leaves, so the page would
 * eventually fill with permanent non-candidates and the sweep would stop
 * reaching anything - the same trap Job.sourceSweptAt exists to avoid in the
 * retention sweep, which cannot be solved here without a migration.
 *
 * THE JOIN ALSO MEANS THIS SWEEP CANNOT SEE A CHARGE WHOSE JOB WAS DELETED, and
 * that is not a gap to be closed here. Once the job row is gone the ledger
 * cannot tell a FAILED job's charge from that of a DONE job whose clips the user
 * downloaded and then tidied away, and refunding the second would hand back
 * minutes that were spent successfully. The outcome is only knowable while the
 * row exists, so deleteProject settles the ledger before it deletes - see
 * settleFreeLedgerOnDelete. Teaching this selector to refund orphans would undo
 * that reasoning and make a lifetime allowance resettable with a Delete button.
 *
 * "Owned by an account on the free tier" is expressed as the CHARGE row
 * itself, not as user.plan. The ledger row is what makes a job the free
 * tier's - it is what the download re-check keys on and what refundFailedJob
 * keys on - and the plan is mutable: a user who upgrades after a failed free
 * job is still owed the allowance that job took.
 */
async function findUnsettledCharges(
  cutoff: Date,
  limit: number
): Promise<RefundCandidate[]> {
  return prisma.$queryRaw<RefundCandidate[]>`
    SELECT f."userId", f."jobId", f.seconds
    FROM free_usage f
    JOIN jobs j ON j.id = f."jobId"
    WHERE f.kind = 'CHARGE'
      AND j.status = 'FAILED'
      AND j."createdAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM job_steps s
        WHERE s."jobId" = j.id AND s."updatedAt" >= ${cutoff}
      )
      AND NOT EXISTS (
        SELECT 1 FROM free_usage r
        WHERE r."userId" = f."userId"
          AND r."jobId" = f."jobId"
          AND r.kind = 'REFUND'
      )
    ORDER BY j."createdAt" ASC
    LIMIT ${limit}
  `;
}

/**
 * Returns the allowance for free jobs that died somewhere finalize never sees.
 *
 * WHY THIS EXISTS. finalize settles the outcome it is handed, but only the
 * analyze stage's honest-empty path and a successful render ever enqueue it. A
 * job that breaks at TRANSCRIBE, ANALYZE or RENDER is marked FAILED by its own
 * stage and thrown onward - finalize is never reached, and the CHARGE row
 * stands for ever. The user loses their one look at the product to a failure
 * that was ours, which is the exact outcome refundFailedJob exists to prevent.
 *
 * WHY A SWEEP rather than a BullMQ `failed` handler. A handler would have to be
 * wired into five separate stage workers, would need each of them to know
 * whether the attempt it just lost was the last one, and would still miss the
 * case a handler cannot observe: a worker killed mid-attempt, where no callback
 * of any kind runs. A sweep is one query in one place, and it is self-healing -
 * it catches whatever every other path missed, including paths that do not
 * exist yet. That is also why it does not try to be clever about WHICH failure
 * it is settling: anything terminal and unrefunded is its business.
 *
 * KILLSWITCH, INVERTED relative to the retention sweep, and for the same
 * reasoning applied to an opposite risk. Retention deletes user data
 * irreversibly, so its flag names the destructive branch and fails CLOSED: a
 * half-filled .env can only ever land on "report". Here the dangerous branch is
 * NOT running - a refund sweep silently switched off means keeping an allowance
 * that is not ours, indefinitely and invisibly. So the flag names the disabled
 * branch and the sweep fails OPEN: unset, empty or absent all RUN. Read per
 * run, not cached, so flipping it needs no redeploy.
 */
export async function runFreeRefundSweep(
  now: Date = new Date()
): Promise<RefundSweepResult> {
  if (process.env.FREE_REFUND_SWEEP_DISABLED) {
    console.warn(
      "[free-refund] FREE_REFUND_SWEEP_DISABLED is set - free allowances for " +
        "jobs that failed outside finalize are NOT being returned"
    );
    return { refunded: 0, failed: 0, disabled: true };
  }

  const cutoff = refundSweepCutoff(now);
  const candidates = await findUnsettledCharges(cutoff, REFUND_SWEEP_PAGE_SIZE);

  let refunded = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      await refundFailedJob(candidate.userId, candidate.jobId);
      // Greppable, and it names all three things anyone asking "why did this
      // account get its allowance back" needs: which job, whose, how much.
      console.log(
        `[free-refund] refunded ${candidate.seconds}s to user ` +
          `${candidate.userId} for job ${candidate.jobId} ` +
          `(failed outside finalize)`
      );
      refunded++;
    } catch (error) {
      // One bad row must not cost the rest of the page their refunds. The
      // candidate stays in the selector, so the next hourly run retries it.
      console.error(
        `[free-refund] failed to refund job ${candidate.jobId} for user ` +
          `${candidate.userId}:`,
        error
      );
      failed++;
    }
  }

  // Silence when there is nothing to do - this runs hourly for ever and the
  // usual answer is zero. A non-zero `failed` is loud, because a sweep that
  // cannot write is indistinguishable from a sweep with no work.
  if (failed > 0) {
    console.error(
      `[free-refund] refunded ${refunded}, ${failed} failed and will retry`
    );
  } else if (refunded > 0) {
    console.log(`[free-refund] refunded ${refunded} stranded reservations`);
  }

  return { refunded, failed, disabled: false };
}
