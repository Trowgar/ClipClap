import { describe, expect, it } from "vitest";
import { buildScanWindows, renderWindowText } from "../analyze-v2/windows";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCAN_WINDOW_SEC: "60", SCAN_OVERLAP_SEC: "10" });

function makeNodes(count: number, secEach: number): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * secEach,
    end: i * secEach + secEach,
    text: `node ${i}`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

describe("buildScanWindows", () => {
  it("puts a short transcript in a single window", () => {
    const windows = buildScanWindows(makeNodes(5, 5), cfg); // 25s speech
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ index: 0, startNode: 0, endNode: 4 });
  });

  it("splits long transcripts into overlapping windows covering every node", () => {
    const nodes = makeNodes(40, 5); // 200s speech, 60s windows, 10s overlap
    const windows = buildScanWindows(nodes, cfg);
    expect(windows.length).toBeGreaterThan(2);
    expect(windows[0].startNode).toBe(0);
    expect(windows[windows.length - 1].endNode).toBe(39);
    // overlap: each next window starts before the previous ended
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].startNode).toBeLessThanOrEqual(windows[i - 1].endNode);
    }
    // speech-time accounting only counts word-bearing nodes
    expect(windows[0].speechSec).toBeGreaterThanOrEqual(60);
  });

  it("renders window text as #index lines without timestamps", () => {
    const nodes = makeNodes(3, 5);
    const text = renderWindowText(nodes, { index: 0, startNode: 0, endNode: 2, speechSec: 15 });
    expect(text).toBe("#0 node 0\n#1 node 1\n#2 node 2");
  });
});
