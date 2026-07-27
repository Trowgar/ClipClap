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
