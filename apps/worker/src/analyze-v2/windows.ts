import type { AnalyzeConfig } from "./config";
import type { ScanWindow, SentenceNode } from "./types";

/**
 * How much of one node's span counts toward the window budget, under
 * `cfg.scanWindowBudget` (spec 2026-08-11 "Scan recall remedy"; config.ts
 * carries the full rationale). "speech" - today's default - counts a
 * word-bearing node's span and nothing for an opaque one, byte-identical to
 * the inline `if (nodes[i].hasWords) speechSec += ...` this replaced.
 * "source" counts every node's span unconditionally, the same definition
 * `candidates.ts`'s `sourceSeconds()` uses.
 *
 * Applied identically to BOTH accumulators below - the forward window-size
 * loop and the backward overlap walk - even though the spec's own prose only
 * spells out the window-size half explicitly ("the window accumulator counts
 * ALL node spans... toward the same per-window constant"). Flagged
 * prominently per the task's own instruction, because this is the one place
 * the source text left a reading open: the overlap exists to buy
 * `scanOverlapSec` of redundant look-back context in whatever currency the
 * window itself is priced in. Pricing the overlap in word-bearing-only
 * seconds while the window grows to ~scanWindowSec of TRANSCRIPT (all node
 * spans) would shrink the overlap to a smaller fraction of the enlarged
 * window - the same halving defect this change exists to fix, one level
 * down. A single shared function is also what keeps the "speech" path
 * byte-identical to today for both halves at once, rather than only for the
 * one the spec's prose names.
 */
function nodeBudgetSpan(
  node: SentenceNode,
  budget: AnalyzeConfig["scanWindowBudget"]
): number {
  if (budget === "source") return node.end - node.start;
  return node.hasWords ? node.end - node.start : 0;
}

/**
 * Contiguous node slices of ~scanWindowSec (speech or source seconds, per
 * `cfg.scanWindowBudget` - see `nodeBudgetSpan` above) with ~scanOverlapSec
 * overlap. Window-size constant, overlap/boundary mechanics and the
 * per-window candidate ceiling downstream in scanner.ts are UNCHANGED by the
 * budget - only which node spans are allowed to accumulate toward them.
 */
export function buildScanWindows(
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): ScanWindow[] {
  if (nodes.length === 0) return [];
  const budget = cfg.scanWindowBudget;

  const windows: ScanWindow[] = [];
  let startIdx = 0;

  while (startIdx < nodes.length) {
    let speechSec = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < nodes.length; i++) {
      endIdx = i;
      speechSec += nodeBudgetSpan(nodes[i], budget);
      if (speechSec >= cfg.scanWindowSec) break;
    }

    windows.push({
      index: windows.length,
      startNode: nodes[startIdx].index,
      endNode: nodes[endIdx].index,
      speechSec,
    });

    if (endIdx >= nodes.length - 1) break;

    // next window starts scanOverlapSec of budget before this one ended
    let overlap = 0;
    let nextStart = endIdx;
    while (nextStart > startIdx && overlap < cfg.scanOverlapSec) {
      overlap += nodeBudgetSpan(nodes[nextStart], budget);
      nextStart -= 1;
    }
    startIdx = Math.max(nextStart, startIdx + 1);
  }

  return windows;
}

export function renderWindowText(
  nodes: SentenceNode[],
  window: ScanWindow
): string {
  const lines: string[] = [];
  for (let i = window.startNode; i <= window.endNode; i++) {
    lines.push(`#${nodes[i].index} ${nodes[i].text}`);
  }
  return lines.join("\n");
}
