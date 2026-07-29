import {
  prisma,
  refundFailedJob,
  refundZeroClipJob,
  trueUpFreeCost,
} from "@clipclap/shared";

export type JobOutcome = "DONE" | "FAILED";

/**
 * Closes the free ledger on a job that has reached a terminal state.
 *
 * All three calls inside are no-ops for a paying account and none of them needs
 * to be told which kind of account this is. refundFailedJob and
 * refundZeroClipJob both begin with findFreeCharge and return on null;
 * trueUpFreeCost is an updateMany, which matches zero rows and reports zero
 * rows rather than throwing the way `update` would. A paid job therefore leaves
 * the free_usage table untouched by construction, not by a plan check that
 * could go stale between submit and finalize.
 *
 * ORDER: true up, then refund. It matters, and the reason is not the one you
 * would guess from reading trueUpFreeCost today.
 *
 * A refund row is written with estimatedCostUsd 0 on purpose - the allowance
 * goes back to the user, the OpenAI invoice does not, and freeBudgetStatus sums
 * CHARGE rows only so that the month's real spend stays visible. trueUpFreeCost
 * is scoped to kind CHARGE, so as written it cannot touch that zero in either
 * order. But the scoping is one `where` clause away from being widened by
 * someone who reads "true up the cost of this job" literally, and if it ever
 * were, a true-up running AFTER the refund would stamp the real cost onto the
 * refund row and cancel the charge out of the month's total - making every
 * failed free job look free and quietly raising the ceiling. Running the
 * true-up first is correct under both the narrow scope and the wide one. That
 * is the only reason it is first, and it is enough of one.
 *
 * IDEMPOTENCY: finalize can run twice - a BullMQ retry, a stalled-job takeover,
 * two workers. The true-up is an overwrite with the same value. The refunds are
 * guarded by a read-check and, underneath it, by the unique index on
 * (userId, jobId, kind), whose P2002 both treat as "already refunded". So a
 * second pass writes nothing and the balance is unchanged.
 *
 * Never throws. A settlement failure must not turn a job that produced clips
 * into a FAILED one, and on the failure path it must not replace the error the
 * caller is about to rethrow with a ledger error. The ledger is recoverable
 * from the job rows; the user's outcome is not.
 */
export async function settleFreeLedger(
  jobId: string,
  outcome: JobOutcome
): Promise<void> {
  try {
    // Re-read rather than take the caller's copy. Finalize computes the cost
    // telemetry and writes it in the same statement that sets the status, so
    // the row the stage loaded at entry is already stale by the time we settle;
    // and on the failure path the caller may hold no row at all. userId comes
    // from here too, not from the queue payload - the payload is data we put on
    // Redis, the row is the record.
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        userId: true,
        clipsGenerated: true,
        estimatedTotalCostUsd: true,
      },
    });
    if (!job) return;

    // Only a real, positive figure replaces the estimate. A null or zero here
    // means the telemetry never got computed - a job that failed before the
    // cost fields were written - and stamping 0 onto the CHARGE row would erase
    // the reservation's estimate from the month's total, which is the one
    // number that keeps the free tier bounded. Leaving the estimate in place is
    // the conservative error: it over-counts a job that spent less than
    // predicted, and over-counting closes the tier early rather than late.
    if (
      typeof job.estimatedTotalCostUsd === "number" &&
      job.estimatedTotalCostUsd > 0
    ) {
      await trueUpFreeCost(job.userId, jobId, job.estimatedTotalCostUsd);
    }

    if (outcome === "FAILED") {
      // Uncapped, deliberately: a failure here is our breakage, and our
      // breakage must never spend a stranger's only look at the product.
      await refundFailedJob(job.userId, jobId);
      return;
    }

    if (job.clipsGenerated === 0) {
      // Capped at one per account by refundZeroClipJob itself. A run that
      // transcribed and found nothing cost us money and showed the user
      // nothing, so the first is forgiven; an account that keeps feeding us
      // silence is not.
      await refundZeroClipJob(job.userId, jobId);
    }
  } catch (error) {
    console.error(
      `[free-tier] settlement failed for job ${jobId} (${outcome}):`,
      error
    );
  }
}
