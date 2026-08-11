/**
 * Scan window budget probe (spec 2026-08-11 "Scan recall remedy: window
 * budget from sourceSec"). Two independent halves.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-scan-probe.ts \
 *        [--live] [--runs N] [--passes N] [--budget source|speech|both] <fixture>"
 *
 * PHASE B (`--passes N`, default 1 - the 2x scan union)
 * -----------------------------------------------------------------
 * `--passes N` sets `cfg.scanPasses = N` before each RUN, so a single RUN now
 * asks every window the SAME prompt N times (`runScanner`'s own mechanism -
 * see scanner.ts and config.ts's `scanPasses` doc comment for why identical
 * prompts are the point) and returns the UNION of all N passes' raw
 * candidates, in (window, pass) order. `--runs` and `--passes` are
 * orthogonal: `--runs 2 --passes 2` performs two INDEPENDENT unions (two
 * separate temperature-0.4 draws of "2 passes each"), which is what the
 * Phase B acceptance asks for on `podcast-nuclear` - the union must be stable
 * across independent runs, not just within one.
 *
 * At `--passes 1` (the default) the live-half output is UNCHANGED from
 * before this flag existed - one raw-candidate list per run, one SCANNED/NOT
 * SCANNED line per labeled moment - so prior probe output stays comparable
 * byte for byte. At `--passes N > 1` each run instead prints N tagged
 * per-pass raw-candidate lists, then per labeled moment: a SCANNED/NOT
 * SCANNED line for EACH pass individually, plus a UNION verdict
 * (SCANNED-by-union, naming which pass(es) covered it, or NOT SCANNED) -
 * the falsifiable measurement the Phase B acceptance reads.
 *
 * DETERMINISTIC HALF (no flag needed, free, always runs)
 * -----------------------------------------------------------------
 * Builds the sentence graph straight from the fixture's transcript
 * (`buildSentenceGraph`, the same function `replay-front-half.ts` uses - no
 * LLM call involved) and computes `buildScanWindows`' layout under BOTH
 * `scanWindowBudget` settings, unconditionally. For each budget it prints the
 * window count, and per window: the node range, the WALL-CLOCK span the
 * window covers (`nodes[endNode].end - nodes[startNode].start`, includes
 * internal gaps), and the RENDERED-TRANSCRIPT seconds - the sum of every node
 *'s own span inside the window (`sourceSeconds()`'s own definition, applied
 * to the slice), i.e. how much text `renderWindowText` actually hands the
 * model. Those two numbers diverge exactly where engine-notes §6a's defect
 * lives: under the "speech" budget a window's accumulated `speechSec` (~600s,
 * the field printed alongside) can be a small fraction of what it actually
 * renders, because opaque nodes ride along in the slice for free without
 * counting toward the stopping condition. This alone answers the spec's
 * acceptance #1 - window count moving ~4 -> 7-8 - without spending a cent.
 *
 * LIVE HALF (`--live` required, refuses without it - same discipline
 * eval-arc-stability.ts established for exactly this reason)
 * -----------------------------------------------------------------
 * Runs the REAL scanner (`runScanner`, the same function `scanner.ts` uses in
 * production) against a REAL OpenAI client, at `cfg.scanModel` (gpt-4o-mini
 * class - cheap, but still real spend), under the window layout for whichever
 * budget(s) `--budget` selects (default "speech" - the config default, so an
 * operator who forgets the flag spends money without changing anything about
 * what ships today; the whole point of this task is measured with an
 * explicit `--budget source`). `--runs N` (default 1) repeats the scan N
 * independent times per budget, because the scanner is not deterministic
 * (temperature 0.4) and a single pass cannot distinguish "the window layout
 * fixed the miss" from "this particular pass got lucky".
 *
 * For each run it prints every raw candidate the scanner returned (window,
 * node range, seconds, interest, type, thread). If the fixture has a
 * labels.json, it additionally loads `moments[]` and `missedMoments[]`
 * (`arc-audit-labels.ts`'s `loadMoments` - shared, not reimplemented, with
 * eval-selection-autopsy.ts, spec 2026-08-11 "Selection autopsy") and prints,
 * per labeled moment per run, a coverage verdict: SCANNED (naming the
 * covering raw candidate(s), same >=30%-of-shorter overlap convention
 * `arc-audit-labels.ts`'s `covers` already implements) or NOT SCANNED (naming
 * the nearest raw candidate by time distance, so a reader can tell "close but
 * outside the match threshold" from "nowhere near").
 *
 * WHAT THIS SCRIPT NEVER DOES: write into the fixture directory. No
 * recordings, no snapshots, no meta.json touch - it only reads
 * transcript.json and labels.json and prints to stdout. Recording a fixture
 * under the new budget (the "FULL RE-RECORD per fixture" the spec's own
 * "what it costs" section describes) is a separate, later, operator-blessed
 * step via eval-record.ts - not this script's job.
 */
import OpenAI from "openai";
import {
  FIXTURES_DIR,
  loadFixture,
  type Fixture,
} from "../__tests__/helpers/eval-fixture";
import { loadAnalyzeConfig, type AnalyzeConfig } from "../analyze-v2/config";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { buildScanWindows } from "../analyze-v2/windows";
import { sourceSeconds } from "../analyze-v2/candidates";
import { runScanner } from "../analyze-v2/scanner";
import { newUsage } from "../analyze-v2/llm";
import { covers, loadMoments, type LabeledMoment } from "./arc-audit-labels";
import type { ScanCandidate, ScanWindow, SentenceNode } from "../analyze-v2/types";
import { join } from "path";

type Budget = "speech" | "source";
const BUDGETS: Budget[] = ["speech", "source"];

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

interface Flags {
  live: boolean;
  runs: number;
  passes: number;
  budget: Budget | "both";
  fixtureName: string | undefined;
}

function extractFlags(argv: string[]): Flags {
  let live = false;
  let runs = 1;
  let passes = 1;
  let budget: Budget | "both" = "speech";
  let fixtureName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") {
      live = true;
      continue;
    }
    if (a === "--runs") {
      const v = argv[++i];
      const n = v ? Number.parseInt(v, 10) : Number.NaN;
      if (!Number.isFinite(n) || n < 1) throw new Error("--runs requires a positive integer");
      runs = n;
      continue;
    }
    if (a === "--passes") {
      const v = argv[++i];
      const n = v ? Number.parseInt(v, 10) : Number.NaN;
      if (!Number.isFinite(n) || n < 1) throw new Error("--passes requires a positive integer");
      passes = n;
      continue;
    }
    if (a === "--budget") {
      const v = argv[++i];
      if (v !== "speech" && v !== "source" && v !== "both") {
        throw new Error(`--budget requires "speech", "source" or "both" (got ${JSON.stringify(v)})`);
      }
      budget = v;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`unknown option "${a}"`);
    }
    if (fixtureName) {
      throw new Error(`unexpected extra argument "${a}" - only one fixture per run`);
    }
    fixtureName = a;
  }
  return { live, runs, passes, budget, fixtureName };
}

// ---------------------------------------------------------------------------
// deterministic half
// ---------------------------------------------------------------------------

const fmtSec = (s: number) => s.toFixed(1);
const fmtRange = (a: number, b: number) => `${fmtSec(a)}-${fmtSec(b)}s`;

function nodeSec(nodes: SentenceNode[], startNode: number, endNode: number): [number, number] {
  return [nodes[startNode].start, nodes[endNode].end];
}

/** Sum of every node's own span inside [startNode, endNode] - sourceSeconds()'s
 *  own definition, applied to one window's slice rather than the whole graph.
 *  This is what renderWindowText actually hands the model: the "rendered
 *  transcript seconds" engine-notes §6a's "renders ~1130s of transcript"
 *  sentence is about. */
function transcriptSpanSec(nodes: SentenceNode[], startNode: number, endNode: number): number {
  return sourceSeconds(nodes.slice(startNode, endNode + 1));
}

function printDeterministicHalf(fixtureName: string, nodes: SentenceNode[], cfg: AnalyzeConfig): void {
  const wallClockSec = nodes.length > 0 ? nodes[nodes.length - 1].end - nodes[0].start : 0;
  const totalSourceSec = sourceSeconds(nodes);
  const totalSpeechSec = nodes.reduce((s, n) => s + (n.hasWords ? n.end - n.start : 0), 0);

  console.log(`=== ${fixtureName}: deterministic window layout (no API calls) ===`);
  console.log(
    `nodes: ${nodes.length}  wall clock: ${fmtSec(wallClockSec)}s  ` +
      `sourceSec (all node spans): ${fmtSec(totalSourceSec)}s  ` +
      `speechSec (word-bearing only): ${fmtSec(totalSpeechSec)}s  ` +
      `scanWindowSec: ${cfg.scanWindowSec}  scanOverlapSec: ${cfg.scanOverlapSec}\n`
  );

  for (const budget of BUDGETS) {
    const windows = buildScanWindows(nodes, { ...cfg, scanWindowBudget: budget });
    console.log(`--- budget=${budget}${budget === cfg.scanWindowBudget ? " (config default)" : ""} ---`);
    console.log(`windows: ${windows.length}`);
    let coveredSourceSec = 0;
    const coveredNodes = new Set<number>();
    for (const w of windows) {
      const [wallStart, wallEnd] = nodeSec(nodes, w.startNode, w.endNode);
      const transcriptSec = transcriptSpanSec(nodes, w.startNode, w.endNode);
      console.log(
        `  #${w.index} nodes ${w.startNode}-${w.endNode}  ` +
          `wallSpan=${fmtRange(wallStart, wallEnd)}  ` +
          `transcriptSec=${fmtSec(transcriptSec)}s  ` +
          `budgetAccumulated(speechSec field)=${fmtSec(w.speechSec)}s`
      );
      for (let i = w.startNode; i <= w.endNode; i++) {
        if (!coveredNodes.has(i)) {
          coveredNodes.add(i);
          coveredSourceSec += nodes[i].end - nodes[i].start;
        }
      }
    }
    console.log(
      `  total transcript coverage: ${fmtSec(coveredSourceSec)}s / ${fmtSec(totalSourceSec)}s ` +
        `(${totalSourceSec > 0 ? ((100 * coveredSourceSec) / totalSourceSec).toFixed(1) : "-"}%) ` +
        `across ${coveredNodes.size}/${nodes.length} nodes\n`
    );
  }
}

// ---------------------------------------------------------------------------
// live half
// ---------------------------------------------------------------------------

function candSec(nodes: SentenceNode[], c: ScanCandidate): [number, number] {
  return [nodes[c.startNode].start, nodes[c.endNode].end];
}

function printCandidate(nodes: SentenceNode[], c: ScanCandidate): void {
  const [s, e] = candSec(nodes, c);
  console.log(
    `    - window ${c.windowIndex} nodes ${c.startNode}-${c.endNode} (${fmtRange(s, e)}) ` +
      `payoffNode=${c.payoffNode} interest=${c.interest.toFixed(2)} type=${c.type}` +
      (c.thread ? ` thread=${c.thread}` : "")
  );
}

function nearestCandidate(
  nodes: SentenceNode[],
  candidates: ScanCandidate[],
  momentStart: number,
  momentEnd: number
): { candidate: ScanCandidate; distanceSec: number } | null {
  let nearest: ScanCandidate | null = null;
  let nearestDist = Infinity;
  for (const c of candidates) {
    const [s, e] = candSec(nodes, c);
    const dist = s > momentEnd ? s - momentEnd : e < momentStart ? momentStart - e : 0;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = c;
    }
  }
  return nearest ? { candidate: nearest, distanceSec: nearestDist } : null;
}

/** True SCANNED/NOT-SCANNED convention shared by the single-pass line, every
 *  per-pass line and the union line: `arc-audit-labels.ts`'s `covers` (>=30%
 *  overlap of the shorter range) applied to whichever candidate list the
 *  caller hands in. */
function coveringCandidates(
  nodes: SentenceNode[],
  candidates: ScanCandidate[],
  momentStart: number,
  momentEnd: number
): ScanCandidate[] {
  return candidates.filter((c) => {
    const [s, e] = candSec(nodes, c);
    return covers(momentStart, momentEnd, s, e);
  });
}

async function runLivePass(
  client: OpenAI,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  budget: Budget,
  runIndex: number,
  runs: number,
  passes: number,
  moments: LabeledMoment[]
): Promise<void> {
  const liveCfg: AnalyzeConfig = { ...cfg, scanWindowBudget: budget, scanPasses: passes };
  const windows: ScanWindow[] = buildScanWindows(nodes, liveCfg);
  const usage = newUsage();
  // runScanner performs `passes` identical-prompt calls per window itself
  // (scanner.ts) and returns their UNION, flattened in (window, pass) order -
  // this call IS the mechanism under measurement, not a re-implementation of it.
  const result = await runScanner(client, usage, nodes, liveCfg);

  console.log(
    `\n--- budget=${budget}  run ${runIndex + 1}/${runs}${passes > 1 ? `  passes=${passes}` : ""}  ` +
      `windows=${windows.length}  raw candidates=${result.candidates.length}  ` +
      `windowsFailed=${result.telemetry.windowsFailed} ---`
  );

  // At passes=1 this is byte-for-byte the pre-Phase-B output shape, so prior
  // probe runs stay comparable without re-reading a legend.
  if (passes === 1) {
    for (const c of result.candidates) printCandidate(nodes, c);
  } else {
    for (let p = 0; p < passes; p++) {
      const passCandidates = result.candidates.filter((c) => c.passIndex === p);
      console.log(`  -- pass ${p + 1}/${passes}: ${passCandidates.length} raw candidate(s) --`);
      for (const c of passCandidates) printCandidate(nodes, c);
    }
  }

  if (moments.length === 0) return;
  console.log(`  coverage verdicts (${moments.length} labeled moment(s)):`);
  for (const moment of moments) {
    const [mStart, mEnd] = moment.range;
    const label = `[${moment.kind === "moment" ? "moment" : "MISSED"} #${moment.ordinal}] "${moment.title}" ${fmtRange(mStart, mEnd)}`;

    if (passes === 1) {
      const hits = coveringCandidates(nodes, result.candidates, mStart, mEnd);
      if (hits.length > 0) {
        console.log(`    ${label}: SCANNED (${hits.length} covering candidate(s))`);
        for (const c of hits) printCandidate(nodes, c);
      } else {
        const nearest = nearestCandidate(nodes, result.candidates, mStart, mEnd);
        console.log(
          `    ${label}: NOT SCANNED` +
            (nearest
              ? ` - nearest candidate ${nearest.distanceSec.toFixed(1)}s away`
              : " - the scanner returned zero candidates entirely")
        );
        if (nearest) printCandidate(nodes, nearest.candidate);
      }
      continue;
    }

    // passes > 1: per-pass verdicts (does resampling alone recover the
    // moment?) followed by the UNION verdict (does the mechanism the spec
    // proposes recover it?) - the two questions Phase B's acceptance asks.
    console.log(`    ${label}:`);
    const coveringPasses: number[] = [];
    for (let p = 0; p < passes; p++) {
      const passCandidates = result.candidates.filter((c) => c.passIndex === p);
      const hits = coveringCandidates(nodes, passCandidates, mStart, mEnd);
      if (hits.length > 0) coveringPasses.push(p);
      console.log(
        `      pass ${p + 1}/${passes}: ` +
          (hits.length > 0 ? `SCANNED (${hits.length} covering candidate(s))` : "NOT SCANNED")
      );
    }
    const unionHits = coveringCandidates(nodes, result.candidates, mStart, mEnd);
    if (unionHits.length > 0) {
      console.log(
        `      UNION: SCANNED-by-union (covering pass ${coveringPasses.map((p) => p + 1).join(", ")})`
      );
      for (const c of unionHits) printCandidate(nodes, c);
    } else {
      const nearest = nearestCandidate(nodes, result.candidates, mStart, mEnd);
      console.log(
        `      UNION: NOT SCANNED` +
          (nearest
            ? ` - nearest candidate ${nearest.distanceSec.toFixed(1)}s away`
            : " - the scanner returned zero candidates entirely")
      );
      if (nearest) printCandidate(nodes, nearest.candidate);
    }
  }
}

async function runLiveHalf(
  fixture: Fixture,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  budgetFlag: Budget | "both",
  runs: number,
  passes: number
): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[eval-scan-probe] OPENAI_API_KEY is not set - refusing to make a live call.");
    process.exit(1);
  }
  const labelsPath = join(FIXTURES_DIR, fixture.name, "labels.json");
  const moments = loadMoments(labelsPath);
  console.log(
    `\n=== ${fixture.name}: LIVE scan (real API calls, model=${cfg.scanModel}` +
      `${passes > 1 ? `, scanPasses=${passes}` : ""}) ===` +
      (moments.length > 0
        ? `  labels: ${moments.length} (${labelsPath})`
        : `  no labels.json found at ${labelsPath} - printing raw candidates only`)
  );

  const budgets: Budget[] = budgetFlag === "both" ? BUDGETS : [budgetFlag];
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  for (const budget of budgets) {
    for (let i = 0; i < runs; i++) {
      await runLivePass(client, nodes, cfg, budget, i, runs, passes, moments);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { live, runs, passes, budget, fixtureName } = extractFlags(process.argv.slice(2));
  if (!fixtureName) {
    console.error(
      "usage: eval-scan-probe.ts [--live] [--runs N] [--passes N] [--budget source|speech|both] <fixture>"
    );
    process.exit(1);
  }

  const fixture = loadFixture(fixtureName);
  const cfg: AnalyzeConfig = { ...loadAnalyzeConfig({}), engine: "recall-critic" };
  const nodes = buildSentenceGraph(fixture.transcript.segments, cfg);

  printDeterministicHalf(fixtureName, nodes, cfg);

  if (!live) {
    console.log(
      "[eval-scan-probe] deterministic half only (no --live). Re-run with --live to also call the " +
        `real scanner (model=${cfg.scanModel}) under budget=${budget}` +
        `${passes > 1 ? ` passes=${passes}` : ""} - this spends real API money.`
    );
    return;
  }

  await runLiveHalf(fixture, nodes, cfg, budget, runs, passes);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
