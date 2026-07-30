import { Prisma } from "@prisma/client";
import type { JobStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { FREE_TIER, estimatedFreeCostUsd } from "../config/plans";

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

export interface FreeCharge {
  seconds: number;
  estimatedCostUsd: number | null;
}

/**
 * The reservation this job holds, or null if it holds none.
 *
 * Exported because "is this job running on the free allowance?" has exactly one
 * honest answer in the worker, and it is this row - not the user's plan. The
 * plan is mutable and the worker reads it minutes to hours after submit: a user
 * who buys Starter while a free job is queued would look paid to a plan check,
 * and the download stage would then skip a re-check for a job whose CHARGE row
 * is sitting on the ledger waiting to be corrected. It is also the exact
 * condition the three settlement functions key on, so keying the re-check on
 * anything else would let the two disagree.
 */
export async function findFreeCharge(
  userId: string,
  jobId: string
): Promise<FreeCharge | null> {
  return prisma.freeUsage.findFirst({
    where: { userId, jobId, kind: "CHARGE" },
    select: { seconds: true, estimatedCostUsd: true },
  });
}

/**
 * Corrects a reservation to the duration that was actually measured.
 *
 * Separate from trueUpFreeCost rather than a widening of it, because the two
 * answer different questions at different moments. This one runs at the
 * download stage and says "the submit path guessed the LENGTH, here is what the
 * file really is"; trueUpFreeCost runs at finalize and says "the estimate said
 * this would COST x, the telemetry says it cost y". Merging them would give one
 * function two callers with two meanings, and the finalize caller - which must
 * never touch `seconds`, because seconds is what the user's balance is made of
 * - would be one optional argument away from rewriting the allowance.
 *
 * The cost is derived here rather than passed in, so a corrected row can never
 * hold seconds from the probe and a USD figure from the client's guess. It is
 * still only an estimate; finalize replaces it with the measured one.
 *
 * updateMany and scoped to kind CHARGE for the same two reasons as
 * trueUpFreeCost: a paid job has no row at all and `update` would throw on it,
 * and the REFUND row's deliberate zero must survive.
 */
export async function reviseFreeChargeSeconds(
  userId: string,
  jobId: string,
  seconds: number
): Promise<void> {
  const measured = Math.max(0, Math.round(seconds));
  await prisma.freeUsage.updateMany({
    where: { userId, jobId, kind: "CHARGE" },
    data: {
      seconds: measured,
      estimatedCostUsd: estimatedFreeCostUsd(measured),
    },
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
  const charge = await findFreeCharge(userId, jobId);
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
 * Full release for a job the user deleted before a cent of it was spent.
 *
 * Uncapped, like refundFailedJob and unlike the zero-clip forgiveness, and the
 * reason it can be is arithmetic rather than generosity: the farming attack the
 * cap exists to stop needs a TRANSCRIPTION to have happened, and the only
 * statuses that reach this function are the ones before the transcribe call.
 * Submitting an hour of video and deleting it at PENDING costs us a Job row and
 * a queue entry. Repeating that a thousand times still costs us a Job row and a
 * queue entry - there is nothing to farm.
 *
 * The states this is legal for are decided by settleFreeLedgerOnDelete, which
 * is the only caller, and are named there. Do not widen it here.
 */
export async function refundUnstartedJob(
  userId: string,
  jobId: string
): Promise<void> {
  const charge = await findFreeCharge(userId, jobId);
  if (!charge) return;
  if (await alreadyRefunded(userId, jobId)) return;

  try {
    await prisma.freeUsage.create({
      data: {
        userId,
        jobId,
        kind: "REFUND",
        reason: "DELETED_BEFORE_SPEND",
        seconds: charge.seconds,
        // Zero, like every other refund row, and here it is not even a
        // convention: no money was spent, so there is nothing for the monthly
        // budget to keep counting. The CHARGE row's own estimate stays on the
        // ledger and keeps overstating the month by one reservation until the
        // next true-up - erring towards closing the trial early, which is the
        // safe direction.
        estimatedCostUsd: 0,
      },
    });
  } catch (err) {
    if (!isDuplicateRow(err)) throw err;
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
  const charge = await findFreeCharge(userId, jobId);
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
  // That limit only became real on 2026-07-29 - it used to be a count in the
  // route with nothing serialising it, and six simultaneous uploads sailed past
  // it - and it is now taken under a per-user advisory lock inside createJob.
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
 * Settles the ledger for a job that is about to be hard-deleted.
 *
 * WHY THIS HAS TO HAPPEN HERE, of all places.
 *
 * The refund sweep is the safety net for a free job that died somewhere
 * finalize never sees, and its selector joins free_usage to jobs - it has to,
 * because "was this job FAILED?" is a question only the job row can answer.
 * deleteProject hard-deletes that row. So a charge whose job is gone is
 * invisible to the one mechanism that exists to release it, and the loss is
 * permanent. The timing is what makes it cruel: the sweep waits six hours for
 * silence, so for most of a working day the dashboard says the minutes are
 * spent, the failed project sits there with a Delete button, and pressing it -
 * the obvious next move - is what makes the forfeiture final.
 *
 * The fix cannot be "let the sweep refund orphans". Once the job row is gone
 * the ledger cannot tell a FAILED job's charge from the charge of a DONE job
 * whose clips the user downloaded and then tidied away, and refunding the
 * second would hand back minutes that were spent successfully. The outcome is
 * only knowable while the row still exists, which is here.
 *
 * THE RULES ARE FINALIZE'S RULES, deliberately - see settleFreeLedger in the
 * worker. A FAILED job refunds in full, a DONE job that produced nothing takes
 * the once-per-account forgiveness, a DONE job with clips keeps its charge.
 * Deleting a project is not a settlement event of its own; it is the last
 * moment at which the settlement that was already owed can still be made.
 *
 * A JOB DELETED WHILE IT IS RUNNING IS TWO DIFFERENT CASES, and they split on
 * exactly one line: the TRANSCRIBE call, which is where money leaves the
 * account.
 *
 *   PENDING, DOWNLOADING      -> REFUNDED, in full and uncapped.
 *   TRANSCRIBING, ANALYZING,
 *   CUTTING                   -> the charge stands.
 *
 * Before TRANSCRIBE nothing has been spent. No OpenAI request has been made; we
 * are out a Job row, a queue entry and, at DOWNLOADING, some bandwidth. And
 * those two states are precisely the ones a person deletes from - paste the
 * wrong link, notice, press Delete, in the seconds before a worker gets to it.
 * Keeping the charge there took sixty minutes off a new account for a typo,
 * silently, with no sweep able to reach it afterwards because the job row was
 * about to be deleted. That is not a conservative error; it is the trial ending
 * before the user has seen anything at all.
 *
 * The docstring this replaces justified keeping the charge with a farming
 * attack: submit an hour, let it transcribe, delete, repeat. Read the attack
 * again - it needs the transcription. It is real from TRANSCRIBING onward and
 * that is why those states are unchanged, and it is not available at all before
 * the transcribe call, so refunding there opens nothing. The other argument,
 * that the outcome is unknown at the instant of deletion, is true of every
 * state including PENDING; what makes it decisive from TRANSCRIBING on is that
 * the spend is already real, not that the outcome is uncertain.
 *
 * The two live in one function rather than two so the boundary is stated once.
 * If a stage is ever added between DOWNLOAD and TRANSCRIBE, it belongs in
 * PRE_SPEND_STATUSES below only if it makes no paid API call.
 *
 * Refunding a FAILED job here does NOT need the sweep's six-hour silence
 * threshold, and that difference is real rather than an oversight. The
 * threshold exists because status FAILED is written on every BullMQ attempt, so
 * a job can look terminal with a retry still to come. Deletion removes the row
 * those attempts update: the next attempt cannot find the job and no attempt
 * can now succeed, which makes the delete itself the terminal event.
 *
 * Returns nothing and is a no-op for a paying account - both refunds begin with
 * findFreeCharge and return on null, so a paid job leaves free_usage untouched
 * by construction rather than by a plan check that could go stale.
 */
/**
 * The job states in which no money has been spent yet.
 *
 * Derived from where the OpenAI calls are, not from where the pipeline feels
 * early: DOWNLOAD fetches bytes and TRANSCRIBE is the first stage that bills.
 * Exported so a test can assert the boundary rather than restate it, and so the
 * next person adding a stage has one list to look at.
 */
export const PRE_SPEND_JOB_STATUSES = [
  "PENDING",
  "DOWNLOADING",
] as const satisfies readonly JobStatus[];

/**
 * Would deleting a job in this state cost the user seconds they would otherwise
 * keep?
 *
 * True for exactly the in-flight states past the transcribe call. Not for
 * PENDING or DOWNLOADING, which now refund. Not for DONE either: those seconds
 * were spent on a run that finished, and they are gone whether the project is
 * tidied away or left sitting there - a warning would be describing the past,
 * not the button. Not for FAILED, which refunds in full.
 *
 * It exists so the confirm dialog and settleFreeLedgerOnDelete cannot disagree
 * about which press costs something. A dialog that warns where the ledger
 * refunds trains people to ignore it.
 */
export function deleteForfeitsFreeSeconds(status: JobStatus): boolean {
  return (
    status !== "DONE" &&
    status !== "FAILED" &&
    !(PRE_SPEND_JOB_STATUSES as readonly JobStatus[]).includes(status)
  );
}

export async function settleFreeLedgerOnDelete(
  userId: string,
  jobId: string,
  job: { status: JobStatus; clipsGenerated: number }
): Promise<void> {
  const charge = await findFreeCharge(userId, jobId);
  if (!charge) return;

  if (job.status === "FAILED") {
    await refundFailedJob(userId, jobId);
    // Says "released", not "wrote a row": refundFailedJob is idempotent and
    // returns nothing, so this line cannot claim to be the write. The balance
    // is back either way, which is what the line is here to record.
    console.log(
      `[free-tier] delete of failed job ${jobId} for user ${userId}: ` +
        `${charge.seconds}s released (a no-op if finalize or the sweep got ` +
        `there first)`
    );
    return;
  }

  if (job.status === "DONE") {
    if (job.clipsGenerated === 0) {
      const forgiven = await refundZeroClipJob(userId, jobId);
      console.log(
        `[free-tier] delete of zero-clip job ${jobId} for user ${userId}: ` +
          (forgiven
            ? `forgave ${charge.seconds}s`
            : `forgiveness already spent, charge stands`)
      );
    }
    return;
  }

  if ((PRE_SPEND_JOB_STATUSES as readonly JobStatus[]).includes(job.status)) {
    await refundUnstartedJob(userId, jobId);
    console.log(
      `[free-tier] delete of ${job.status} job ${jobId} for user ${userId}: ` +
        `${charge.seconds}s released (nothing had been spent - the transcribe ` +
        `call had not happened)`
    );
    return;
  }

  // In flight and past the transcribe call. Greppable, because this is the one
  // branch that costs the user seconds without any refund path left afterwards -
  // the row the sweep would have needed is about to be deleted - and "why did my
  // minutes not come back" needs an answer in the logs.
  console.log(
    `[free-tier] job ${jobId} deleted by user ${userId} while ${job.status}; ` +
      `charge of ${charge.seconds}s stands (outcome unknown, spend already ` +
      `incurred at TRANSCRIBE)`
  );
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
