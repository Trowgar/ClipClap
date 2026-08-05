/**
 * Measures the FIRST SECOND of every rendered clip, which is the only second
 * that decides whether the rest is watched.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-clip-openings.ts \
 *        [--limit N] [--no-video] [--since 2026-08-05T12:00:00Z]"
 *
 * **Use `--since`.** The clips table spans five months of engine versions, and
 * pooling them answers a question nobody asked. Measured 2026-08-05: over the
 * whole table 3 of 124 clips open on an essentially frozen frame, and all three
 * turned out to be July renders whose crop had parked on a curtain, a radio and
 * a pair of knees - the framing defect commit 8841524 was written to fix. In
 * the cohort rendered after that fix, the frozen openings are gone (minimum
 * motion 0.65 against 0.06) - but that cohort is ten distinct clips from ONE
 * source, so it is evidence the defect did not recur, not evidence it is gone.
 *
 * This exists because the judge panel keeps naming the opening frame and the
 * panel cannot be trusted on aggregates (engine notes 8b). A frame is the one
 * thing a six-frame strip CAN see reliably, so the complaint is worth taking
 * seriously - but "weak opening" is not a defect until it is one specific
 * measurable thing, and the last time this was assumed rather than measured
 * (the black in-point spec) the assumed cause turned out to affect 1 clip in 73.
 *
 * So this measures candidates rather than confirming one, in two halves:
 *
 *   TRANSCRIPT-SIDE - free, runs on every clip. Does the clip open mid-sentence?
 *   How long before the first word is spoken? Is there any subtitle on screen
 *   at all in the first moments?
 *
 *   PIXEL-SIDE - downloads each clip, reads it, deletes it. How bright is the
 *   opening, how long until it is not dark, and does anything move.
 *
 * Read-only against the database and against R2: it downloads clips to a temp
 * file and unlinks them. Nothing is written back, no job is touched.
 */
import { prisma, downloadFile } from "@clipclap/shared";
import type { WhisperSegment } from "@clipclap/shared";
import { Prisma } from "@prisma/client";
import { execFile } from "child_process";
import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { segmentsToCues } from "../processors/subtitles";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

/** Y plane mean, 0-255. Below this the frame reads as black to a viewer. The
 *  black in-point investigation measured a genuinely black opening at 2. */
const DARK_LUMA = 16;

/** How much of the opening to look at. A viewer's decision is made well inside
 *  this, but a shorter window cannot tell a black frame from a fade-in. */
const WINDOW_SEC = 1.0;

interface Opening {
  clipId: string;
  language: string;
  /** ISO render date. Kept because engine versions matter more than clip ids
   *  when reading this table - see the note about `--since` at the top. */
  rendered: string;
  /** Seconds from the clip start to the first spoken word. */
  silentLeadSec: number;
  /** The clip's in-point falls inside a sentence rather than at its start. */
  midSentence: boolean;
  /** No subtitle is drawn at all during the first 0.3s. */
  noCaptionAtStart: boolean;
  /** Mean luma of the first frame, or null when the pixels were not read. */
  firstLuma: number | null;
  /** Seconds until luma first exceeds DARK_LUMA, or null. */
  darkForSec: number | null;
  /** Mean absolute frame-to-frame difference over the window, or null. */
  motion: number | null;
}

/** Parses `key=value` lines that ffmpeg's metadata filter prints to stderr. */
function readMetadata(stderr: string, key: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`${key.replace(/\./g, "\\.")}=([-\\d.eE+]+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

async function download(key: string): Promise<string> {
  const path = join(tmpdir(), `opening-${randomUUID()}.mp4`);
  const body = await downloadFile(key);
  await streamPipeline(
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(path)
  );
  return path;
}

/** Per-frame luma over the opening window, and per-frame motion against the
 *  previous frame. Two passes because `tblend` consumes the frame pairing that
 *  the plain luma pass needs to report frame 0 on its own. */
async function readPixels(
  path: string
): Promise<{ luma: number[]; motion: number | null; fps: number }> {
  const lumaRun = await execFileAsync(
    "ffmpeg",
    ["-nostdin", "-t", String(WINDOW_SEC), "-i", path, "-vf",
     "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  ).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const luma = readMetadata(lumaRun.stderr ?? "", "lavfi.signalstats.YAVG");

  const motionRun = await execFileAsync(
    "ffmpeg",
    ["-nostdin", "-t", String(WINDOW_SEC), "-i", path, "-vf",
     "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
     "-f", "null", "-"],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  ).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const diffs = readMetadata(motionRun.stderr ?? "", "lavfi.signalstats.YAVG");

  const fps = luma.length > 0 ? luma.length / WINDOW_SEC : 30;
  return {
    luma,
    motion: diffs.length > 0 ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null,
    fps,
  };
}

function pctOf(n: number, of: number): string {
  return of > 0 ? `${((100 * n) / of).toFixed(1)}%` : "-";
}

function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

async function main() {
  const args = process.argv.slice(2);
  const withVideo = !args.includes("--no-video");
  const limitAt = args.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
  const sinceAt = args.indexOf("--since");
  const since = sinceAt >= 0 ? new Date(args[sinceAt + 1]) : null;
  if (since && Number.isNaN(since.getTime())) {
    console.error(`--since is not a date: ${args[sinceAt + 1]}`);
    process.exit(1);
  }

  const jobs = await prisma.job.findMany({
    where: {
      clips: { some: { deletedAt: null } },
      transcriptJson: { not: Prisma.DbNull },
    },
    select: {
      id: true,
      language: true,
      transcriptJson: true,
      clips: {
        where: { deletedAt: null, ...(since ? { createdAt: { gte: since } } : {}) },
        select: {
          id: true,
          storageKey: true,
          startTime: true,
          endTime: true,
          createdAt: true,
        },
      },
    },
  });

  const openings: Opening[] = [];
  let read = 0;
  let failed = 0;

  for (const job of jobs) {
    const segments = ((job.transcriptJson as { segments?: WhisperSegment[] })
      ?.segments ?? []) as WhisperSegment[];

    for (const clip of job.clips) {
      const cues = segmentsToCues(segments, clip.startTime, clip.endTime);
      const words = segments
        .flatMap((s) => s.words ?? [])
        .filter((w) => w.end > clip.startTime && w.start < clip.endTime);
      // Older transcripts carry no word timings at all. Their silent lead is
      // unknown, not infinite, and averaging them in as a very long silence
      // reported a p90 of 69s on a corpus whose median is 0.15s. They fall back
      // to segment starts, which are coarser but real.
      const overlapping = segments.filter(
        (s) => s.end > clip.startTime && s.start < clip.endTime
      );
      const starts = words.length > 0
        ? words.map((w) => w.start)
        : overlapping.map((s) => s.start);
      const firstWordAt = starts.length > 0
        ? Math.max(0, Math.min(...starts) - clip.startTime)
        : Infinity;

      // The in-point lands inside a sentence when some segment starts before it
      // and ends after it - the viewer arrives mid-thought with no verbal hook.
      const midSentence = segments.some(
        (s) => s.start < clip.startTime - 1e-6 && s.end > clip.startTime + 1e-6
      );

      const opening: Opening = {
        clipId: clip.id,
        language: job.language ?? "?",
        rendered: clip.createdAt.toISOString(),
        silentLeadSec: firstWordAt,
        midSentence,
        noCaptionAtStart: !cues.some((c) => c.start <= 0.3 && c.end > 0),
        firstLuma: null,
        darkForSec: null,
        motion: null,
      };

      if (withVideo && read < limit) {
        let path: string | null = null;
        try {
          path = await download(clip.storageKey);
          const { luma, motion, fps } = await readPixels(path);
          if (luma.length > 0) {
            opening.firstLuma = luma[0];
            const firstLit = luma.findIndex((v) => v > DARK_LUMA);
            opening.darkForSec =
              firstLit < 0 ? WINDOW_SEC : firstLit / fps;
          }
          opening.motion = motion;
          read += 1;
        } catch (error) {
          failed += 1;
          console.error(`  ! ${clip.id}: ${(error as Error).message}`);
        } finally {
          if (path) await unlink(path).catch(() => {});
        }
        if (read % 20 === 0) console.error(`  ... ${read} clips read`);
      }

      openings.push(opening);
    }
  }

  const n = openings.length;
  const withPixels = openings.filter((o) => o.firstLuma !== null);

  // Jobs that contributed a clip, not jobs queried: with --since most of them
  // contribute nothing and reporting the query count overstates the corpus.
  const contributing = jobs.filter((j) => j.clips.length > 0).length;
  console.log(`corpus: ${contributing} jobs, ${n} clips${withPixels.length < n ? ` (${withPixels.length} read as pixels, ${failed} failed)` : ""}`);
  console.log("");
  console.log("1. what the viewer hears");
  const silent = (t: number) => openings.filter((o) => o.silentLeadSec > t).length;
  const leads = openings
    .map((o) => o.silentLeadSec)
    .filter((v) => Number.isFinite(v));
  const unknown = n - leads.length;
  console.log(`   silent lead p50 / p90 / max : ${quantile(leads, 0.5).toFixed(2)}s / ${quantile(leads, 0.9).toFixed(2)}s / ${Math.max(...leads).toFixed(2)}s${unknown > 0 ? `  (${unknown} clips have no timings at all)` : ""}`);
  console.log(`   no word in the first 0.3s   : ${silent(0.3)}  (${pctOf(silent(0.3), n)})`);
  console.log(`   no word in the first 1.0s   : ${silent(1.0)}  (${pctOf(silent(1.0), n)})`);
  console.log("");
  console.log("2. what the viewer reads");
  const noCap = openings.filter((o) => o.noCaptionAtStart).length;
  const mid = openings.filter((o) => o.midSentence).length;
  console.log(`   no caption in the first 0.3s: ${noCap}  (${pctOf(noCap, n)})`);
  console.log(`   opens mid-sentence          : ${mid}  (${pctOf(mid, n)})`);
  console.log("");
  console.log("3. what the viewer sees");
  if (withPixels.length === 0) {
    console.log("   not read (--no-video)");
  } else {
    const darkFirst = withPixels.filter((o) => (o.firstLuma ?? 255) <= DARK_LUMA).length;
    const darkHalf = withPixels.filter((o) => (o.darkForSec ?? 0) >= 0.3).length;
    const lumas = withPixels.map((o) => o.firstLuma!);
    const motions = withPixels.map((o) => o.motion ?? 0);
    console.log(`   first-frame luma p10 / p50  : ${quantile(lumas, 0.1).toFixed(1)} / ${quantile(lumas, 0.5).toFixed(1)}  (0-255, dark below ${DARK_LUMA})`);
    console.log(`   first frame is dark         : ${darkFirst}  (${pctOf(darkFirst, withPixels.length)})`);
    console.log(`   dark for 0.3s or longer     : ${darkHalf}  (${pctOf(darkHalf, withPixels.length)})`);
    console.log(`   opening motion p10 / p50    : ${quantile(motions, 0.1).toFixed(2)} / ${quantile(motions, 0.5).toFixed(2)}  (mean frame difference)`);
  }
  console.log("");
  console.log("4. the quietest openings - look at these frames yourself");
  // Sorted by motion, not by silent lead: the lead is a constant 0.15s on every
  // clip measured so far, so ranking by it ranks nothing. A near-frozen opening
  // is the one signal here that has ever pointed at a real defect, and it did so
  // indirectly - the crop was parked on furniture, which is why nothing moved.
  const quietest = openings
    .filter((o) => o.motion !== null)
    .sort((a, b) => (a.motion ?? 0) - (b.motion ?? 0))
    .slice(0, 12);
  if (quietest.length === 0) console.log("   not read (--no-video)");
  for (const o of quietest) {
    console.log(
      `   motion ${(o.motion ?? 0).toFixed(2).padStart(6)} luma ${(o.firstLuma ?? 0).toFixed(0).padStart(3)}` +
      ` | ${o.rendered.slice(0, 10)} ${o.language.padEnd(3)}` +
      ` | ${o.midSentence ? "mid-sentence  " : "sentence start"}` +
      ` | ${o.clipId}`
    );
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
