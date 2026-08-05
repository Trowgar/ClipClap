/**
 * Acceptance metric for the subtitle chunker.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-subtitle-cues.ts"
 *
 * Is each burned cue a line someone can read, or a word flashing on its own?
 *
 * Both columns come out of one run over one corpus. The BEFORE column needs no
 * old code: the greedy fill this replaced is fifteen lines and is reproduced
 * below verbatim, so the comparison is against the algorithm rather than
 * against a number quoted from a previous session.
 *
 * The cue COUNT is the load-bearing control. The chunker was changed to pick a
 * different split, never a different number of splits, so if the two columns
 * ever disagree on cue count the change has altered the pace of the subtitles
 * and the rest of the table is not a like-for-like comparison.
 *
 * Read-only: opens no video, writes nothing, touches no job.
 */
import { prisma } from "@clipclap/shared";
import type { SubtitleWord, WhisperSegment } from "@clipclap/shared";
import { Prisma } from "@prisma/client";
import { chunkWords, segmentsToCues } from "../processors/subtitles";

const MAX_CHUNK_WORDS = 3;
const MAX_CHUNK_CHARS = 18;

/** The chunker as it stood before 2026-08-05: fill each cue to the limit, then
 *  start the next one. Kept here, and only here, as the baseline. */
function greedyChunk(words: SubtitleWord[]): SubtitleWord[][] {
  const chunks: SubtitleWord[][] = [];
  let current: SubtitleWord[] = [];
  let chars = 0;
  for (const word of words) {
    const addition = word.text.length + (current.length > 0 ? 1 : 0);
    if (
      current.length > 0 &&
      (current.length >= MAX_CHUNK_WORDS || chars + addition > MAX_CHUNK_CHARS)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(word);
    chars += word.text.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface Cue {
  words: number;
  chars: number;
  shown: number;
  weakBreak: boolean;
}

const ENDS_CLAUSE = /[.,!?;:…][")'»\]]?$/u;
const weight = (t: string) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length;

function describe(
  chunks: SubtitleWord[][],
  segStart: number,
  segEnd: number
): Cue[] {
  return chunks.map((chunk, i) => {
    const next = chunks[i + 1];
    const start = i === 0 ? segStart : chunk[0].start;
    const end = next ? next[0].start : segEnd;
    const last = chunk[chunk.length - 1].text;
    return {
      words: chunk.length,
      chars: chunk.map((w) => w.text).join(" ").length,
      shown: end - start,
      weakBreak:
        i < chunks.length - 1 && !ENDS_CLAUSE.test(last) && weight(last) <= 2,
    };
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function row(label: string, cues: Cue[]): string {
  const n = cues.length;
  const p = (k: number) => (n > 0 ? `${((100 * k) / n).toFixed(1)}%` : "-");
  const one = cues.filter((c) => c.words === 1).length;
  const flash = cues.filter((c) => c.shown < 0.35).length;
  const oneFlash = cues.filter((c) => c.words === 1 && c.shown < 0.5).length;
  const weak = cues.filter((c) => c.weakBreak).length;
  const over = cues.filter((c) => c.chars > MAX_CHUNK_CHARS && c.words > 1).length;
  return [
    label.padEnd(8),
    `cues ${String(n).padStart(5)}`,
    `one word ${p(one).padStart(6)}`,
    `under 0.35s ${p(flash).padStart(6)}`,
    `one word AND under 0.5s ${p(oneFlash).padStart(6)}`,
    `weak break ${p(weak).padStart(6)}`,
    `over ${MAX_CHUNK_CHARS} chars ${String(over).padStart(3)}`,
    `median shown ${median(cues.map((c) => c.shown)).toFixed(2)}s`,
  ].join(" | ");
}

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      clips: { some: { deletedAt: null } },
      // Prisma needs DbNull rather than null to filter a nullable Json column.
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

  const before: Cue[] = [];
  const after: Cue[] = [];
  let wordless = 0;
  let segmentOccurrences = 0;
  const reshaped: string[] = [];

  for (const job of jobs) {
    const segments = ((job.transcriptJson as { segments?: WhisperSegment[] })
      ?.segments ?? []) as WhisperSegment[];

    for (const clip of job.clips) {
      // Cues from the live pipeline, so the word restore shipped alongside this
      // is included and the two columns differ only in how they are chunked.
      const cues = segmentsToCues(segments, clip.startTime, clip.endTime);

      for (const s of segments) {
        if (!(s.end > clip.startTime && s.start < clip.endTime)) continue;
        const a = Math.max(0, s.start - clip.startTime);
        const b = Math.min(clip.endTime - clip.startTime, s.end - clip.startTime);
        const group = cues.filter((c) => c.start >= a - 1e-6 && c.end <= b + 1e-6);
        if (group.length === 0) continue;
        // A segment with no word timings draws whole and is never chunked.
        if (group.some((c) => !c.words || c.words.length === 0)) {
          wordless += group.length;
          continue;
        }

        segmentOccurrences += 1;
        const words = group.flatMap((c) => c.words!);
        const segStart = group[0].start;
        const segEnd = group[group.length - 1].end;

        const wasChunks = greedyChunk(words);
        const nowChunks = chunkWords(words, segStart, segEnd);
        before.push(...describe(wasChunks, segStart, segEnd));
        after.push(...describe(nowChunks, segStart, segEnd));

        if (
          reshaped.length < 12 &&
          wasChunks.length === nowChunks.length &&
          wasChunks.some((c, i) => c.length !== nowChunks[i].length)
        ) {
          const show = (cs: SubtitleWord[][]) =>
            cs.map((c) => c.map((w) => w.text).join(" ")).join("] [");
          reshaped.push(
            `${(job.language ?? "?").padEnd(3)} was [${show(wasChunks)}]\n       now [${show(nowChunks)}]`
          );
        }
      }
    }
  }

  const clips = jobs.reduce((n, j) => n + j.clips.length, 0);
  console.log(
    `corpus: ${jobs.length} jobs, ${clips} clips, ${segmentOccurrences} segment occurrences, ${wordless} wordless cues excluded`
  );
  console.log("");
  console.log(row("before", before));
  console.log(row("after", after));
  console.log("");
  console.log(
    before.length === after.length
      ? `cue count unchanged (${after.length}) - the pace of the subtitles is untouched`
      : `WARNING: cue count moved ${before.length} -> ${after.length}; the comparison above is not like for like`
  );
  console.log("");
  console.log("same number of cues, different shape:");
  for (const line of reshaped) console.log(`  ${line}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
