/**
 * Replay-only, zero-cost audit of clip ENTRIES and EXITS (spec 2026-08-10
 * "Clip arc audit: entries, exits and self-containment", §3 M2, task 1).
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-arc-audit.ts \
 *        [--variant NAME] [--labels PATH] <fixture>"
 *
 * Motivated by the owner's verdict on job cmsnmcbec005ouhfj30l0w4qm: clips
 * open mid-story without context and end mid-thought. Five of twelve clips
 * opened on a coordinating connective or an unresolved anaphor, and the
 * top-scored clip was the most broken one - the critic's score does not rank
 * postability (design doc §0). This script measures how often the SHIPPED
 * SET carries that shape, on every fixture, for free - no boundary changes,
 * no model calls, nothing here is a gate. The onset counters are TELEMETRY:
 * "'А помогают ли...' opens on a particle and is a fine hook; the counter
 * measures, the audit judges" (design doc §3).
 *
 * Shaped exactly after eval-end-audit.ts: same parseVariantArgs -> loadFixture
 * -> runFixtureVariant flow, one fixture per invocation, base variant is the
 * default so the pre-change baseline is still one word away.
 *
 * Per shipped clip, prints:
 *   - the shipped time range and the node range that actually shipped
 *     (`_startNode`/`_endNode` - the CLIP's range, not the critic's proposal,
 *     same distinction eval-end-audit and toHighlight's own comment make);
 *   - OPENING: the first word-bearing node's text, and its onset analysis
 *     (rawFirst / conn / pron / q - see arc-audit-onset.ts);
 *   - ENDING: the last word-bearing node's text, and the tail after payoffAt;
 *   - evOut: evidence nodes (title + description) cited outside the shipped
 *     range - "the critic cited context outside its own clip" signal, free
 *     because it is already persisted (design doc §0: the 0.90 clip's own
 *     description evidence sits two nodes before its own start);
 *   - title.
 *
 * Then a distribution block: how many clips carry each onset flag, and the
 * tail-after-payoff spread (same shape as eval-end-audit's tail block).
 *
 * `--labels PATH` (optional): if a labels.json exists for the fixture (task 0
 * of the same spec - NOT required for this script to run) or a path is given
 * explicitly, prints each shipped clip's best time-overlap (IoU) against the
 * labeled moments and that label's defect axis. Tolerant by design: task 0
 * has not necessarily run yet, so the reader must not assume any particular
 * labels.json shape beyond what task 0's spec commits to (`{ ownerVerdict,
 * entryDefect, exitDefect, scoutConsensusStart?, scoutConsensusEnd? }` per
 * clip) - a missing file, an unexpected shape, or entries with no usable
 * range are all treated as "nothing to report" rather than an error.
 */
import { join } from "path";
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  parseVariantArgs,
  runFixtureVariant,
  variantConfig,
} from "../__tests__/helpers/eval-fixture";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import type { SentenceNode, V2Highlight } from "../analyze-v2/types";
import { classifyOnset } from "./arc-audit-onset";
import { bestLabelMatch, loadLabels } from "./arc-audit-labels";

const OPENING_TRUNCATE = 60;

function truncate(text: string, max: number = OPENING_TRUNCATE): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}...`;
}

/** First word-bearing node in [startNode, endNode], inclusive. `hasWords`
 *  is the graph's own opaque/music/crosstalk flag - snap's clean-start guard
 *  should already land _startNode on one, but this walks forward defensively
 *  rather than assuming it, the same caution eval-end-audit takes with an
 *  absent payoffAt. */
function firstWordNode(
  nodes: SentenceNode[],
  startNode: number,
  endNode: number
): SentenceNode | undefined {
  for (let i = startNode; i <= endNode; i++) {
    if (nodes[i]?.hasWords) return nodes[i];
  }
  return undefined;
}

/** Last word-bearing node in [startNode, endNode], inclusive - mirrors
 *  firstWordNode, walking from the end. */
function lastWordNode(
  nodes: SentenceNode[],
  startNode: number,
  endNode: number
): SentenceNode | undefined {
  for (let i = endNode; i >= startNode; i--) {
    if (nodes[i]?.hasWords) return nodes[i];
  }
  return undefined;
}

interface EvidenceOutside {
  tag: "title" | "desc";
  node: number;
  dist: number; // signed: negative = before _startNode, positive = after _endNode
}

/** Evidence nodes the critic cited that lie outside the clip's own shipped
 *  range - the node-738 signal (design doc §0): "the critic cited the girl's
 *  setup two nodes BEFORE its own start, and its description honestly
 *  narrates both stories... The model knew the arc; the boundary cut it." */
function evidenceOutside(h: V2Highlight): EvidenceOutside[] {
  const startNode = h._startNode;
  const endNode = h._endNode;
  const out: EvidenceOutside[] = [];
  if (startNode === undefined || endNode === undefined) return out;
  const scan = (tag: "title" | "desc", ids: number[] | undefined) => {
    for (const n of ids ?? []) {
      if (n < startNode) out.push({ tag, node: n, dist: n - startNode });
      else if (n > endNode) out.push({ tag, node: n, dist: n - endNode });
    }
  };
  scan("title", h._titleEvidenceNodes);
  scan("desc", h._descriptionEvidenceNodes);
  return out;
}

function formatEvOut(items: EvidenceOutside[]): string {
  if (items.length === 0) return "-";
  return items
    .map((e) => `${e.tag}:${e.node}(${e.dist > 0 ? "+" : ""}${e.dist})`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// --labels: optional, tolerant. See the module doc comment for why the shape
// is treated as loose rather than asserted. LabelEntry/loadLabels/labelRange/
// iou/bestLabelMatch now live in arc-audit-labels.ts (imported above) so
// eval-arc-stability.ts can import the SAME reader and overlap matching
// without importing this file's own executable `main()`.
// ---------------------------------------------------------------------------

/** Every option this script accepts besides --variant (which parseVariantArgs
 *  already knows and hard-errors on typos of). Pulled out BEFORE
 *  parseVariantArgs runs, because parseVariantArgs hard-errors on any
 *  "-"-prefixed token it does not recognise - the same discipline that
 *  protects --variant from a silent typo would otherwise reject --labels. */
function extractLabelsFlag(argv: string[]): { labelsPath: string | undefined; rest: string[] } {
  const idx = argv.indexOf("--labels");
  if (idx === -1) return { labelsPath: undefined, rest: argv };
  const value = argv[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new Error("--labels requires a path argument");
  }
  return {
    labelsPath: value,
    rest: [...argv.slice(0, idx), ...argv.slice(idx + 2)],
  };
}

async function main() {
  const { labelsPath: labelsOverride, rest } = extractLabelsFlag(process.argv.slice(2));
  const { variant, cases } = parseVariantArgs(rest);
  const [fixtureName] = cases;
  if (!fixtureName || !variant) {
    console.error("usage: eval-arc-audit.ts [--variant NAME] [--labels PATH] <fixture>");
    process.exit(1);
  }

  const fixture = loadFixture(fixtureName);
  const result = await runFixtureVariant(fixture, variant);

  // Rebuilt, not carried on the highlight: buildSentenceGraph is a pure
  // function of (segments, cfg), and `cfg` here is exactly what
  // runFixtureVariant passed to analyzeHighlightsV2 (variantConfig(variant)),
  // so this reproduces the SAME node array byte for byte - same pattern as
  // eval-laugh-probe.ts and teaser-sensitivity.ts.
  const nodes = buildSentenceGraph(fixture.transcript.segments, variantConfig(variant));

  const labelsPath =
    labelsOverride ?? join(FIXTURES_DIR, fixtureName, "labels.json");
  const labels = loadLabels(labelsPath);

  console.log(
    `fixture: ${fixtureName}${variant === BASE_VARIANT ? "" : `[${variant}]`}  ` +
      `clips: ${result.highlights.length}` +
      (labels.length > 0 ? `  labels: ${labels.length} (${labelsPath})` : "")
  );

  interface Row {
    h: V2Highlight;
    opening: OnsetRow;
    closing: { text: string; tail: number };
    evOut: EvidenceOutside[];
  }
  interface OnsetRow {
    text: string;
    rawFirst: string;
    conn: boolean;
    pron: boolean;
    q: boolean;
  }

  const rows: Row[] = result.highlights.map((h) => {
    const startNode = h._startNode;
    const endNode = h._endNode;
    const openingNode =
      startNode !== undefined && endNode !== undefined
        ? firstWordNode(nodes, startNode, endNode)
        : undefined;
    const closingNode =
      startNode !== undefined && endNode !== undefined
        ? lastWordNode(nodes, startNode, endNode)
        : undefined;
    const openingText = openingNode?.text ?? "(no word-bearing node in range)";
    const closingText = closingNode?.text ?? "(no word-bearing node in range)";
    const onset = classifyOnset(openingText);
    const payoff = h.payoffAt;
    const tail = typeof payoff === "number" ? h.end - payoff : NaN;
    return {
      h,
      opening: { text: openingText, ...onset },
      closing: { text: closingText, tail },
      evOut: evidenceOutside(h),
    };
  });

  for (const [i, { h, opening, closing, evOut }] of rows.entries()) {
    const startNode = h._startNode ?? -1;
    const endNode = h._endNode ?? -1;
    console.log(
      `\n[${i + 1}] ${h.start.toFixed(1)}-${h.end.toFixed(1)} ` +
        `(${(h.end - h.start).toFixed(1)}s)  nodes ${startNode}..${endNode}`
    );
    console.log(`    OPENING: "${truncate(opening.text)}"`);
    console.log(
      `      rawFirst="${opening.rawFirst}"  conn=${opening.conn}  pron=${opening.pron}  q=${opening.q}`
    );
    console.log(`    ENDING:  "${truncate(closing.text)}"`);
    console.log(
      `      tail=${Number.isFinite(closing.tail) ? `${closing.tail.toFixed(1)}s` : "-"}` +
        (typeof h.payoffAt === "number" ? `  (payoffAt=${h.payoffAt.toFixed(1)})` : "")
    );
    console.log(`    evOut: ${formatEvOut(evOut)}`);
    console.log(`    title: ${h.title}`);
    // Present only when the run carried the arcAudit stage (variant arc-audit)
    // and this clip was audited - absent keys stay silent so a base replay's
    // output is unchanged.
    if (h._arcFlags) {
      const f = h._arcFlags;
      const axis = (
        a: { ok: boolean; defect?: string; missing?: string },
        fix?: number
      ) =>
        a.ok
          ? "ok"
          : `FLAG ${a.defect ?? a.missing ?? "?"}${fix !== undefined ? ` fix->#${fix}` : ""}`;
      console.log(
        `    arcAudit: entry=${axis(f.entry, f.entry.fixStartNode)}  ` +
          `exit=${axis(f.exit, f.exit.fixEndNode)}  ` +
          `standalone=${f.standalone.ok ? "ok" : `FLAG (${f.standalone.missing ?? "?"})`}`
      );
    }

    if (labels.length > 0) {
      const best = bestLabelMatch(h, labels);
      if (best && best.iou > 0) {
        const e = best.entry;
        console.log(
          `    labels: IoU=${best.iou.toFixed(2)} vs "${e.productionTitle ?? "?"}"  ` +
            `entryDefect=${e.entryDefect ?? "-"}  exitDefect=${e.exitDefect ?? "-"}  ` +
            `ownerVerdict=${e.ownerVerdict ?? "-"}  (${e.provenance ?? "?"})`
        );
        const sc = e.scoutConsensus;
        if (sc && (sc.start !== null || sc.end !== null)) {
          console.log(
            `      scoutConsensus: ${sc.start ?? "?"}-${sc.end ?? "?"}` +
              (sc.agreement ? ` (${sc.agreement})` : "")
          );
        }
      } else {
        console.log(`    labels: no labeled moment overlaps this range`);
      }
    }
  }

  // The distribution is the finding, same as eval-end-audit's tail block:
  // individual rows say WHERE, this says HOW OFTEN, and "how often" is what
  // task 2's acceptance criteria (M3) get measured against.
  const n = rows.length;
  const connCount = rows.filter((r) => r.opening.conn).length;
  const pronCount = rows.filter((r) => r.opening.pron).length;
  const bothCount = rows.filter((r) => r.opening.conn && r.opening.pron).length;
  const evOutCount = rows.filter((r) => r.evOut.length > 0).length;
  const pct = (k: number) => (n > 0 ? `${((100 * k) / n).toFixed(1)}%` : "-");

  console.log(`\nonset distribution over ${n} shipped clip(s):`);
  console.log(`  conn=true:   ${connCount}/${n}  (${pct(connCount)})`);
  console.log(`  pron=true:   ${pronCount}/${n}  (${pct(pronCount)})`);
  console.log(`  both:        ${bothCount}/${n}  (${pct(bothCount)})`);
  console.log(`  evOut nonempty: ${evOutCount}/${n}  (${pct(evOutCount)})`);

  const tails = rows
    .map((r) => r.closing.tail)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (tails.length > 0) {
    console.log(
      `\ntail after payoff: min ${tails[0].toFixed(1)}s  median ${tails[
        Math.floor(tails.length / 2)
      ].toFixed(1)}s  max ${tails[tails.length - 1].toFixed(1)}s`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
