import { prisma } from "../lib/prisma";
import { deleteFile } from "../lib/r2";
import {
  redundantSourceCutoff,
  sourceArtifactCutoff,
} from "../lib/retention";

/** How many rows one rule touches per run.
 *
 *  A page, not the whole backlog: the sweep shares the finalize worker with
 *  real jobs, and an unbounded first run against a bucket nobody has ever
 *  cleaned would hold the R2 client for as long as it takes. A backlog drains
 *  over successive hours instead, which is fine - nothing here is urgent.
 */
export const SWEEP_PAGE_SIZE = 200;

export interface SweepOptions {
  /** Log what would happen, touch neither R2 nor the database. */
  dryRun?: boolean;
}

export interface SweepCounts {
  swept: number;
  failed: number;
}

/** Terminal job states. A job that is still running owns its input, however
 *  old it is - deleting the source of a stuck job guarantees it can never
 *  resume. */
const TERMINAL_STATUSES = ["DONE", "FAILED"] as const;

/** Delete an R2 object, reporting success rather than throwing.
 *
 *  S3 DeleteObject is idempotent - deleting a key that is not there succeeds -
 *  so "already gone" and "just deleted" are the same answer, which is what the
 *  caller wants: both mean the column may be nulled.
 */
async function dropObject(key: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) return true;
  try {
    await deleteFile(key);
    return true;
  } catch (error) {
    console.error(`[retention] failed to delete ${key}:`, error);
    return false;
  }
}

/**
 * Rule A: clips past their plan's retention.
 *
 * Soft delete, not a row delete: usage.service counts stored clips as
 * `deletedAt: null`, so stamping the column is what frees the user's quota,
 * and the row keeps the history that the analytics page reads. storageKey
 * stays too - it costs nothing and it is the only way to tell later which
 * object a row used to own.
 */
export async function sweepExpiredClips(
  now: Date = new Date(),
  options: SweepOptions = {}
): Promise<SweepCounts> {
  const dryRun = options.dryRun ?? false;
  const clips = await prisma.clip.findMany({
    where: { expiresAt: { lte: now }, deletedAt: null },
    select: { id: true, storageKey: true },
    // Deterministic paging: without an orderBy, take: SWEEP_PAGE_SIZE gets
    // whatever arbitrary page Postgres feels like returning.
    orderBy: { expiresAt: "asc" },
    take: SWEEP_PAGE_SIZE,
  });

  let swept = 0;
  let failed = 0;

  for (const clip of clips) {
    // An empty storageKey is a real case, not a defensive one: editClip
    // inserts the row with "" and an expiresAt before the render has produced
    // anything. Sending "" to S3 is a malformed request, not a no-op.
    if (clip.storageKey && !(await dropObject(clip.storageKey, dryRun))) {
      failed++;
      continue;
    }
    if (!dryRun) {
      await prisma.clip.update({
        where: { id: clip.id },
        data: { deletedAt: now },
      });
    }
    swept++;
  }

  return { swept, failed };
}

/**
 * Rule B: the copies of the source that nothing reads.
 *
 * A job can hold the same video three times: Job.sourceKey (what the user
 * uploaded, read once by the download stage), Job.sourceArtifactKey (the
 * worker's own copy of those same bytes) and Job.normalizedArtifactKey (the
 * only one transcribe, render and the editor ever read). For an uploaded file
 * the first two are byte-identical. Once the job is terminal and past the
 * grace, both are dead weight - this rule drops them and keeps the normalized
 * artifact for the edit window, which is Rule C's business.
 *
 * The stamp is not bookkeeping, it is the termination condition. When
 * normalizeSource returned "none" the source artifact IS the normalized one,
 * so this rule finds nothing to delete on that job - and without the stamp the
 * job would match the selector again on every hourly run for ever, eventually
 * filling the page with rows that have no work left in them.
 */
export async function sweepRedundantSourceCopies(
  now: Date = new Date(),
  options: SweepOptions = {}
): Promise<SweepCounts> {
  const dryRun = options.dryRun ?? false;
  const cutoff = redundantSourceCutoff(now);
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: [...TERMINAL_STATUSES] },
      createdAt: { lt: cutoff },
      sourceSweptAt: null,
      // FAILED is written on EVERY BullMQ attempt, not just the last one, so
      // a job mid-retry can look terminal while attempt 2 is about to re-read
      // sourceKey. processingStartedAt is refreshed at the start of every
      // attempt, so "not touched since the cutoff" is the reliable signal
      // that no attempt is currently in flight.
      OR: [
        { processingStartedAt: null },
        { processingStartedAt: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      sourceKey: true,
      sourceArtifactKey: true,
      normalizedArtifactKey: true,
    },
    orderBy: { createdAt: "asc" },
    take: SWEEP_PAGE_SIZE,
  });

  let swept = 0;
  let failed = 0;

  for (const job of jobs) {
    // Incremental, not all-or-nothing: a column is nulled the moment its own
    // delete is confirmed, independent of whether the other key's delete
    // fails. Otherwise a confirmed-deleted object is left behind a live
    // column - exactly the state the invariant forbids.
    const patch: {
      sourceKey?: null;
      sourceArtifactKey?: null;
      sourceSweptAt?: Date;
    } = {};
    let ok = true;

    if (job.sourceKey) {
      if (await dropObject(job.sourceKey, dryRun)) patch.sourceKey = null;
      else ok = false;
    }

    // The guard that matters: when the two columns hold the same string, this
    // key is the live source, not a copy of it. A null normalizedArtifactKey
    // means there is no normalized copy at all, so sourceArtifactKey is the
    // ONLY source a consumer can fall back to (normalizedArtifactKey ??
    // sourceArtifactKey) - never treat "different from null" as "safe to
    // delete".
    if (
      job.sourceArtifactKey &&
      job.normalizedArtifactKey != null &&
      job.sourceArtifactKey !== job.normalizedArtifactKey
    ) {
      if (await dropObject(job.sourceArtifactKey, dryRun)) {
        patch.sourceArtifactKey = null;
      } else {
        ok = false;
      }
    }

    if (ok) {
      // The stamp is the termination condition - only write it once nothing
      // failed, so a partial failure keeps the row selectable next hour.
      patch.sourceSweptAt = now;
      swept++;
    } else {
      failed++;
    }

    if (!dryRun && Object.keys(patch).length > 0) {
      await prisma.job.update({ where: { id: job.id }, data: patch });
    }
  }

  return { swept, failed };
}

/**
 * Rule C: the edit window is over.
 *
 * Everything the job still holds goes. Editing a clip from a job this old
 * still works - renderTrim branches on the PRESENCE of the column and falls
 * back to re-trimming the finished clip file - which is exactly why the
 * columns are nulled in the same write that deletes the objects. A column
 * pointing at a deleted object is the one state that turns a degradation into
 * a failure.
 *
 * This rule needs no stamp: it nulls every key it selects on, so a swept job
 * cannot match the selector again.
 */
export async function sweepExpiredArtifacts(
  now: Date = new Date(),
  options: SweepOptions = {}
): Promise<SweepCounts> {
  const dryRun = options.dryRun ?? false;
  const cutoff = sourceArtifactCutoff(now);
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: [...TERMINAL_STATUSES] },
      createdAt: { lt: cutoff },
      // Two OR conditions can't share one where object, so both live under
      // AND: "still holds a key" and, per the same reasoning as Rule B, "not
      // touched by a worker since the cutoff" (a FAILED job can be mid-retry).
      AND: [
        {
          OR: [
            { sourceKey: { not: null } },
            { sourceArtifactKey: { not: null } },
            { normalizedArtifactKey: { not: null } },
          ],
        },
        {
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lt: cutoff } },
          ],
        },
      ],
    },
    select: {
      id: true,
      sourceKey: true,
      sourceArtifactKey: true,
      normalizedArtifactKey: true,
    },
    orderBy: { createdAt: "asc" },
    take: SWEEP_PAGE_SIZE,
  });

  let swept = 0;
  let failed = 0;

  for (const job of jobs) {
    // A Set: "none" normalization puts the same key in two columns, and a
    // second DeleteObject for a key we just removed is a wasted round trip.
    const keys = [
      ...new Set(
        [
          job.sourceKey,
          job.sourceArtifactKey,
          job.normalizedArtifactKey,
        ].filter((key): key is string => Boolean(key))
      ),
    ];

    // Incremental, not all-or-nothing: track which keys' deletes were
    // actually confirmed, then null every column that holds one of them - the
    // same key string can live in two columns (the "none" normalization
    // case), so both must be nulled together when that one delete succeeds.
    const confirmed = new Set<string>();
    let ok = true;
    for (const key of keys) {
      if (await dropObject(key, dryRun)) confirmed.add(key);
      else ok = false;
    }

    const patch: {
      sourceKey?: null;
      sourceArtifactKey?: null;
      normalizedArtifactKey?: null;
    } = {};
    if (job.sourceKey && confirmed.has(job.sourceKey)) patch.sourceKey = null;
    if (job.sourceArtifactKey && confirmed.has(job.sourceArtifactKey)) {
      patch.sourceArtifactKey = null;
    }
    if (job.normalizedArtifactKey && confirmed.has(job.normalizedArtifactKey)) {
      patch.normalizedArtifactKey = null;
    }

    if (ok) swept++;
    else failed++;

    if (!dryRun && Object.keys(patch).length > 0) {
      await prisma.job.update({ where: { id: job.id }, data: patch });
    }
  }

  return { swept, failed };
}

export interface RetentionSweepResult {
  clips: SweepCounts;
  redundantSources: SweepCounts;
  expiredArtifacts: SweepCounts;
  dryRun: boolean;
}

/**
 * One pass of every rule, in cheapest-first order.
 *
 * RETENTION_SWEEP_LIVE guards irreversible deletion of user data, so it fails
 * CLOSED: it is an opt-IN to deleting, not an opt-out of it. Deleting happens
 * only when the variable is set to a non-empty value - unset, empty, or
 * absent are all a dry run that reports and writes nothing. The prior flag
 * read the opposite way (Boolean(RETENTION_SWEEP_DRY_RUN)) and failed OPEN:
 * `RETENTION_SWEEP_DRY_RUN=` - an empty value, exactly what a copied
 * .env.example produces - reads as falsy and ran live against real objects.
 * Naming the variable for the destructive branch means a typo or a
 * half-filled .env can only ever land on "report", never on "delete". It is
 * read per run, not cached, so flipping it does not need a redeploy.
 */
export async function runRetentionSweep(
  now: Date = new Date()
): Promise<RetentionSweepResult> {
  const live = Boolean(process.env.RETENTION_SWEEP_LIVE);
  const dryRun = !live;
  const options: SweepOptions = { dryRun };

  const clips = await sweepExpiredClips(now, options);
  const redundantSources = await sweepRedundantSourceCopies(now, options);
  const expiredArtifacts = await sweepExpiredArtifacts(now, options);

  const prefix = dryRun ? "[retention][dry-run]" : "[retention]";
  const summary =
    `${prefix} clips ${clips.swept}/${clips.failed} failed, ` +
    `redundant sources ${redundantSources.swept}/${redundantSources.failed} failed, ` +
    `expired artifacts ${expiredArtifacts.swept}/${expiredArtifacts.failed} failed`;
  const anyFailed =
    clips.failed > 0 || redundantSources.failed > 0 || expiredArtifacts.failed > 0;
  // A revoked R2 credential makes every delete fail forever - buried in
  // console.log that reads as routine noise. Non-zero failed makes it loud.
  if (anyFailed) {
    console.error(summary);
  } else {
    console.log(summary);
  }

  return { clips, redundantSources, expiredArtifacts, dryRun };
}
