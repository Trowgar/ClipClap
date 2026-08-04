/**
 * Does the sentence graph already see the laugh track?
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-laugh-probe.ts <fixture>"
 *
 * The engine has no way to tell a strong beat from a weak one, which is why its
 * payoff lands early (spec 2026-08-04 3.2). On a multi-camera sitcom there IS a
 * physical signal for "that was the big laugh": the audience. If Whisper leaves
 * those stretches word-free, buildSentenceGraph already marks them hasWords
 * false, and the gap after a line becomes a measurable proxy for how hard it
 * landed - with no model involved.
 *
 * This probe answers whether that signal exists in the data before any design
 * depends on it. Prints the word-free gaps, largest first.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult } from "@clipclap/shared";

const FIXTURES = join(__dirname, "..", "__tests__", "fixtures", "eval");

function main() {
  const [fixtureName] = process.argv.slice(2);
  if (!fixtureName) {
    console.error("usage: eval-laugh-probe.ts <fixture>");
    process.exit(1);
  }
  const transcript = JSON.parse(
    readFileSync(join(FIXTURES, fixtureName, "transcript.json"), "utf-8")
  ) as TranscriptionResult;

  const nodes = buildSentenceGraph(transcript.segments as never, loadAnalyzeConfig({}));
  const opaque = nodes.filter((n) => !n.hasWords);
  const total = nodes.length;

  console.log(`fixture: ${fixtureName}`);
  console.log(`nodes: ${total}  word-bearing: ${total - opaque.length}  opaque: ${opaque.length}`);

  if (opaque.length === 0) {
    console.log("\nNO opaque nodes - the graph does not see any word-free stretch.");
  } else {
    const sorted = [...opaque].sort((a, b) => b.end - b.start - (a.end - a.start));
    console.log("\nlongest word-free stretches, and the line that precedes each:");
    for (const n of sorted.slice(0, 15)) {
      const prev = nodes
        .slice(0, n.index)
        .reverse()
        .find((x) => x.hasWords);
      console.log(
        `  ${(n.end - n.start).toFixed(1)}s at ${n.start.toFixed(1)}  <- ${
          prev ? `"${prev.text.trim().slice(-60)}"` : "(nothing)"
        }`
      );
    }
  }

  // Second candidate signal, independent of Whisper's opacity handling: the
  // silence BETWEEN consecutive word-bearing nodes. A laugh that Whisper
  // transcribed as nothing at all leaves no node, only a hole in the timeline.
  console.log("\nlargest holes between consecutive word-bearing nodes:");
  const words = nodes.filter((n) => n.hasWords);
  const holes: Array<{ gap: number; at: number; after: string }> = [];
  for (let i = 1; i < words.length; i++) {
    holes.push({
      gap: words[i].start - words[i - 1].end,
      at: words[i - 1].end,
      after: words[i - 1].text.trim().slice(-60),
    });
  }
  holes.sort((a, b) => b.gap - a.gap);
  for (const h of holes.slice(0, 15)) {
    console.log(`  ${h.gap.toFixed(1)}s at ${h.at.toFixed(1)}  <- "${h.after}"`);
  }
  const gaps = holes.map((h) => h.gap).sort((a, b) => a - b);
  const q = (p: number) => gaps[Math.floor(gaps.length * p)];
  console.log(
    `\ngap distribution: median ${q(0.5).toFixed(2)}s  p90 ${q(0.9).toFixed(2)}s  p99 ${q(0.99).toFixed(2)}s  max ${gaps[gaps.length - 1].toFixed(2)}s`
  );
}

main();
