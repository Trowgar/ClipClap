/**
 * Exports a job's clips as a rating sheet: metadata, the words the viewer
 * actually hears, and a signed URL to the rendered file.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-rating-sheet.ts <jobId> [ttlSeconds]"
 *
 * Prints JSON to stdout. The clip TEXT is exported alongside the video on
 * purpose: a human rates the video, and the automatic judge being calibrated
 * against those ratings sees only the text - so both halves of the comparison
 * have to come out of the same export, or they are not about the same clip.
 */
import { getPresignedDownloadUrl, prisma } from "@clipclap/shared";

interface Segment {
  start: number;
  end: number;
  text: string;
}

async function main() {
  const [jobId, ttlArg] = process.argv.slice(2);
  if (!jobId) {
    console.error("usage: eval-rating-sheet.ts <jobId> [ttlSeconds]");
    process.exit(1);
  }
  // S3 sigv4 caps a presigned URL at 7 days; default to 6 so a sheet opened on
  // the day it is made is still playable at the end of the week.
  const ttl = Number(ttlArg) || 6 * 24 * 3600;

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { id: true, originalFilename: true, transcriptJson: true, language: true },
  });

  const clips = await prisma.clip.findMany({
    where: { jobId, deletedAt: null },
    orderBy: { startTime: "asc" },
    select: {
      id: true,
      title: true,
      description: true,
      duration: true,
      startTime: true,
      endTime: true,
      score: true,
      clipKind: true,
      storageKey: true,
      lowQuality: true,
    },
  });

  const transcript = job.transcriptJson as { segments?: Segment[] } | null;
  const segments = transcript?.segments ?? [];

  const rows = [];
  for (const clip of clips) {
    // Any segment that overlaps the clip window - the viewer hears a segment
    // that straddles the boundary, so an inclusion test on start alone would
    // export less speech than the clip contains.
    const text = segments
      .filter((s) => s.end > clip.startTime && s.start < clip.endTime)
      .map((s) => s.text.trim())
      .join(" ")
      .trim();
    rows.push({
      id: clip.id,
      title: clip.title,
      description: clip.description,
      start: clip.startTime,
      end: clip.endTime,
      duration: clip.duration,
      score: clip.score,
      kind: clip.clipKind,
      lowQuality: clip.lowQuality,
      text,
      url: await getPresignedDownloadUrl(clip.storageKey, ttl),
    });
  }

  console.log(
    JSON.stringify(
      { jobId: job.id, source: job.originalFilename, language: job.language, clips: rows },
      null,
      2
    )
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
