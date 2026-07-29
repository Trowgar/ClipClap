import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { FREE_TIER } from "../config/plans";

/**
 * Has this account proven an identity worth a free allowance?
 *
 * "One trial per account" only bounds anything if an account costs something to
 * make. A Telegram account is phone-backed and a Google account takes real
 * effort; a bare email+password row costs nothing, which is why the trial was
 * switched off in July. A linked google row counts on its own, whatever the
 * adapter did or did not write into emailVerified.
 */
export async function isTrialAnchored(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      telegramId: true,
      emailVerified: true,
      email: true,
      emailCanonical: true,
    },
  });
  if (!user) return false;

  // Telegram first, and it does not care about the email columns: a bot-only
  // account has both of them NULL and is anchored by a phone-backed id.
  if (user.telegramId) return true;

  // For an account that HAS an email, a NULL emailCanonical means another
  // account already owns this mailbox - the OAuth createUser hook could not
  // claim it. Verified or not, this one does not get a second allowance.
  if (user.email && !user.emailCanonical) return false;

  if (user.emailVerified) return true;

  const federated = await prisma.account.count({
    where: { userId, provider: "google" },
  });
  return federated > 0;
}

/**
 * The free allowance, read from its own ledger.
 *
 * It must never be derived from Job rows: deleteProject hard-deletes them, so a
 * jobs-based count is reset by the user pressing Delete. That is hole 3 from the
 * design, and the test above asserts this query does not mention jobs.
 */
export async function freeBalanceSeconds(userId: string): Promise<number> {
  const rows = await prisma.freeUsage.groupBy({
    by: ["kind"],
    where: { userId },
    _sum: { seconds: true },
  });

  let charged = 0;
  let refunded = 0;
  for (const row of rows) {
    if (row.kind === "CHARGE") charged = row._sum.seconds ?? 0;
    if (row.kind === "REFUND") refunded = row._sum.seconds ?? 0;
  }

  return Math.max(0, FREE_TIER.lifetimeSeconds - charged + refunded);
}

/**
 * Reserves minutes before the job is enqueued.
 *
 * Reservation, not post-hoc charging: ten videos submitted at once would each
 * see a full balance and all ten would run.
 */
export async function chargeFreeSeconds(
  userId: string,
  jobId: string,
  seconds: number,
  estimatedCostUsd: number
): Promise<void> {
  await prisma.freeUsage.create({
    data: { userId, jobId, kind: "CHARGE", seconds, estimatedCostUsd },
  });
}

async function findCharge(userId: string, jobId: string) {
  return prisma.freeUsage.findFirst({
    where: { userId, jobId, kind: "CHARGE" },
    select: { seconds: true, estimatedCostUsd: true },
  });
}

/**
 * Idempotency guard, shared by both refund paths on purpose.
 *
 * A job reaches exactly one terminal state. analyze.ts routes an honest empty
 * outcome to finalize as DONE and only technical failures to FAILED, so "failed"
 * and "produced zero clips" are disjoint and no job legitimately wants both
 * refunds. What this defends against is the same outcome arriving twice - a
 * BullMQ retry, or a finalize running on two workers.
 *
 * It is a read-check, so it cannot see a write that has not committed yet. It
 * saves a round trip in the common case; the unique index on
 * (userId, jobId, kind) is what actually makes the double refund impossible, and
 * both callers treat its P2002 as this function having returned true.
 */
async function alreadyRefunded(userId: string, jobId: string): Promise<boolean> {
  const existing = await prisma.freeUsage.count({
    where: { userId, jobId, kind: "REFUND" },
  });
  return existing > 0;
}

/**
 * True when this error is the unique index rejecting a second refund for a job.
 *
 * The only unique constraint this table carries is (userId, jobId, kind), so a
 * P2002 from a refund insert can mean nothing else: another finalize won the
 * race and the refund the caller wanted already exists. That is the same
 * conclusion alreadyRefunded reaches, so callers return the same answer.
 */
function isDuplicateRefund(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/** Full release, no cap: a job we broke must not cost the user their trial. */
export async function refundFailedJob(
  userId: string,
  jobId: string
): Promise<void> {
  const charge = await findCharge(userId, jobId);
  if (!charge) return;
  if (await alreadyRefunded(userId, jobId)) return;

  try {
    await prisma.freeUsage.create({
      data: {
        userId,
        jobId,
        kind: "REFUND",
        reason: "FAILED_JOB",
        seconds: charge.seconds,
        // The money was spent even though the run failed; only the allowance is
        // given back, so the budget ceiling still sees the true cost.
        estimatedCostUsd: 0,
      },
    });
  } catch (err) {
    if (!isDuplicateRefund(err)) throw err;
    // Another finalize refunded this job between our check and our insert.
    // Nothing to do - the user has their seconds back either way.
  }
}

/**
 * One forgiveness per account for a run that transcribed but found nothing.
 *
 * Without it a first attempt on unclippable video ends the trial and the user
 * leaves having seen nothing work. With more than one, an account can feed us
 * silence indefinitely.
 *
 * The cap counts ZERO_CLIPS rows only. Counting every refund on the account
 * would let a job that broke on OUR side spend a forgiveness the user never
 * used, quietly turning refundFailedJob's deliberately uncapped release into a
 * capped one - the exact opposite of what it is for. That is what `reason` was
 * added to the ledger to express.
 *
 * Returns whether THIS call wrote the refund, so a caller can tell the user
 * their one forgiveness has now been spent. A lost race returns false: the
 * seconds are back, but this call is not what put them there.
 */
export async function refundZeroClipJob(
  userId: string,
  jobId: string
): Promise<boolean> {
  const charge = await findCharge(userId, jobId);
  if (!charge) return false;
  if (await alreadyRefunded(userId, jobId)) return false;

  const used = await prisma.freeUsage.count({
    where: { userId, kind: "REFUND", reason: "ZERO_CLIPS" },
  });
  if (used >= FREE_TIER.zeroClipRefunds) return false;

  try {
    await prisma.freeUsage.create({
      data: {
        userId,
        jobId,
        kind: "REFUND",
        reason: "ZERO_CLIPS",
        seconds: charge.seconds,
        estimatedCostUsd: 0,
      },
    });
  } catch (err) {
    if (!isDuplicateRefund(err)) throw err;
    return false;
  }
  return true;
}

/**
 * Replaces the probe estimate with what the run actually cost.
 *
 * updateMany rather than update, and scoped to CHARGE: a paid-plan job has no
 * ledger row at all and prisma.update would throw on it, while the REFUND row
 * for a refunded job carries a deliberate 0 that must not be overwritten with
 * the real cost - doing so would cancel the charge out of the budget sum and
 * make every failed job look free.
 */
export async function trueUpFreeCost(
  jobId: string,
  actualCostUsd: number
): Promise<void> {
  await prisma.freeUsage.updateMany({
    where: { jobId, kind: "CHARGE" },
    data: { estimatedCostUsd: actualCostUsd },
  });
}
