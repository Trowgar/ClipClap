import type { AnalyzeConfig } from "./config";
import type { ScanWindow, SentenceNode } from "./types";

/** Contiguous node slices of ~scanWindowSec speech with ~scanOverlapSec overlap. */
export function buildScanWindows(
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): ScanWindow[] {
  if (nodes.length === 0) return [];

  const windows: ScanWindow[] = [];
  let startIdx = 0;

  while (startIdx < nodes.length) {
    let speechSec = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < nodes.length; i++) {
      endIdx = i;
      if (nodes[i].hasWords) speechSec += nodes[i].end - nodes[i].start;
      if (speechSec >= cfg.scanWindowSec) break;
    }

    windows.push({
      index: windows.length,
      startNode: nodes[startIdx].index,
      endNode: nodes[endIdx].index,
      speechSec,
    });

    if (endIdx >= nodes.length - 1) break;

    // next window starts scanOverlapSec of speech before this one ended
    let overlap = 0;
    let nextStart = endIdx;
    while (nextStart > startIdx && overlap < cfg.scanOverlapSec) {
      if (nodes[nextStart].hasWords)
        overlap += nodes[nextStart].end - nodes[nextStart].start;
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
