/**
 * Acceptance measurement for the montage detector. Not shipped logic - a bench.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/teaser-sensitivity.ts"
 *
 * The unit tests pin the RULES on a synthetic graph; this pins the properties
 * that actually matter, on real transcripts:
 *
 *   1. the three-case table - the real montage is caught, a constructed
 *      legitimate cold open is not, and ordinary conversation never is;
 *   2. indel sensitivity - what happens when discourse particles are inserted
 *      into and deleted from the montage AND its later originals independently,
 *      which is what two transcription runs of one audio actually differ by.
 *
 * It reports SURVIVING HIT COUNT, not a per-candidate similarity score. The
 * previous version of this bench measured "how many single-word changes push
 * candidate X below the bar", which was the right question for a filter that no
 * longer exists - and whose answers were what proved the approach unfixable
 * (see analyze-v2/teaser.ts). Any change to teaser.ts should re-run this.
 *
 * Baseline to beat (2026-07-25, both fixtures, on the region detector):
 *   real montage                      11 hits, region 0.0-44.6s, end 59.6s
 *   same episode, montage deleted      0 hits -> no region
 *   constructed legitimate cold open   1 hit  -> no region
 *   same with three quotes             2 hits -> no region
 *   ordinary conversation (sweep)     ceiling 2 hits over 1623 later offsets,
 *                                     0 of them reach minHits
 *   worst-case indels, one side       3-5 hits, region still covers the defect
 *   random indels, every sentence     fires 8-10 of 10 seeds
 *
 * KNOWN BREAKING POINT, stated because a bench that only prints its wins is
 * worth nothing: "insert in every COPY + delete in every ORIGINAL" produces 0
 * hits on podcast-ecology (3 on podcast-answer-arc). That construction puts one
 * edit at the exact midpoint of all 861 sentences at once, in opposite
 * directions on the two sides of every match - an adversary who knows the
 * algorithm, not a transcription model. The same edit rate placed RANDOMLY
 * (p=1.00 below) fires on 10 of 10 seeds. The real jitter between these two
 * fixtures is 67 edits over ~9000 words, i.e. p is about 0.08, where every seed
 * fires with 8-11 hits. Recall past that point is the finalizer's LLM judge and
 * the 6s duration floor, which is the trade this filter is built for.
 */
import { loadFixture, FIXTURES_DIR } from "../__tests__/helpers/eval-fixture";
import { createReplayClient } from "../__tests__/helpers/replay-client";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { runScanner } from "../analyze-v2/scanner";
import { mergeCandidates } from "../analyze-v2/candidates";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import {
  buildRecurrenceIndex,
  nodeRecurrence,
  detectTeaserRegion,
  isInTeaserRegion,
  TEASER_RECUR_BAR,
  TEASER_MAX_HIT_GAP_SEC,
  TEASER_REGION_PAD_SEC,
} from "../analyze-v2/teaser";
import type { SentenceNode } from "../analyze-v2/types";
import { readdirSync } from "fs";

// Directories only: FIXTURES_DIR also holds variants.json, which is not a fixture.
const CASES = readdirSync(FIXTURES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/** The owner-reported defect: podcast-ecology 36.68-39.30s, six words that
 *  occur exactly once in the episode. The region must reach it. */
const DEFECT_START_SEC = 36.68;

/** The legitimate cold open both fixtures contain. The region must not. */
const COLD_OPEN_SEC = 86.3;

// ---------------------------------------------------------------------------
// region growth from an arbitrary anchor - the shipped rule is this one
// anchored at 0, so the sweep below is strictly MORE permissive than what ships
// ---------------------------------------------------------------------------

interface Grown {
  hits: number;
  firstStart: number;
  lastEnd: number;
}

function growFrom(
  nodes: SentenceNode[],
  shares: number[],
  from: number,
  anchorSec: number,
  windowSec: number
): Grown {
  let reach = anchorSec;
  let hits = 0;
  let firstStart = anchorSec;
  let lastEnd = anchorSec;
  for (let i = from; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.start > anchorSec + windowSec) break;
    if (n.start > reach + TEASER_MAX_HIT_GAP_SEC) break;
    if (shares[i] < TEASER_RECUR_BAR) continue;
    if (hits === 0) firstStart = n.start;
    hits += 1;
    reach = n.end;
    lastEnd = n.end;
  }
  return { hits, firstStart, lastEnd };
}

function sharesOf(nodes: SentenceNode[]): number[] {
  const ix = buildRecurrenceIndex(nodes);
  return nodes.map((_, i) => nodeRecurrence(ix, i).share);
}

// ---------------------------------------------------------------------------
// jitter models
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The particles that actually differ between the two fixtures, taken from the
 *  LCS alignment of one against the other. */
const PARTICLES = [
  "значит", "вот", "да", "когда", "надо", "если",
  "допустим", "там", "ну", "можно", "сказать",
];

const RESPELL: Record<string, string> = { е: "ё", ё: "е", и: "й", о: "а", а: "о", с: "з", т: "д" };
function respell(word: string): string {
  for (let i = word.length - 1; i >= 0; i--) {
    const r = RESPELL[word[i]];
    if (r) return word.slice(0, i) + r + word.slice(i + 1);
  }
  return `${word}х`;
}

type Edit = "insert" | "delete" | "respell" | "any";

function edit(text: string, kind: Edit, r: () => number): string {
  const w = text.split(/\s+/).filter(Boolean);
  if (w.length < 2) return text;
  const at = Math.floor(r() * w.length);
  const pick: Edit = kind === "any" ? (["insert", "delete", "respell"] as const)[Math.floor(r() * 3)] : kind;
  if (pick === "insert") w.splice(at, 0, PARTICLES[Math.floor(r() * PARTICLES.length)]);
  else if (pick === "delete") w.splice(at, 1);
  else w[at] = respell(w[at]);
  return w.join(" ");
}

/** Edit every node in [from, to) with probability p, at a random position.
 *  Copies and originals are different nodes, so editing both desynchronises
 *  them - which is exactly what killed the previous filter's aligned path. */
function jitter(
  nodes: SentenceNode[],
  from: number,
  to: number,
  kind: Edit,
  p: number,
  seed: number
): SentenceNode[] {
  const r = rng(seed);
  return nodes.map((n, i) => {
    if (i < from || i >= to) return n;
    if (r() >= p) return n;
    return { ...n, text: edit(n.text, kind, r) };
  });
}

/** Worst-case placement: one edit at the exact midpoint of every node, where it
 *  does the most damage to a verbatim run. */
function worstCase(nodes: SentenceNode[], from: number, to: number, kind: "insert" | "delete"): SentenceNode[] {
  return nodes.map((n, i) => {
    if (i < from || i >= to) return n;
    const w = n.text.split(/\s+/).filter(Boolean);
    if (w.length < 2) return n;
    const at = Math.floor(w.length / 2);
    if (kind === "insert") w.splice(at, 0, PARTICLES[i % PARTICLES.length]);
    else w.splice(at, 1);
    return { ...n, text: w.join(" ") };
  });
}

// ---------------------------------------------------------------------------

function regionLine(nodes: SentenceNode[], windowSec: number): string {
  const g = growFrom(nodes, sharesOf(nodes), 0, 0, windowSec);
  if (g.hits === 0) return "hits  0   no region";
  const end = g.lastEnd + TEASER_REGION_PAD_SEC;
  return (
    `hits ${String(g.hits).padStart(2)}   ${g.firstStart.toFixed(1)}-${g.lastEnd.toFixed(1)}s ` +
    `end ${end.toFixed(1)}s   defect ${end > DEFECT_START_SEC ? "COVERED" : "escapes"}   ` +
    `cold open ${end > COLD_OPEN_SEC ? "EATEN" : "safe"}`
  );
}

/** Where the montage ends and the real show begins, found from the transcript
 *  rather than hardcoded: the host's own opening line. */
function showStartNode(nodes: SentenceNode[]): number {
  const at = nodes.findIndex((n) => n.text.includes("Всем привет"));
  return at >= 0 ? at : 14;
}

async function main() {
  const cfg = { ...loadAnalyzeConfig({}), engine: "recall-critic" as const };
  const W = cfg.teaserWindowSec;

  for (const name of CASES) {
    const fixture = loadFixture(name);
    const nodes = buildSentenceGraph(fixture.transcript.segments, cfg);
    const shares = sharesOf(nodes);
    const show = showStartNode(nodes);
    console.log(`\n============ ${name}  (${nodes.length} nodes, show starts at node ${show}) ============`);

    // --- 1. per-node recurrence in the opening ------------------------------
    console.log("\n-- per-node recurrence, opening window --");
    for (let i = 0; i < nodes.length && nodes[i].start <= 60; i++) {
      console.log(
        `  ${String(i).padStart(3)} ${nodes[i].start.toFixed(2).padStart(6)}s  ` +
          `${shares[i].toFixed(3)}${shares[i] >= TEASER_RECUR_BAR ? " HIT " : "     "} ` +
          nodes[i].text.slice(0, 56)
      );
    }

    // --- 2. the three-case table -------------------------------------------
    console.log("\n-- THREE-CASE TABLE --");
    console.log(`  A real montage (as shipped)             ${regionLine(nodes, W)}`);

    const withoutMontage = nodes.slice(show).map((n, i) => ({ ...n, index: i }));
    console.log(`  B same episode, montage deleted         ${regionLine(withoutMontage, W)}`);

    // A sentence the guest genuinely says once, mid-episode, moved to 8.0s -
    // a real cold open, not a montage copy. This is the case attempt 2 dropped.
    const quoteAt = (needle: string) => nodes.findIndex((n) => n.text.includes(needle));
    const quote = quoteAt("заражает только двугорбового верблюда");
    if (quote >= 0) {
      const cold: SentenceNode[] = [
        { ...withoutMontage[0], index: 0, start: 8.0, end: 12.5, text: nodes[quote].text },
        ...withoutMontage.map((n, i) => ({ ...n, index: i + 1 })),
      ];
      console.log(`  C constructed legit cold open (1 quote) ${regionLine(cold, W)}`);
      const three: SentenceNode[] = [
        ...[quote, quote + 1, quote + 2].map((q, k) => ({
          ...withoutMontage[0],
          index: k,
          start: 2 + k * 6,
          end: 6 + k * 6,
          text: nodes[q].text,
        })),
        ...withoutMontage.map((n, i) => ({ ...n, index: i + 3 })),
      ];
      console.log(`  D same, three quotes back to back       ${regionLine(three, W)}`);
    }

    // Ordinary conversation: the same growth run UNANCHORED from every node
    // start after 200s. Strictly more permissive than what ships, which can
    // only ever grow from t=0.
    const hist = new Map<number, number>();
    let ceiling = 0;
    let ceilingAt = "";
    let offsets = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].start <= 200) continue;
      offsets += 1;
      const g = growFrom(nodes, shares, i, nodes[i].start, W);
      hist.set(g.hits, (hist.get(g.hits) ?? 0) + 1);
      if (g.hits > ceiling) {
        ceiling = g.hits;
        ceilingAt = `${g.firstStart.toFixed(1)}-${g.lastEnd.toFixed(1)}s`;
      }
    }
    console.log(
      `  E ordinary conversation, ${String(offsets).padStart(3)} offsets    ceiling ${ceiling} hits @${ceilingAt}   ` +
        `dist ${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([h, c]) => `${h}:${c}`).join(" ")}   ` +
        `fires at minHits=${cfg.teaserMinHits}: ${[...hist.entries()].filter(([h]) => h >= cfg.teaserMinHits).reduce((s, [, c]) => s + c, 0)}`
    );

    // --- 3. indel sensitivity ----------------------------------------------
    console.log("\n-- INDEL TABLE (copies = nodes 0.." + (show - 1) + ", originals = " + show + "..) --");
    const worst: Array<[string, SentenceNode[]]> = [
      ["insert a particle mid-sentence in every COPY", worstCase(nodes, 0, show, "insert")],
      ["delete a word mid-sentence from every COPY", worstCase(nodes, 0, show, "delete")],
      ["insert a particle in every ORIGINAL", worstCase(nodes, show, nodes.length, "insert")],
      ["delete a word from every ORIGINAL", worstCase(nodes, show, nodes.length, "delete")],
      [
        "insert in every COPY + delete in every ORIGINAL",
        worstCase(worstCase(nodes, 0, show, "insert"), show, nodes.length, "delete"),
      ],
      [
        "delete in every COPY + insert in every ORIGINAL",
        worstCase(worstCase(nodes, 0, show, "delete"), show, nodes.length, "insert"),
      ],
    ];
    for (const [label, g] of worst) {
      console.log(`  ${label.padEnd(50)} ${regionLine(g, W)}`);
    }

    console.log("  -- random placement, whole transcript, 10 seeds --");
    for (const p of [0.1, 0.25, 0.5, 1.0]) {
      const hits: number[] = [];
      let covered = 0;
      let ate = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const g = jitter(nodes, 0, nodes.length, "any", p, seed * 7919);
        const grown = growFrom(g, sharesOf(g), 0, 0, W);
        hits.push(grown.hits);
        const end = grown.lastEnd + TEASER_REGION_PAD_SEC;
        if (grown.hits >= cfg.teaserMinHits && end > DEFECT_START_SEC) covered += 1;
        if (grown.hits >= cfg.teaserMinHits && end > COLD_OPEN_SEC) ate += 1;
      }
      hits.sort((a, b) => a - b);
      console.log(
        `  one edit per sentence with p=${p.toFixed(2)}   hits [${hits.join(",")}]   ` +
          `fires ${hits.filter((h) => h >= cfg.teaserMinHits).length}/10   ` +
          `defect covered ${covered}/10   cold open eaten ${ate}/10`
      );
    }

    // --- 4. the real merged candidates --------------------------------------
    const client = createReplayClient(fixture.responses);
    const scan = await runScanner(client as never, newUsage(), nodes, cfg, { retryDelayMs: 1 });
    const merged = mergeCandidates(scan.candidates, nodes, cfg);
    const region = detectTeaserRegion(nodes, cfg);
    console.log("\n-- real merged candidates in the opening window --");
    for (const c of merged) {
      const n = nodes[c.startNode];
      if (!n || n.start > W) continue;
      console.log(
        `  ${c.id.padEnd(4)} ${n.start.toFixed(2)}-${nodes[c.endNode].end.toFixed(2)}s  ` +
          `${isInTeaserRegion(region, n.start) ? "DROP" : "keep"}`
      );
    }
    const late = merged.filter((c) => nodes[c.startNode] && nodes[c.startNode].start > W);
    const lateDropped = late.filter((c) => isInTeaserRegion(region, nodes[c.startNode].start)).length;
    console.log(`  [candidates starting after the window] n=${late.length}  dropped ${lateDropped}`);
  }
}

void main();
