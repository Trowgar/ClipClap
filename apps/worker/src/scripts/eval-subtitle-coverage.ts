/**
 * Acceptance metric for the subtitle word restore.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-subtitle-coverage.ts"
 *
 * Does the burned caption carry the whole sentence the speaker said?
 *
 * **It measures the CUES, not the transcript, and that distinction is the whole
 * point.** The repair runs when cues are built and never rewrites
 * `transcriptJson`, so a script that re-read `words[]` would report the same
 * number on a repaired engine as on a broken one. That mistake was made once
 * while designing this and is recorded here so it is not made again.
 *
 * Read-only: opens no video, writes nothing, touches no job.
 *
 * Measured on 2026-08-05, 16 jobs and 114 clips:
 *   before the repair   135 of 1265 incomplete   (10.7%)
 *   after               2 of 1265                (0.2%)
 * The two survivors are `unresolved` - text missing at BOTH ends of the
 * segment, which the repair deliberately declines to guess at.
 */
import { prisma } from "@clipclap/shared";
import type { WhisperSegment } from "@clipclap/shared";
import { Prisma } from "@prisma/client";
import { comparableText, segmentsToCues } from "../processors/subtitles";

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      clips: { some: { deletedAt: null } },
      // Prisma needs DbNull rather than null to filter a nullable Json column;
      // `not: null` compiles under tsx and fails tsc, which is how it slipped
      // through the throwaway versions of this script.
      transcriptJson: { not: Prisma.DbNull },
    },
    select: {
      id: true,
      language: true,
      transcriptJson: true,
      clips: {
        where: { deletedAt: null },
        select: { startTime: true, endTime: true },
      },
    },
  });

  let occurrences = 0;
  let complete = 0;
  const offenders: string[] = [];

  for (const job of jobs) {
    const segments = ((job.transcriptJson as { segments?: WhisperSegment[] })
      ?.segments ?? []) as WhisperSegment[];
    for (const clip of job.clips) {
      const cues = segmentsToCues(segments, clip.startTime, clip.endTime);
      for (const segment of segments) {
        if (!(segment.end > clip.startTime && segment.start < clip.endTime)) {
          continue;
        }
        // Partially-overlapping segments are excluded: the window clips them by
        // design, and that is not a loss.
        if (segment.start < clip.startTime || segment.end > clip.endTime) {
          continue;
        }
        // A segment with no word timings takes the fallback path, which has
        // always drawn `s.text` whole. Nothing to repair, nothing to measure.
        if (!segment.words || segment.words.length === 0) continue;

        occurrences += 1;
        const segStart = segment.start - clip.startTime;
        const segEnd = segment.end - clip.startTime;
        const mine = cues.filter(
          (c) => c.start >= segStart - 1e-6 && c.end <= segEnd + 1e-6
        );
        const drawn = comparableText(mine.map((c) => c.text).join(""));
        if (drawn === comparableText(segment.text)) {
          complete += 1;
        } else if (offenders.length < 20) {
          offenders.push(
            `${job.id} ${job.language ?? "?"} ${JSON.stringify(segment.text.trim())}`
          );
        }
      }
    }
  }

  const incomplete = occurrences - complete;
  console.log(`jobs / clips                  : ${jobs.length} / ${jobs.reduce((n, j) => n + j.clips.length, 0)}`);
  console.log(`segment occurrences measured  : ${occurrences}`);
  console.log(`cue text carries the sentence : ${complete}`);
  console.log(
    `cue text INCOMPLETE           : ${incomplete}` +
      (occurrences > 0 ? `  (${((100 * incomplete) / occurrences).toFixed(1)}%)` : "")
  );
  if (offenders.length > 0) {
    console.log("\nremaining:");
    for (const offender of offenders) console.log("  " + offender);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
