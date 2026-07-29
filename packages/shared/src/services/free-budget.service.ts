import { prisma } from "../lib/prisma";

export interface FreeBudgetStatus {
  /** True only when a usable ceiling is configured AND it is not yet reached. */
  open: boolean;
  /** Month-to-date CHARGE spend in USD. Never null, never NaN. */
  spentUsd: number;
  /** The configured ceiling, normalised to a finite number >= 0. */
  ceilingUsd: number;
}

/** Raw values already complained about, so a per-submit call cannot spam. */
const warnedRawValues = new Set<string>();

/**
 * FREE_TIER_MONTHLY_BUDGET_USD as a number we are willing to spend against.
 *
 * Anything that is not a finite positive number becomes 0, which reads as "free
 * plan off". The coercions were measured on the actual Node 20 runtime rather
 * than assumed, because they are not uniform:
 *
 *   unset      Number(undefined) -> NaN       -> 0
 *   "" or " "  Number("")        -> 0         -> 0
 *   "abc"                        -> NaN       -> 0
 *   "50,00"                      -> NaN       -> 0   (European decimal comma)
 *   "-5"                         -> -5        -> 0
 *   "1e999"                      -> Infinity  -> 0   <- the one that matters
 *   " 50 "                       -> 50        -> 50
 *
 * `Number.isFinite` is the load-bearing guard here, NOT a `?? 0` on the env
 * read. `?? 0` only rewrites the unset case, and the unset case is already safe
 * without it because NaN > 0 is false. Infinity is the value that is not safe
 * by accident: it is greater than every possible spend, so a bare `ceiling > 0`
 * check turns a fat-fingered exponent into a literally unbounded free tier -
 * the single outcome this module exists to prevent. Delete the isFinite call
 * and that door reopens.
 *
 * Negatives are clamped to 0 rather than returned as-is so `ceilingUsd` is
 * always something a caller can display or subtract from.
 */
function readCeilingUsd(): number {
  const raw = process.env.FREE_TIER_MONTHLY_BUDGET_USD;
  const parsed = Number(raw);

  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  // A value that was set but cannot be used is a typo, and its consequence -
  // the free plan quietly off - is indistinguishable from the intended
  // rollback. Say it once. Silence here costs a support round trip.
  if (raw !== undefined && parsed !== 0) {
    if (!warnedRawValues.has(raw)) {
      warnedRawValues.add(raw);
      console.warn(
        `[free-budget] FREE_TIER_MONTHLY_BUDGET_USD=${JSON.stringify(raw)} ` +
          `is not a usable ceiling; treating it as 0 and keeping the free plan off.`
      );
    }
  }

  return 0;
}

/**
 * The month's free-plan spend against the ceiling.
 *
 * This is what makes the free plan structurally unable to bankrupt anyone,
 * whatever the per-account numbers are tuned to and however well a farmer
 * defeats the anchor. The anchor sets the slope; this sets the maximum. An
 * unset or unparseable ceiling reads as 0 - closed - because the failure
 * direction has to be "no free tier", never "unlimited free tier".
 *
 * Deliberately global: no userId. A per-account cap is what the ledger already
 * does. This is the only thing that bounds the sum over accounts an attacker
 * can mint, so scoping it to anyone would defeat its whole purpose.
 *
 * The month is a UTC month. The owner is in Riga (UTC+2/+3), which rolls into a
 * new month two to three hours BEFORE UTC does, so for that window the ceiling
 * is still counting the month that just ended on his wall clock. That errs
 * closed - the budget resets late, never early - and a cap whose boundary
 * silently moved with a DST change would be worse than one that is two hours
 * behind twice a year.
 */
export async function freeBudgetStatus(): Promise<FreeBudgetStatus> {
  const ceilingUsd = readCeilingUsd();

  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  // CHARGE only, on purpose. Refund rows are written with estimatedCostUsd 0
  // precisely so the money a refunded run really spent stays visible here: the
  // allowance goes back to the user, the OpenAI invoice does not. Widening this
  // to every kind would make our own breakage buy a farmer free capacity, and
  // it would also let a future non-zero refund row cancel a real charge out of
  // the month's total. Scoped rather than merely redundant.
  const result = await prisma.freeUsage.aggregate({
    where: { kind: "CHARGE", createdAt: { gte: monthStart } },
    _sum: { estimatedCostUsd: true },
  });

  // Verified against real Postgres: with no matching rows - which is every
  // first-of-the-month - `_sum.estimatedCostUsd` comes back as literal null,
  // not 0. Note what that null does NOT do: `null < 50` is true in JavaScript,
  // so dropping this coalesce would not close the trial. It would leak a null
  // into a public `spentUsd` field, where a caller formatting it or subtracting
  // it gets a crash or a silent 0. Keep it for that reason, not for the gate.
  const spentUsd = result._sum.estimatedCostUsd ?? 0;

  return {
    // The `ceilingUsd > 0` is redundant against readCeilingUsd today and stays
    // anyway: it makes "ceiling of zero means closed" true at this line rather
    // than only true two functions away.
    open: ceilingUsd > 0 && spentUsd < ceilingUsd,
    spentUsd,
    ceilingUsd,
  };
}
