import { getPlanLimits } from "../config/plans";
import type { Plan, BillingCycle } from "@prisma/client";

/**
 * Compute the expiration timestamp for a newly created clip based on the
 * user's plan retention. Used at clip-insert time so the retention cleanup
 * job (Plan 2) can scan WHERE expiresAt <= NOW() AND deletedAt IS NULL.
 *
 * NONE is a real case now, not a defensive one: the free allowance lets a new
 * account produce clips before paying, and those clips live for the NONE
 * plan's retentionDays like any others.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeClipExpiresAt(
  plan: Plan,
  cycle: BillingCycle | null,
  createdAt: Date = new Date()
): Date {
  // Use UTC ms math so retention windows don't drift by 1h across DST
  // transitions on servers in TZ-aware locales.
  const days = getPlanLimits(plan, cycle ?? "MONTHLY").retentionDays;
  return new Date(createdAt.getTime() + days * MS_PER_DAY);
}

/** How long a job's source artifact survives after the job was created.
 *
 *  This is NOT a plan field and is deliberately not sold: nothing in the offer
 *  mentions the source video, only the clips. It is the window in which
 *  editing a clip is high quality - renderTrim cuts from the untouched source
 *  when Job.sourceArtifactKey is present, and falls back to re-trimming the
 *  finished clip file when it is not. The fallback is worse, not free: the clip
 *  already has subtitles burned in, so re-burning stacks text. Seven days is
 *  the compromise between that and the cost, which is not close: a clip is
 *  5-20 MB and a source is up to 2 GB.
 */
export const SOURCE_ARTIFACT_RETENTION_DAYS = 7;

/** How long a TERMINAL job keeps the copies of its source that nothing reads.
 *
 *  Job.sourceKey is read exactly once, by the download stage. The raw
 *  Job.sourceArtifactKey is read by nobody once normalization produced a
 *  separate file. Both are dead the moment the job stops running - the grace
 *  exists only so a manual re-run or a same-day incident investigation still
 *  has the input it needs.
 */
export const REDUNDANT_SOURCE_GRACE_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/** Jobs created before this instant are past the edit window. */
export function sourceArtifactCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - SOURCE_ARTIFACT_RETENTION_DAYS * MS_PER_DAY);
}

/** Terminal jobs created before this instant may lose their redundant copies. */
export function redundantSourceCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - REDUNDANT_SOURCE_GRACE_HOURS * MS_PER_HOUR);
}
