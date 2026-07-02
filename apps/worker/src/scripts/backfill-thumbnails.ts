/**
 * Backfill dashboard thumbnails for jobs created before the thumbnail feature.
 *
 * For every job that has a source artifact but no thumbnail yet, download the
 * original video, extract a 16:9 still (at the first clip / highlight so it is
 * on-content), upload it, and record the key. Best-effort and idempotent: safe
 * to re-run - jobs that already have a thumbnailKey are skipped.
 *
 * Usage (inside the worker container):
 *   docker compose exec -w /app/apps/worker worker-render \
 *     npx tsx src/scripts/backfill-thumbnails.ts [maxJobs]
 */
import { prisma, uploadFile } from "@clipclap/shared";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import { downloadVideo } from "../processors/download";
import { generateThumbnail } from "../processors/thumbnail";

// Fall back to a few seconds in when we have no clip/highlight timing, to skip
// a likely black/intro first frame. The `thumbnail` filter refines from there.
const DEFAULT_OFFSET_SEC = 3;

function firstHighlightStart(highlights: unknown): number | null {
  if (!Array.isArray(highlights)) return null;
  const first = highlights[0];
  if (first && typeof first === "object" && "start" in first) {
    const start = (first as { start: unknown }).start;
    if (typeof start === "number" && Number.isFinite(start)) return start;
  }
  return null;
}

async function main() {
  const maxJobs = Number(process.argv[2]) || Infinity;

  const jobs = await prisma.job.findMany({
    where: { thumbnailKey: null, sourceArtifactKey: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      sourceArtifactKey: true,
      highlights: true,
      clips: {
        orderBy: { startTime: "asc" },
        take: 1,
        select: { startTime: true },
      },
    },
  });

  const targets = jobs.slice(0, maxJobs);
  console.log(
    `[backfill-thumbnails] ${targets.length} job(s) to process` +
      (jobs.length > targets.length ? ` (of ${jobs.length} eligible)` : "")
  );

  let done = 0;
  let failed = 0;

  for (const job of targets) {
    const tempFiles: string[] = [];
    const atSeconds =
      job.clips[0]?.startTime ?? firstHighlightStart(job.highlights) ?? DEFAULT_OFFSET_SEC;

    try {
      const sourcePath = await downloadVideo(undefined, job.sourceArtifactKey!);
      tempFiles.push(sourcePath);
      const thumbPath = await generateThumbnail(sourcePath, atSeconds);
      tempFiles.push(thumbPath);

      const thumbnailKey = `work/${job.userId}/${job.id}/thumb-${randomUUID()}.jpg`;
      await uploadFile(thumbnailKey, thumbPath, "image/jpeg");
      await prisma.job.update({
        where: { id: job.id },
        data: { thumbnailKey },
      });

      done += 1;
      console.log(`[backfill-thumbnails] ${job.id} -> ${thumbnailKey}`);
    } catch (error) {
      failed += 1;
      console.error(`[backfill-thumbnails] ${job.id} FAILED:`, error);
    } finally {
      await Promise.all(tempFiles.map((f) => unlink(f).catch(() => {})));
    }
  }

  console.log(`[backfill-thumbnails] done: ${done}, failed: ${failed}`);
  await prisma.$disconnect();
  process.exit(failed > 0 && done === 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("[backfill-thumbnails] fatal:", error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
