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

  // The zero defaults are what carry the common case, not the `?? 0`. Postgres
  // OMITS a kind entirely when the account has no rows of it - a fresh account
  // returns [], and an account that has only ever been charged returns a
  // one-element array - so `refunded` is usually never assigned at all. Drop
  // either initialiser and those accounts compute against undefined, which is
  // NaN, and NaN fails every comparison the gate makes.
  //
  // The `?? 0` is a type requirement, not a runtime guard: _sum.seconds is
  // `number | null` and TypeScript will not subtract a null, but JavaScript
  // coerces null to 0 in arithmetic, so removing it changes no behaviour. Do
  // not read it as the thing protecting an empty sum.
  let charged = 0;
  let refunded = 0;
  for (const row of rows) {
    if (row.kind === "CHARGE") charged = row._sum.seconds ?? 0;
    if (row.kind === "REFUND") refunded = row._sum.seconds ?? 0;
  }

  return Math.max(0, FREE_TIER.lifetimeSeconds - charged + refunded);
}

/**
 * Reserves seconds before the job is enqueued.
 *
 * Reservation, not post-hoc charging: ten videos submitted at once would each
 * see a full balance and all ten would run.
 *
 * A duplicate is a no-op, not an error. This runs on the submit path, so an
 * unhandled P2002 reaches the user as a 500 on a button press; and the only way
 * it fires is a retry of a submission whose reservation already landed, where
 * the caller's post-condition - a CHARGE row exists for this job - already
 * holds. Swallowing it makes submit idempotent.
 *
 * One consequence worth stating: the CHARGE row is permanent, so a refunded
 * job's allowance cannot be re-reserved under the same jobId. That is correct -
 * a refunded job is terminal, and every submission mints a fresh cuid - but it
 * does mean this function is not a general "spend seconds" primitive.
 */
export async function chargeFreeSeconds(
  userId: string,
  jobId: string,
  seconds: number,
  estimatedCostUsd: number
): Promise<void> {
  try {
    await prisma.freeUsage.create({
      data: { userId, jobId, kind: "CHARGE", seconds, estimatedCostUsd },
    });
  } catch (err) {
    if (!isDuplicateRow(err)) throw err;
  }
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
 * True when this error is the unique index rejecting a duplicate ledger row.
 *
 * The only unique constraint this table carries is (userId, jobId, kind), so a
 * P2002 from any insert here can mean nothing else: someone else wrote the row
 * this call wanted first. Every caller's post-condition is therefore already
 * satisfied, which is why all three treat it as success rather than an error.
 *
 * Deliberately narrow. A dead connection or a constraint added later must
 * surface, not be reported as a reservation taken or a refund granted that the
 * user never actually got.
 */
function isDuplicateRow(err: unknown): boolean {
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
    if (!isDuplicateRow(err)) throw err;
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

  // READ THIS BEFORE RAISING concurrentJobsLimit FOR THE FREE TIER.
  //
  // This cap is NOT guarded by the database. The unique index is on
  // (userId, jobId, kind) and correctly does not collide two different jobs, so
  // two zero-clip jobs finalizing at the same moment can both read `used` as 0
  // and both insert, leaving two ZERO_CLIPS rows against a cap of one.
  //
  // What keeps that window shut is the concurrency limit: NONE_LIMITS gives the
  // free tier at most one job in flight, so there is no second finalize to race.
  // Raise concurrentJobsLimit above 1 for NONE and this reopens, and the fix
  // then is a partial unique index on (userId, reason) or a serialisable
  // transaction - not a bigger read-check. Left alone deliberately today: real
  // complexity for a worst case of one extra forgiveness, about $0.19.
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
    if (!isDuplicateRow(err)) throw err;
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
 *
 * Scoped to userId as well, even though a cuid jobId is unique in practice.
 * jobId here is a bare String with no foreign key - deliberately, since a key
 * would reintroduce the delete-resets-the-ledger hole - so nothing in the
 * database stops two users holding rows with the same jobId string, and an
 * updateMany without a user would rewrite both. Taking the userId makes that
 * unrepresentable rather than merely unlikely.
 */
export async function trueUpFreeCost(
  userId: string,
  jobId: string,
  actualCostUsd: number
): Promise<void> {
  await prisma.freeUsage.updateMany({
    where: { userId, jobId, kind: "CHARGE" },
    data: { estimatedCostUsd: actualCostUsd },
  });
}
