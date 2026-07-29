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
 * A job reaches exactly one terminal state: FAILED, or COMPLETED with some clip
 * count. "Failed" and "produced zero clips" are therefore mutually exclusive
 * outcomes and no job should ever want both refunds. What this actually defends
 * against is the same outcome arriving twice - a BullMQ retry, or a finalize
 * running on two workers - which without it writes the charge back twice and
 * leaves the account holding more free seconds than the tier grants.
 */
async function alreadyRefunded(userId: string, jobId: string): Promise<boolean> {
  const existing = await prisma.freeUsage.count({
    where: { userId, jobId, kind: "REFUND" },
  });
  return existing > 0;
}

/** Full release, no cap: a job we broke must not cost the user their trial. */
export async function refundFailedJob(
  userId: string,
  jobId: string
): Promise<void> {
  const charge = await findCharge(userId, jobId);
  if (!charge) return;
  if (await alreadyRefunded(userId, jobId)) return;

  await prisma.freeUsage.create({
    data: {
      userId,
      jobId,
      kind: "REFUND",
      seconds: charge.seconds,
      // The money was spent even though the run failed; only the allowance is
      // given back, so the budget ceiling still sees the true cost.
      estimatedCostUsd: 0,
    },
  });
}

/**
 * One forgiveness per account for a run that transcribed but found nothing.
 *
 * Without it a first attempt on unclippable video ends the trial and the user
 * leaves having seen nothing work. With more than one, an account can feed us
 * silence indefinitely.
 *
 * KNOWN BUG, kept as specified: the cap query below matches every REFUND row on
 * the account, and refundFailedJob writes rows that match it too. An account
 * whose first job failed on our side has therefore spent its zero-clip
 * forgiveness without ever seeing an empty result. The ledger cannot tell the
 * two reasons apart today - FreeUsageKind is CHARGE|REFUND with no reason
 * column - so fixing it needs a schema change, not an edit here. Pinned by the
 * "BUG:" test in free-tier.service.test.ts.
 */
export async function refundZeroClipJob(
  userId: string,
  jobId: string
): Promise<boolean> {
  const charge = await findCharge(userId, jobId);
  if (!charge) return false;
  if (await alreadyRefunded(userId, jobId)) return false;

  const used = await prisma.freeUsage.count({
    where: { userId, kind: "REFUND", jobId: { not: null } },
  });
  if (used >= FREE_TIER.zeroClipRefunds) return false;

  await prisma.freeUsage.create({
    data: {
      userId,
      jobId,
      kind: "REFUND",
      seconds: charge.seconds,
      estimatedCostUsd: 0,
    },
  });
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
