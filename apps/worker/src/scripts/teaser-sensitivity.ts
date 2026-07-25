/**
 * Acceptance measurement for the montage filter. Not shipped logic - a bench.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/teaser-sensitivity.ts"
 *
 * The unit tests pin the RULES; this pins the property that actually matters -
 * that the signal survives transcription jitter on real transcripts. It replays
 * each eval fixture's scanner responses, rebuilds the merged candidates exactly
 * as the engine does, and for every candidate in the opening window respells
 * each of its words in turn, counting how many single-word changes drop it
 * below the bar. Any change to teaser.ts should re-run this.
 *
 * Baseline to beat (2026-07-25, after the jitter fix):
 *   answer-arc c0 49w base 0.875 -> 0 of 49 fall below
 *   answer-arc c1 18w base 0.833 -> 0 of 18
 *   ecology    c0 20w base 1.000 -> 0 of 20
 *   ecology    c1  6w base 1.000 -> 0 of 6
 *   ecology    c2  6w base 1.000 -> 0 of 6
 *   ordinary candidates starting after the window: 61 of 61 score exactly 0.000
 */
import { loadFixture, FIXTURES_DIR } from "../__tests__/helpers/eval-fixture";
import { createReplayClient } from "../__tests__/helpers/replay-client";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { runScanner } from "../analyze-v2/scanner";
import { mergeCandidates } from "../analyze-v2/candidates";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import { montageScore, isTeaserCandidate } from "../analyze-v2/teaser";
import type { SentenceNode } from "../analyze-v2/types";
import { readdirSync } from "fs";

const CASES = readdirSync(FIXTURES_DIR).sort();

/** A plausible single-word transcription variant: swap one letter for a
 *  visually/phonetically adjacent one. Any change works - the point is that ONE
 *  word came out differently in another run of the same audio. */
function respell(word: string): string {
  const map: Record<string, string> = {
    е: "ё", ё: "е", и: "й", й: "и", о: "а", а: "о", с: "сс", т: "тт",
    e: "a", a: "e", o: "0", t: "tt",
  };
  for (let i = word.length - 1; i >= 0; i--) {
    const r = map[word[i]];
    if (r) return word.slice(0, i) + r + word.slice(i + 1);
  }
  return word + "х";
}

function wordsOf(nodes: SentenceNode[], from: number, to: number): string[] {
  return nodes
    .slice(from, to + 1)
    .map((n) => n.text)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Rebuild the node slice with the k-th word of the candidate respelled. */
function mutate(
  nodes: SentenceNode[],
  from: number,
  to: number,
  k: number
): SentenceNode[] {
  let seen = 0;
  return nodes.map((n, i) => {
    if (i < from || i > to) return n;
    const parts = n.text.split(/(\s+)/);
    const out = parts.map((p) => {
      if (/^\s*$/.test(p) || p === "") return p;
      const hit = seen === k;
      seen += 1;
      return hit ? respell(p) : p;
    });
    return { ...n, text: out.join("") };
  });
}

async function main() {
  const cfg = { ...loadAnalyzeConfig({}), engine: "recall-critic" as const };
  const bar = cfg.teaserRecurrenceFrac;

  for (const name of CASES) {
    const fixture = loadFixture(name);
    const nodes = buildSentenceGraph(fixture.transcript.segments, cfg);
    const client = createReplayClient(fixture.responses);
    const scan = await runScanner(client as never, newUsage(), nodes, cfg, {
      retryDelayMs: 1,
    });
    const merged = mergeCandidates(scan.candidates, nodes, cfg);

    const totalWords = nodes
      .map((n) => n.text)
      .join(" ")
      .split(/\s+/)
      .filter(Boolean).length;
    const yoTokens = nodes
      .map((n) => n.text)
      .join(" ")
      .split(/\s+/)
      .filter((w) => w.includes("ё") || w.includes("Ё")).length;
    console.log(`\n=== ${name}  (${totalWords} words, ё-tokens ${yoTokens}) ===`);

    for (const c of merged) {
      const node = nodes[c.startNode];
      if (!node || node.start > cfg.teaserWindowSec) continue;
      const base = montageScore(nodes, c.startNode, c.endNode);
      const words = wordsOf(nodes, c.startNode, c.endNode);
      let below = 0;
      const drops: number[] = [];
      for (let k = 0; k < words.length; k++) {
        const m = mutate(nodes, c.startNode, c.endNode, k);
        const s = montageScore(m, c.startNode, c.endNode);
        if (s < bar) {
          below += 1;
          drops.push(Math.round(s * 1000) / 1000);
        }
      }
      console.log(
        `  ${c.id}  nodes ${c.startNode}-${c.endNode}  ` +
          `${node.start.toFixed(1)}-${nodes[c.endNode].end.toFixed(1)}s  ` +
          `base ${base.toFixed(3)}  flagged ${isTeaserCandidate(nodes, c, cfg)}  ` +
          `${words.length} words  -> ${below} of ${words.length} fall below ${bar}` +
          (drops.length ? `  [${[...new Set(drops)].join(", ")}]` : "")
      );
    }

    // false-positive surface: ordinary candidates that START after the window
    let worst = 0;
    let worstId = "";
    let nonZero = 0;
    for (const c of merged) {
      const node = nodes[c.startNode];
      if (!node || node.start <= cfg.teaserWindowSec) continue;
      const s = montageScore(nodes, c.startNode, c.endNode);
      if (s > 0) nonZero += 1;
      if (s > worst) {
        worst = s;
        worstId = c.id;
      }
    }
    const late = merged.filter(
      (c) => nodes[c.startNode] && nodes[c.startNode].start > cfg.teaserWindowSec
    ).length;
    console.log(
      `  [ordinary/late candidates] n=${late}  non-zero ${nonZero}  ` +
        `max ${worst.toFixed(3)} (${worstId || "none"})  bar ${bar}`
    );
  }
}

void main();
