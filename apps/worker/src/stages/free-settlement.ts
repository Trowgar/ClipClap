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
 * WHAT THE LEDGER IS CHARGED is the cash the run cost - transcription plus
 * analysis - and not `estimatedTotalCostUsd`, which also contains compute. See
 * the select below; that distinction is the whole point of this stage.
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
        // The two CASH lines, deliberately not estimatedTotalCostUsd.
        //
        // The total also carries estimatedComputeCostUsd, which is
        // sourceMinutes * 0.006 of rented server that we pay for whether this
        // job runs or not. cost-telemetry is right to record it - it is the
        // full picture of what a run consumes, and the margin analysis reads
        // it - but the monthly budget is a CEILING ON MONEY LEAVING THE
        // ACCOUNT, and compute does not leave it because of this job. Charging
        // it burned the ceiling about 37% faster than the spend it bounds: a
        // run reserved at 0.02755 was trued up to 0.063, of which 0.017 was
        // compute, so a 10 USD ceiling funded about 13 accounts instead of 17.
        //
        // Do not "simplify" this back to the total. If a third cash line is
        // ever added to cost-telemetry it must be added here too; if a second
        // non-cash line is added, it must not.
        estimatedTranscriptionCostUsd: true,
        estimatedAnalysisCostUsd: true,
        // For the zero-clip refund only, and only to answer "did we warn them?".
        // The authoritative value, written by the source re-check after the file
        // was measured - not what the submitter claimed.
        sourceDurationSec: true,
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
    //
    // A DONE job always transcribed, but its transcription line is only positive
    // if MODEL_PRICES_JSON prices the model it used - an unpriced model yields
    // null by design (see cost-telemetry.ts). So a missing or incomplete price
    // table skips the true-up for every job and leaves the reservation estimate
    // standing. That is the safe direction - over-counting closes the tier early,
    // never late - but it means an unpriced model silently stops the ledger from
    // tracking real spend. The boot warning in index.ts (Task 5) is what makes
    // that visible; without it this failure is completely silent.
    const cashCostUsd =
      (job.estimatedTranscriptionCostUsd ?? 0) +
      (job.estimatedAnalysisCostUsd ?? 0);
    if (cashCostUsd > 0) {
      await trueUpFreeCost(job.userId, jobId, cashCostUsd);
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
      //
      // The duration is passed because that cap has one exception: a source the
      // bot had ALREADY warned was too short to work is refunded every time. See
      // refundZeroClipJob - we do not bill somebody for the outcome we predicted.
      await refundZeroClipJob(job.userId, jobId, job.sourceDurationSec);
    }
  } catch (error) {
    console.error(
      `[free-tier] settlement failed for job ${jobId} (${outcome}):`,
      error
    );
  }
}
