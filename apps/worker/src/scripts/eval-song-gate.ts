/**
 * MEASURE-FIRST script for spec 2026-08-10 "Clip arc audit..." task 8
 * ("song-lyric source refusal"): before any gate is designed, measure
 * candidate signals on the SONG set and the SPEECH set and print min/max so
 * a human can SEE whether any single signal (or a simple conjunction)
 * separates them with margin. Read-only: DB reads + fixture reads only, no
 * LLM calls, no engine change, nothing here moves a boundary.
 *
 *   docker compose exec -T worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-song-gate.ts"
 *
 * Motivation (engine-notes §5c): one outside user uploaded the same 90s film
 * scene four times and got a clip cut from the SONG's lyrics each time - a
 * source class the engine should refuse rather than clip.
 *
 * Two ways to select jobs, per the task spec:
 *   - a fixed list of ids (SONG_JOB_IDS below, exactly the eight named in the
 *     task spec)
 *   - `--since <ISO date>` selects every DONE-ish job created at/after that
 *     date with clipsGenerated > 0 (defaults to 2026-08-11T15:00:00Z, the
 *     exact SPEECH-set cutoff the spec names - 15 jobs measured 2026-08-17)
 * Both run automatically with no flags; `--since` only exists so a future
 * measurement can move the window without editing the script.
 *
 * PLUS the five eval fixture transcripts (podcast-answer-arc, podcast-ecology,
 * podcast-nuclear, sitcom-friends, creator-challenge) - free, no DB, and the
 * spec asks for them explicitly so the speech side spans podcasts/sitcom/vlog
 * too, not just one afternoon of production traffic.
 *
 * IMPORTANT, measured 2026-08-17: four of the fifteen `--since` DB jobs ARE
 * four of the eight SONG_JOB_IDS (cmsp6e9sg/cmsp6gy9d/cmsp7y0om/cmsp80iqk all
 * carry clipsGenerated > 0 and fall inside the window - that overlap is not a
 * bug in this script, it is the production defect the task exists to fix:
 * these rows shipped real clips from what the task spec calls "song" jobs).
 * See the SONG-vs-SPEECH split note printed at the end of main() for how the
 * overlap is resolved for the min/max comparison - a job cannot be counted as
 * both a required-fire positive and a must-not-fire negative in the same
 * measurement, so the actual transcript content (not the spec's label)
 * decides which pool a contested id lands in, and the disagreement is
 * printed, not hidden.
 *
 * DECIDED, 2026-08-17: this table found a clean rule - `analyze-v2/song-
 * gate.ts`'s `detectSong` (musicTokenShare > 0.30 OR lineRepRate > 0.20),
 * wired into `stages/analyze.ts` behind `SONG_GATE=on`. `musicTokenShare` and
 * `lineRepRate` below are computed by `computeSongSignals`, imported from
 * that module rather than reimplemented here, so this table can never drift
 * from what a real job is judged on. `medSegDur`/`medWordsPerSeg`/
 * `opaqueNodeShare`/`wordTimingCoverage` stay local to this script - measured
 * candidates that did not make the shipped rule (see song-gate.ts's doc
 * comment for why).
 */
import { prisma } from "@clipclap/shared";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { computeSongSignals } from "../analyze-v2/song-gate";
import { FIXTURES_DIR, loadFixture } from "../__tests__/helpers/eval-fixture";

/** Exactly the eight ids named in the task spec, in the spec's own order:
 *  four "film scene whose clips were cut from a song" + four "pure ♫/verse
 *  zero-clip jobs". */
const SONG_JOB_IDS = [
  "cmsp6e9sg0096uhfj33smi7kd",
  "cmsp6gy9d009fuhfjz5ajftxi",
  "cmsp7y0om009nuhfjkclqjsf2",
  "cmsp80iqk009vuhfjmkakk798",
  "cmspy9brs00anuhfjecmby2u2",
  "cmsw1rv1u0065i1jxueejiwv3",
  "cmswkdvq2007ai1jx8vp31bqx",
  "cmsptnpxd00afuhfjrtv10ie4",
];

const DEFAULT_SPEECH_SINCE = "2026-08-11T15:00:00Z";

const FIXTURE_NAMES = [
  "podcast-answer-arc",
  "podcast-ecology",
  "podcast-nuclear",
  "sitcom-friends",
  "creator-challenge",
];

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function wordCountOf(seg: WhisperSegment): number {
  if (seg.words && seg.words.length > 0) return seg.words.length;
  return seg.text.trim().split(/\s+/).filter(Boolean).length;
}

export interface SongGateSignals {
  id: string;
  set: string;
  language: string | null;
  sourceDurationSec: number | null;
  segCount: number;
  musicTokenShare: number;
  lineRepRate: number;
  medSegDur: number;
  medWordsPerSeg: number;
  opaqueNodeShare: number;
  wordTimingCoverage: number;
}

/** All eight signals the task spec asks for, computed from a transcript the
 *  same way the engine would see it - buildSentenceGraph with the env-blind
 *  default config, same pattern eval-arc-audit.ts and replay-front-half.ts
 *  use to reproduce the engine's own node array outside index.ts. */
export function computeSignals(
  id: string,
  set: string,
  language: string | null,
  sourceDurationSec: number | null,
  transcript: TranscriptionResult
): SongGateSignals {
  const segments = transcript.segments ?? [];
  const cfg = loadAnalyzeConfig({});
  const nodes = buildSentenceGraph(segments, cfg);

  // musicTokenShare / lineRepRate: delegated to the SAME function the engine
  // gate (analyze-v2/song-gate.ts) runs, so this table can never drift from
  // what a real job would be judged on - the same discipline eval-arc-audit.ts
  // uses for classifyOnset.
  const { musicTokenShare, lineRepRate } = computeSongSignals(segments);

  const medSegDur = median(segments.map((s) => s.end - s.start));
  const medWordsPerSeg = median(segments.map(wordCountOf));

  const opaqueSpan = nodes
    .filter((n) => !n.hasWords)
    .reduce((sum, n) => sum + (n.end - n.start), 0);
  const totalSpan = nodes.reduce((sum, n) => sum + (n.end - n.start), 0);
  const opaqueNodeShare = totalSpan > 0 ? opaqueSpan / totalSpan : 0;

  const withWords = segments.filter((s) => s.words && s.words.length > 0).length;
  const wordTimingCoverage = segments.length > 0 ? withWords / segments.length : 0;

  return {
    id,
    set,
    language,
    sourceDurationSec,
    segCount: segments.length,
    musicTokenShare,
    lineRepRate,
    medSegDur,
    medWordsPerSeg,
    opaqueNodeShare,
    wordTimingCoverage,
  };
}

function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "-";
}
function fmtNum(x: number): string {
  return Number.isFinite(x) ? x.toFixed(1) : "-";
}

function printRow(r: SongGateSignals): void {
  console.log(
    `${r.set.padEnd(14)} ${r.id.padEnd(26)} ${(r.language ?? "-").padEnd(4)} ` +
      `dur=${String(r.sourceDurationSec ?? "-").padStart(5)}s  segs=${String(r.segCount).padStart(4)}  ` +
      `music=${fmtPct(r.musicTokenShare).padStart(6)}  rep=${fmtPct(r.lineRepRate).padStart(6)}  ` +
      `medSegDur=${fmtNum(r.medSegDur).padStart(5)}s  medWords=${fmtNum(r.medWordsPerSeg).padStart(5)}  ` +
      `opaque=${fmtPct(r.opaqueNodeShare).padStart(6)}  wordCov=${fmtPct(r.wordTimingCoverage).padStart(6)}`
  );
}

function summarize(label: string, rows: SongGateSignals[]): void {
  if (rows.length === 0) {
    console.log(`\n${label}: (no rows)`);
    return;
  }
  const pick = (f: (r: SongGateSignals) => number) =>
    rows.map(f).filter((x) => Number.isFinite(x));
  const minMax = (nums: number[]) =>
    nums.length > 0
      ? `min ${nums.length > 0 ? Math.min(...nums) : NaN} / max ${nums.length > 0 ? Math.max(...nums) : NaN}`
      : "-";
  console.log(`\n${label} (n=${rows.length}):`);
  const report = (name: string, f: (r: SongGateSignals) => number, fmt: (x: number) => string) => {
    const nums = pick(f);
    if (nums.length === 0) {
      console.log(`  ${name.padEnd(18)} -`);
      return;
    }
    console.log(
      `  ${name.padEnd(18)} min ${fmt(Math.min(...nums)).padStart(7)}   max ${fmt(Math.max(...nums)).padStart(7)}`
    );
  };
  report("musicTokenShare", (r) => r.musicTokenShare, fmtPct);
  report("lineRepRate", (r) => r.lineRepRate, fmtPct);
  report("medSegDur", (r) => r.medSegDur, fmtNum);
  report("medWordsPerSeg", (r) => r.medWordsPerSeg, fmtNum);
  report("opaqueNodeShare", (r) => r.opaqueNodeShare, fmtPct);
  report("wordTimingCoverage", (r) => r.wordTimingCoverage, fmtPct);
}

async function main() {
  const sinceArg = process.argv.indexOf("--since");
  const since = new Date(
    sinceArg >= 0 ? process.argv[sinceArg + 1] : DEFAULT_SPEECH_SINCE
  );
  if (Number.isNaN(since.getTime())) {
    console.error(`--since is not a date`);
    process.exit(1);
  }

  const rows: SongGateSignals[] = [];

  // --- SONG set: the eight ids named in the task spec ---
  const songJobs = await prisma.job.findMany({
    where: { id: { in: SONG_JOB_IDS } },
    select: {
      id: true,
      language: true,
      sourceDurationSec: true,
      clipsGenerated: true,
      noClipsReason: true,
      transcriptJson: true,
    },
  });
  const songById = new Map(songJobs.map((j) => [j.id, j]));
  for (const id of SONG_JOB_IDS) {
    const j = songById.get(id);
    if (!j) {
      console.error(`SONG job ${id} not found in DB - skipping`);
      continue;
    }
    const t = j.transcriptJson as unknown as TranscriptionResult | null;
    if (!t || !t.segments) {
      console.error(`SONG job ${id} has no transcriptJson.segments - skipping`);
      continue;
    }
    const r = computeSignals(id, "SONG(spec)", j.language, j.sourceDurationSec, t);
    rows.push(r);
  }

  // --- SPEECH set, part 1: DB jobs since the cutoff with real clips ---
  const speechJobs = await prisma.job.findMany({
    where: { createdAt: { gte: since }, clipsGenerated: { gt: 0 } },
    select: {
      id: true,
      language: true,
      sourceDurationSec: true,
      clipsGenerated: true,
      createdAt: true,
      transcriptJson: true,
    },
    orderBy: { createdAt: "asc" },
  });
  for (const j of speechJobs) {
    const t = j.transcriptJson as unknown as TranscriptionResult | null;
    if (!t || !t.segments) {
      console.error(`SPEECH-DB job ${j.id} has no transcriptJson.segments - skipping`);
      continue;
    }
    const r = computeSignals(j.id, "SPEECH-DB", j.language, j.sourceDurationSec, t);
    rows.push(r);
  }

  // --- SPEECH set, part 2: the five eval fixture transcripts ---
  for (const name of FIXTURE_NAMES) {
    const fixture = loadFixture(name, FIXTURES_DIR);
    const t = fixture.transcript;
    const durationSec =
      t.segments.length > 0 ? t.segments[t.segments.length - 1].end : null;
    const r = computeSignals(name, "SPEECH-fixture", t.language ?? null, durationSec, t);
    rows.push(r);
  }

  console.log(
    `song jobs: ${songJobs.length}/${SONG_JOB_IDS.length} found  ` +
      `speech-DB jobs since ${since.toISOString()}: ${speechJobs.length}  ` +
      `speech fixtures: ${FIXTURE_NAMES.length}`
  );
  console.log("");
  for (const r of rows) printRow(r);

  // --- SONG vs SPEECH split, resolved by measured content, not by the
  // spec's label - see the module doc comment. cmsp7y0om/cmsp80iqk are named
  // in the spec's SONG list but their transcripts (checked by hand,
  // 2026-08-17) are 100% ordinary movie dialogue: no music-note tokens, no
  // repeated lines, ordinary segment lengths, and their shipped highlights
  // ("One Confession Changes How a Son Sees His Father" etc.) are dialogue
  // clips, not lyric clips. They are also part of the 15-job SPEECH-DB pool
  // by construction (clipsGenerated > 0, in-window). Counting the same rows
  // as both a required-fire positive and a must-not-fire negative would make
  // any rule fail by definition, so they are reported here as BOUNDARY and
  // excluded from the required-fire SONG pool the rule is judged against -
  // exactly the task's own instruction: "if the table shows them looking
  // like speech, say so and treat them as the boundary case, not as a
  // failure of the gate."
  const BOUNDARY_IDS = new Set(["cmsp7y0om009nuhfjkclqjsf2", "cmsp80iqk009vuhfjmkakk798"]);
  const songRows = rows.filter((r) => r.set === "SONG(spec)" && !BOUNDARY_IDS.has(r.id));
  const boundaryRows = rows.filter((r) => BOUNDARY_IDS.has(r.id));
  const speechRows = rows.filter((r) => r.set !== "SONG(spec)");

  console.log(
    `\nBOUNDARY (spec labels these SONG; measured transcript is ordinary dialogue - ` +
      `excluded from the required-fire SONG pool, see doc comment):`
  );
  for (const r of boundaryRows) printRow(r);

  summarize("SONG (required-fire pool, spec ids minus boundary)", songRows);
  summarize("SPEECH (must-not-fire pool: DB since cutoff + 5 fixtures; includes the 2 boundary rows)", speechRows);

  console.log(
    "\n(min/max per signal above is the whole finding: a rule is only worth " +
      "shipping if SONG's range and SPEECH's range do not overlap, with margin.)"
  );

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
