/**
 * Acceptance metric for the subtitle word restore, and the four claims that
 * stand beside it. Every figure below comes out of one run over one corpus.
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
 * The BEFORE figure needs no old code: the pre-repair cue text was built from
 * `words[]` alone, so the text it drew for a segment is exactly that segment's
 * windowed word tokens joined. Both columns therefore come out of one run over
 * one corpus, and neither is quoted from memory.
 *
 * **Known blind spot, stated because it is load-bearing:** `comparableText`
 * strips punctuation and whitespace, so section 1 cannot see punctuation lost at
 * a seam. Section 4 closes that with an exact-character subsequence check.
 *
 * Read-only: opens no video, writes nothing, touches no job.
 */
import { prisma } from "@clipclap/shared";
import type { WhisperSegment } from "@clipclap/shared";
import { Prisma } from "@prisma/client";
import {
  comparableText,
  restoreDroppedWords,
  segmentsToCues,
  splitAtComparable,
  summariseRestores,
} from "../processors/subtitles";

/** What the pre-repair engine drew for one segment: its windowed word tokens,
 *  joined the way `chunkWords` joins them. No old code needed - that path built
 *  cue text from `words[]` and never looked at `s.text`. */
function drawnBeforeRepair(
  segment: WhisperSegment,
  clipStart: number,
  clipEnd: number
): string {
  return (segment.words ?? [])
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => w.text)
    .join(" ");
}

const stripSpace = (value: string) => value.replace(/\s+/gu, "");

/** Every character of `needle`, in order, somewhere in `haystack`. Tolerant of
 *  the repair deliberately dropping punctuation the boundary word already
 *  carries, and of Whisper's own tokens omitting punctuation - but not of a
 *  character in the seam simply vanishing, which is what it is here to catch. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (i < needle.length && ch === needle[i]) i += 1;
  }
  return i === needle.length;
}

/** The raw seam-and-span slice the repair had to place, or null when the
 *  segment lost nothing or lost text at both ends. Mirrors the branch selection
 *  inside `restoreDroppedWords` without duplicating its placement rules. */
function rawSpanFor(segment: WhisperSegment): string | null {
  const words = segment.words ?? [];
  if (words.length === 0) return null;
  const flatText = comparableText(segment.text);
  const flatWords = comparableText(words.map((w) => w.text).join(""));
  if (flatText === flatWords) return null;
  const textChars = [...flatText].length;
  const wordChars = [...flatWords].length;
  if (flatText.startsWith(flatWords)) {
    return splitAtComparable(segment.text, wordChars)[1];
  }
  if (flatText.endsWith(flatWords)) {
    return splitAtComparable(segment.text, textChars - wordChars)[0];
  }
  return null; // unresolved - the repair declines it, so nothing was placed
}

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
  let completeBefore = 0;
  let completeAfter = 0;
  let unchangedWhereNothingWasLost = 0;
  let changedWhereNothingWasLost = 0;
  let charactersLostAtASeam = 0;
  const stillIncomplete: string[] = [];
  const uniqueSegments = new Set<string>();
  const telemetry = {
    segmentOccurrences: 0,
    restoredHead: 0,
    restoredTail: 0,
    unresolved: 0,
    merged: 0,
  };

  for (const job of jobs) {
    const segments = ((job.transcriptJson as { segments?: WhisperSegment[] })
      ?.segments ?? []) as WhisperSegment[];

    for (const clip of job.clips) {
      const cues = segmentsToCues(segments, clip.startTime, clip.endTime);

      const summary = summariseRestores(segments, clip.startTime, clip.endTime);
      telemetry.segmentOccurrences += summary.segmentOccurrences;
      telemetry.restoredHead += summary.restoredHead;
      telemetry.restoredTail += summary.restoredTail;
      telemetry.unresolved += summary.unresolved;
      telemetry.merged += summary.merged;

      for (const [index, segment] of segments.entries()) {
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
        uniqueSegments.add(`${job.id}#${index}`);

        const segStart = segment.start - clip.startTime;
        const segEnd = segment.end - clip.startTime;
        const mine = cues.filter(
          (c) => c.start >= segStart - 1e-6 && c.end <= segEnd + 1e-6
        );
        const after = mine.map((c) => c.text).join(" ");
        const before = drawnBeforeRepair(segment, clip.startTime, clip.endTime);
        const sentence = comparableText(segment.text);

        const wasComplete = comparableText(before) === sentence;
        const isComplete = comparableText(after) === sentence;
        if (wasComplete) completeBefore += 1;
        if (isComplete) completeAfter += 1;
        else if (stillIncomplete.length < 20) {
          const { outcome } = restoreDroppedWords(
            segment.text,
            segment.words,
            segment.start,
            segment.end
          );
          stillIncomplete.push(
            `${outcome.padEnd(11)} ${job.language ?? "?"} ${JSON.stringify(
              segment.text.trim()
            )}`
          );
        }

        // A segment that lost nothing must be drawn EXACTLY as before - not
        // merely equivalently. This is the 89.3% of the corpus the repair must
        // not touch, and it is checked character by character rather than
        // through the punctuation-blind comparable form.
        if (wasComplete) {
          if (after === before) unchangedWhereNothingWasLost += 1;
          else changedWhereNothingWasLost += 1;
        }

        // The blind spot: `comparableText` deletes punctuation, so section 1
        // cannot see a seam that drops a dash.
        //
        // The check is narrow on purpose. Comparing the drawn text against the
        // whole transcript would fail 1187 of these occurrences and mean
        // nothing: Whisper routinely leaves punctuation out of its own word
        // tokens, so "Hello, world." draws without its comma and always has.
        // What must hold is that nothing the engine had, or the repair fetched,
        // disappears - so both the old drawn text and the raw seam-and-span
        // slice must survive into the output, in order.
        const raw = rawSpanFor(segment);
        if (
          !isSubsequence(stripSpace(before), stripSpace(after)) ||
          (raw !== null && !isSubsequence(stripSpace(raw), stripSpace(after)))
        ) {
          charactersLostAtASeam += 1;
        }
      }
    }
  }

  const clipCount = jobs.reduce((n, j) => n + j.clips.length, 0);
  const incompleteBefore = occurrences - completeBefore;
  const incompleteAfter = occurrences - completeAfter;
  const pct = (n: number) =>
    occurrences > 0 ? `${((100 * n) / occurrences).toFixed(1)}%` : "-";

  console.log(`corpus                          : ${jobs.length} jobs, ${clipCount} clips`);
  console.log(`segment occurrences measured    : ${occurrences}`);
  console.log("");
  console.log("1. the acceptance number");
  console.log(`   incomplete BEFORE the repair : ${incompleteBefore}  (${pct(incompleteBefore)})`);
  console.log(`   incomplete AFTER             : ${incompleteAfter}  (${pct(incompleteAfter)})`);
  console.log("");
  console.log("2. segments that lost nothing are drawn byte-identically");
  console.log(`   complete before the repair   : ${completeBefore}`);
  console.log(`   of those, drawn unchanged    : ${unchangedWhereNothingWasLost}`);
  console.log(`   of those, drawn differently  : ${changedWhereNothingWasLost}  (must be 0)`);
  console.log("");
  console.log("3. what remains, and why it is not masked");
  if (stillIncomplete.length === 0) console.log("   none");
  for (const line of stillIncomplete) console.log(`   ${line}`);
  console.log("");
  console.log("4. nothing at the seam vanishes - the check section 1 cannot make");
  console.log(`   occurrences losing a character: ${charactersLostAtASeam}  (must be 0)`);
  console.log("");
  console.log("5. telemetry counts (clip, segment) pairs, not unique segments");
  console.log(`   segmentOccurrences            : ${telemetry.segmentOccurrences}`);
  console.log(`   unique source segments        : ${uniqueSegments.size}`);
  console.log(`   double-counted by a second clip: ${telemetry.segmentOccurrences - uniqueSegments.size}`);
  console.log(
    `   head ${telemetry.restoredHead}, tail ${telemetry.restoredTail}, merged ${telemetry.merged}, unresolved ${telemetry.unresolved}`
  );

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
