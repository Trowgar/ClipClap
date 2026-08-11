/**
 * LIVE stability measurement for the arc-audit stage (spec 2026-08-10 "Clip
 * arc audit: entries, exits and self-containment", §3 M3, task 2 item 7).
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-arc-stability.ts \
 *        --live [--variant NAME] [--runs N] [--json PATH] [--labels PATH] <fixture>"
 *
 * WHY THIS SCRIPT EXISTS, AND WHY IT CANNOT BE THE REPLAY HARNESS
 * -----------------------------------------------------------------
 * `responses.json` keys every recorded answer by sha256(model, system, user)
 * (replay-client.ts's requestKey). An IDENTICAL prompt therefore replays the
 * SAME recorded answer forever - which is exactly right for a deterministic
 * regression suite and exactly wrong for measuring whether an LLM JUDGE is
 * stable, because the replay harness cannot even ask the question twice. M3
 * names this directly: "stability CANNOT be measured through the replay
 * harness... it needs a dedicated script that... calls the LIVE API N times
 * (default 3) on the audit prompts WITHOUT writing recordings."
 *
 * So this script spends real money on every invocation and REFUSES to run
 * without an explicit `--live` flag.
 *
 * WHAT IT REPLAYS VS. WHAT IT CALLS LIVE
 * -----------------------------------------------------------------
 * The scanner and critic answers are replayed from the fixture's recorded
 * `responses.json` (free, deterministic) to reconstruct the exact SELECTED
 * SET arcAudit would see in production - the same clips extendClipEnds
 * receives (index.ts: after selectAndOrder, before extendClipEnds). Only the
 * arc-audit prompts themselves are sent to the real API, N independent times
 * per clip set.
 *
 * The front half of analyzeHighlightsV2's pipeline (scanner -> merge -> teaser
 * -> critic-candidate selection -> critic -> evidence gate -> snap -> select)
 * is replayed via `replay-front-half.ts`'s `runFrontHalf`, not via a helper
 * threaded through index.ts, on purpose: the alternative (an exported "run
 * through selection" entry point) reshapes the orchestrator this task was
 * told not to alter beyond wiring the new stage in, for a benefit only this
 * script (and, since 2026-08-11, eval-selection-autopsy.ts) needs. The same
 * tradeoff teaser-sensitivity.ts and eval-arc-audit.ts already make
 * (rebuilding buildSentenceGraph externally rather than threading a helper
 * through index.ts). Three simplifications `runFrontHalf` deliberately makes,
 * because arc-audit's prompt never reads title/description text and never
 * cares about them:
 *   - `widenRangeToEvidence` (index.ts's own pre-snap evidence widening, up to
 *     EVIDENCE_BOUNDARY_SLACK_NODES=2 nodes) is skipped. It can shift a
 *     boundary by at most 2 nodes, which does not change whether arc-audit's
 *     verdict is stable, only very slightly which text it is stable ABOUT.
 *   - Copy repair (`scriptMismatch`/`repairCopy`, `regroundCopy`) is skipped
 *     entirely - it rewrites title/description only, never a node boundary,
 *     and would otherwise spend a second kind of live call this script has
 *     nothing to do with.
 *   - Transcript hole filtering (`missingRanges`) is skipped: real fixtures
 *     recorded from a complete source video carry none, and a candidate that
 *     did cross one would already be absent from the critic's own recorded
 *     verdicts.
 *
 * WHAT IT PRINTS
 * -----------------------------------------------------------------
 *   - a per-clip flag matrix: entry/exit/standalone verdicts, one row per run;
 *   - a per-clip stability verdict: "all-agree" when every axis's `ok` value
 *     matches across every run the clip was actually audited in, "split"
 *     otherwise, "incomplete" when the clip was unaudited (batch failure or
 *     omission) in at least one run - excluded from the agreement rate below
 *     because there is nothing to compare;
 *   - aggregate agreement %: all-agree clips over (all-agree + split) clips;
 *   - label agreement (only with `--labels`, same overlap matching
 *     eval-arc-audit.ts uses - imported from arc-audit-labels.ts, not
 *     reimplemented): whether the STABLE verdict (unanimous across runs) on
 *     each axis agrees with the labeled defect being present or absent. A
 *     split clip has no stable verdict to compare and is reported as such.
 *
 * `--json PATH` dumps the raw per-run matrix (every clip x every run x every
 * axis) for offline analysis.
 */
import { writeFileSync } from "fs";
import OpenAI from "openai";
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  parseVariantArgs,
  variantConfig,
  type Fixture,
} from "../__tests__/helpers/eval-fixture";
import { runArcAudit } from "../analyze-v2/arc-audit";
import { newUsage } from "../analyze-v2/llm";
import type { AnalyzeConfig } from "../analyze-v2/config";
import type { ArcFlags, SentenceNode, SnappedClip } from "../analyze-v2/types";
import { bestLabelMatch, loadLabels, type LabelEntry } from "./arc-audit-labels";
import { runFrontHalf } from "./replay-front-half";
import { join } from "path";

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

interface Flags {
  live: boolean;
  runs: number;
  jsonPath: string | undefined;
  labelsPath: string | undefined;
  rest: string[];
}

/** Pulls this script's own flags out BEFORE parseVariantArgs runs - it
 *  hard-errors on any "-"-prefixed token it does not recognise, the same
 *  discipline eval-arc-audit.ts's extractLabelsFlag protects. */
function extractFlags(argv: string[]): Flags {
  let live = false;
  let runs = 3;
  let jsonPath: string | undefined;
  let labelsPath: string | undefined;
  const rest: string[] = [];
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
    if (a === "--json") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) throw new Error("--json requires a path argument");
      jsonPath = v;
      continue;
    }
    if (a === "--labels") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) throw new Error("--labels requires a path argument");
      labelsPath = v;
      continue;
    }
    rest.push(a);
  }
  return { live, runs, jsonPath, labelsPath, rest };
}

// ---------------------------------------------------------------------------
// Replaying the pipeline up to and including selection. See the module doc
// comment for the three simplifications this deliberately makes.
// ---------------------------------------------------------------------------

async function buildSelectedSet(
  fixture: Fixture,
  cfg: AnalyzeConfig
): Promise<{ nodes: SentenceNode[]; selected: SnappedClip[] }> {
  const front = await runFrontHalf(fixture, cfg);
  return { nodes: front.nodes, selected: front.selection.selected };
}

// ---------------------------------------------------------------------------
// The live runs
// ---------------------------------------------------------------------------

interface AxisSnapshot {
  ok: boolean;
  defect?: string;
  missing?: string;
}
interface ClipSnapshot {
  entry: AxisSnapshot;
  exit: AxisSnapshot;
  standalone: AxisSnapshot;
}

function snapshotOf(flag: ArcFlags): ClipSnapshot {
  return {
    entry: { ok: flag.entry.ok, defect: flag.entry.defect },
    exit: { ok: flag.exit.ok, defect: flag.exit.defect },
    standalone: { ok: flag.standalone.ok, missing: flag.standalone.missing },
  };
}

async function runOnce(
  client: OpenAI,
  nodes: SentenceNode[],
  selected: SnappedClip[],
  cfg: AnalyzeConfig
): Promise<Map<string, ClipSnapshot>> {
  // arcAuditEnabled forced true regardless of the fixture's own config - this
  // script's whole point is to CALL the stage, and cfg here otherwise comes
  // from variantConfig(), which is env-blind and therefore always dark
  // (eval-fixture.ts's own doc comment on why: a stray env var must never
  // change what a replay means. This is not a replay, so the same argument
  // does not bind it, but the harness's cfg builder does not know that).
  const liveCfg: AnalyzeConfig = { ...cfg, arcAuditEnabled: true };
  const usage = newUsage();
  const { flags } = await runArcAudit(client, usage, selected, nodes, liveCfg);
  const out = new Map<string, ClipSnapshot>();
  for (const clip of selected) {
    const flag = flags.get(clip.verdict.id);
    if (flag) out.set(clip.verdict.id, snapshotOf(flag));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function axisAgrees(runs: AxisSnapshot[]): boolean {
  return runs.every((r) => r.ok === runs[0].ok);
}

function fmtAxis(a: AxisSnapshot | undefined): string {
  if (!a) return "-unaudited-".padEnd(18);
  return (a.ok ? "ok" : (a.defect ?? a.missing ?? "flagged")).padEnd(18);
}

async function main() {
  const { live, runs, jsonPath, labelsPath, rest } = extractFlags(process.argv.slice(2));
  const { variant, cases } = parseVariantArgs(rest);
  const [fixtureName] = cases;
  if (!fixtureName || !variant) {
    console.error(
      "usage: eval-arc-stability.ts --live [--variant NAME] [--runs N] " +
        "[--json PATH] [--labels PATH] <fixture>"
    );
    process.exit(1);
  }

  if (!live) {
    console.error(
      "[eval-arc-stability] REFUSING to run without --live.\n" +
        `This spends real API money on every invocation: ${runs} independent full ` +
        "audit pass(es) over the fixture's selected set, at the arc-audit model's " +
        "list price, batched at cfg.arcAuditBatchSize per call. Re-run with --live " +
        "to proceed, once you have the owner's go-ahead (spec 2026-08-10 rule: " +
        "\"Costs money -> stop and ask\")."
    );
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("[eval-arc-stability] OPENAI_API_KEY is not set - refusing to make a live call.");
    process.exit(1);
  }

  const fixture = loadFixture(fixtureName);
  const cfg = variantConfig(variant);
  const { nodes, selected } = await buildSelectedSet(fixture, cfg);

  console.log(
    `fixture: ${fixtureName}${variant === BASE_VARIANT ? "" : `[${variant}]`}  ` +
      `selected clips: ${selected.length}  runs: ${runs}  ` +
      `model: ${cfg.criticModel}  batchSize: ${cfg.arcAuditBatchSize}`
  );
  if (selected.length === 0) {
    console.log("nothing selected - nothing to audit.");
    return;
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const perRun: Array<Map<string, ClipSnapshot>> = [];
  for (let i = 0; i < runs; i++) {
    console.log(`  running pass ${i + 1}/${runs}...`);
    perRun.push(await runOnce(client, nodes, selected, cfg));
  }

  // -------------------------------------------------------------------------
  // per-clip matrix + stability verdict
  // -------------------------------------------------------------------------
  console.log("\nper-clip flag matrix (one row per run):");
  let allAgree = 0;
  let split = 0;
  let incomplete = 0;
  const stableByClip = new Map<string, ClipSnapshot | null>();

  for (const clip of selected) {
    const id = clip.verdict.id;
    const rows = perRun.map((m) => m.get(id));
    console.log(
      `\n[${id}] ${clip.startSec.toFixed(1)}-${clip.endSec.toFixed(1)}s ` +
        `nodes #${clip.finalStartNode}..#${clip.finalEndNode}`
    );
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      console.log(
        `    run ${i + 1}: entry=${fmtAxis(r?.entry)}  exit=${fmtAxis(r?.exit)}  ` +
          `standalone=${fmtAxis(r?.standalone)}`
      );
    }

    if (rows.some((r) => r === undefined)) {
      incomplete += 1;
      stableByClip.set(id, null);
      console.log("    verdict: INCOMPLETE (unaudited on at least one run)");
      continue;
    }
    const present = rows as ClipSnapshot[];
    const agrees =
      axisAgrees(present.map((r) => r.entry)) &&
      axisAgrees(present.map((r) => r.exit)) &&
      axisAgrees(present.map((r) => r.standalone));
    if (agrees) {
      allAgree += 1;
      stableByClip.set(id, present[0]);
      console.log("    verdict: all-agree");
    } else {
      split += 1;
      stableByClip.set(id, null);
      console.log("    verdict: SPLIT");
    }
  }

  const comparable = allAgree + split;
  // Per-AXIS agreement alongside the per-clip AND-of-three: the per-clip number
  // is the strictest possible reading (one flaky axis fails the whole clip),
  // while task 3/4 route by INDIVIDUAL axes - a clip with a rock-stable entry
  // flag and a flaky exit still repairs its entry correctly. Report both so
  // neither can masquerade as the other.
  let axesAgree = 0;
  let axesTotal = 0;
  for (const clip of selected) {
    const rows = perRun.map((m) => m.get(clip.verdict.id));
    if (rows.some((r) => r === undefined)) continue;
    const present = rows as ClipSnapshot[];
    for (const pick of [
      present.map((r) => r.entry),
      present.map((r) => r.exit),
      present.map((r) => r.standalone),
    ]) {
      axesTotal += 1;
      if (axisAgrees(pick)) axesAgree += 1;
    }
  }
  console.log(
    `\naggregate agreement: ${allAgree}/${comparable} clips ` +
      `(${comparable > 0 ? ((100 * allAgree) / comparable).toFixed(1) : "-"}%)` +
      `  |  ${axesAgree}/${axesTotal} axes ` +
      `(${axesTotal > 0 ? ((100 * axesAgree) / axesTotal).toFixed(1) : "-"}%)` +
      `  incomplete: ${incomplete}/${selected.length}`
  );
  // The panel-variance lesson this acceptance criterion exists to check
  // against (spec 2026-08-10 §3 M3): "if it is ~40% unstable per clip like
  // the panel, that is a kill result for the design."
  if (comparable > 0 && split / comparable >= 0.4) {
    console.log(
      "  >= 40% split - the same instability the finalizer panel showed " +
        "(engine-notes §8b). Read this as a candidate kill result, not noise."
    );
  }

  // -------------------------------------------------------------------------
  // label agreement (optional)
  // -------------------------------------------------------------------------
  const labelsPathResolved = labelsPath ?? join(FIXTURES_DIR, fixtureName, "labels.json");
  const labels: LabelEntry[] = loadLabels(labelsPathResolved);
  if (labels.length > 0) {
    console.log(`\nlabel agreement (${labels.length} labeled moments, ${labelsPathResolved}):`);
    for (const clip of selected) {
      const id = clip.verdict.id;
      const stable = stableByClip.get(id);
      const match = bestLabelMatch({ start: clip.startSec, end: clip.endSec }, labels);
      if (!match || match.iou === 0) {
        console.log(`  [${id}] no labeled moment overlaps this range`);
        continue;
      }
      const label = match.entry;
      const labeledEntryBad = Boolean(label.entryDefect);
      const labeledExitBad = Boolean(label.exitDefect);
      // `stable` is `undefined` only if `id` were absent from stableByClip,
      // which cannot happen - the earlier loop sets an entry (null or a
      // snapshot) for every clip in `selected`, and this loop iterates the
      // same array. Checked with `== null` so the compiler, not just the
      // reasoning above, treats the two as one case.
      if (stable == null) {
        console.log(
          `  [${id}] IoU=${match.iou.toFixed(2)} vs "${label.productionTitle ?? "?"}" - ` +
            "SPLIT, no stable verdict to compare"
        );
        continue;
      }
      const entryAgrees = stable.entry.ok === !labeledEntryBad;
      const exitAgrees = stable.exit.ok === !labeledExitBad;
      console.log(
        `  [${id}] IoU=${match.iou.toFixed(2)} vs "${label.productionTitle ?? "?"}"  ` +
          `entry ${entryAgrees ? "agrees" : "DISAGREES"} (labeled ${label.entryDefect ?? "clean"}, ` +
          `audit ${stable.entry.ok ? "clean" : (stable.entry.defect ?? "flagged")})  ` +
          `exit ${exitAgrees ? "agrees" : "DISAGREES"} (labeled ${label.exitDefect ?? "clean"}, ` +
          `audit ${stable.exit.ok ? "clean" : (stable.exit.defect ?? "flagged")})`
      );
    }
  }

  // -------------------------------------------------------------------------
  // --json dump
  // -------------------------------------------------------------------------
  if (jsonPath) {
    const dump = selected.map((clip) => ({
      id: clip.verdict.id,
      startSec: clip.startSec,
      endSec: clip.endSec,
      startNode: clip.finalStartNode,
      endNode: clip.finalEndNode,
      runs: perRun.map((m) => m.get(clip.verdict.id) ?? null),
    }));
    writeFileSync(jsonPath, JSON.stringify(dump, null, 2));
    console.log(`\nraw matrix written to ${jsonPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
