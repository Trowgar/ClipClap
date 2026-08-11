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

  it("excludes opaque nodes from speech accounting but keeps them in the window", () => {
    // 6 nodes of 5s each; nodes 1 and 4 are opaque (no reliable words)
    const nodes = makeNodes(6, 5).map((n) => ({
      ...n,
      hasWords: n.index !== 1 && n.index !== 4,
    }));
    const windows = buildScanWindows(nodes, cfg);
    expect(windows).toHaveLength(1);
    // (a) only the 4 word-bearing nodes count: 4 x 5s, not 30s wall clock
    expect(windows[0].speechSec).toBe(20);
    // (b) opaque nodes are still included in the window slice
    expect(windows[0]).toMatchObject({ startNode: 0, endNode: 5 });
    // (c) rendering still emits the opaque nodes' lines
    expect(renderWindowText(nodes, windows[0])).toBe(
      "#0 node 0\n#1 node 1\n#2 node 2\n#3 node 3\n#4 node 4\n#5 node 5"
    );
  });

  it("budgets long mixed transcripts by speech time and still covers every node", () => {
    // 40 nodes of 5s each; every odd node opaque -> 100s speech, 200s wall clock
    const nodes = makeNodes(40, 5).map((n) => ({
      ...n,
      hasWords: n.index % 2 === 0,
    }));
    const windows = buildScanWindows(nodes, cfg);
    expect(windows.length).toBeGreaterThan(1);
    // 60s of speech accumulates on even nodes only, reached at node 22
    // (a wall-clock budget would have stopped at node 11)
    expect(windows[0]).toMatchObject({ startNode: 0, endNode: 22, speechSec: 60 });
    // each window's speechSec equals the word-bearing duration of its slice
    for (const w of windows) {
      let expected = 0;
      for (let i = w.startNode; i <= w.endNode; i++) {
        if (nodes[i].hasWords) expected += nodes[i].end - nodes[i].start;
      }
      expect(w.speechSec).toBe(expected);
    }
    // every node, opaque included, lands in at least one window
    const covered = new Set<number>();
    for (const w of windows) {
      for (let i = w.startNode; i <= w.endNode; i++) covered.add(i);
    }
    expect(covered.size).toBe(40);
    expect(windows[windows.length - 1].endNode).toBe(39);
  });

  it("returns no windows for empty input", () => {
    expect(buildScanWindows([], cfg)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // scanWindowBudget (spec 2026-08-11 "Scan recall remedy")
  // -------------------------------------------------------------------------

  it("counts every node's span toward the budget under 'source', yielding MORE windows than the 'speech' default on the same mixed graph", () => {
    // 40 nodes of 5s each, odd nodes opaque: wall clock 200s, speechSec-total
    // 100s (20 word-bearing nodes), sourceSec-total 200s (all 40 nodes) - the
    // same "half the material is opaque" shape engine-notes §3 measured.
    // `cfg` above carries no SCAN_WINDOW_BUDGET override, so it IS the
    // default - the mechanism under test has to overcome that default, not
    // merely reproduce it, to turn this test green.
    expect(cfg.scanWindowBudget).toBe("speech");
    const nodes = makeNodes(40, 5).map((n) => ({
      ...n,
      hasWords: n.index % 2 === 0,
    }));
    const sourceCfg = { ...cfg, scanWindowBudget: "source" as const };

    const speechWindows = buildScanWindows(nodes, cfg);
    const sourceWindows = buildScanWindows(nodes, sourceCfg);

    expect(sourceWindows.length).toBeGreaterThan(speechWindows.length);
    // exact counts for this fixture, pinned as a regression lock on the
    // accumulator switch itself (hand-derived: speech reaches its 60s budget
    // only every ~24 nodes here since half contribute nothing; source reaches
    // it every 12 nodes since every node contributes its full 5s)
    expect(speechWindows.length).toBe(2);
    expect(sourceWindows.length).toBe(5);

    // both budgets still cover every node, opaque included - the windowing
    // guarantee buildScanWindows makes regardless of what counts toward the
    // budget that decides window BOUNDARIES
    for (const windows of [speechWindows, sourceWindows]) {
      const covered = new Set<number>();
      for (const w of windows) {
        for (let i = w.startNode; i <= w.endNode; i++) covered.add(i);
      }
      expect(covered.size).toBe(40);
      expect(windows[windows.length - 1].endNode).toBe(39);
    }
  });

  it("produces IDENTICAL layouts under both budgets when a graph has zero opaque nodes (speechSec == sourceSec)", () => {
    // The boundary case the two budgets provably coincide on: with every node
    // word-bearing, "count word-bearing spans only" and "count every span"
    // are the same function, so nodeBudgetSpan cannot tell the two apart and
    // the window layout - and therefore every downstream scanner request key
    // - is byte-identical. This is also why scanWindowBudget earns its own
    // eval-fingerprint key rather than relying on the request hash: on a
    // source shaped like THIS one, a fixture recorded under one budget would
    // replay green under the other by coincidence.
    const nodes = makeNodes(40, 5); // hasWords: true for all, from makeNodes' default
    const speechWindows = buildScanWindows(nodes, cfg);
    const sourceWindows = buildScanWindows(nodes, { ...cfg, scanWindowBudget: "source" as const });
    expect(sourceWindows).toEqual(speechWindows);
    expect(speechWindows.length).toBeGreaterThan(1); // a non-trivial case, not a single-window fluke
  });

  it("terminates when a single node exceeds the window budget and covers the rest", () => {
    // node 0 alone is 120s (> 60s budget); five 5s nodes follow
    const nodes: SentenceNode[] = [
      {
        index: 0,
        start: 0,
        end: 120,
        text: "node 0",
        hasWords: true,
        trailingStrength: 1.0,
        leadingStrength: 1.0,
      },
      ...Array.from({ length: 5 }, (_, k) => ({
        index: k + 1,
        start: 120 + k * 5,
        end: 120 + (k + 1) * 5,
        text: `node ${k + 1}`,
        hasWords: true,
        trailingStrength: 1.0,
        leadingStrength: 1.0,
      })),
    ];
    const windows = buildScanWindows(nodes, cfg);
    expect(windows[0]).toMatchObject({ startNode: 0, endNode: 0, speechSec: 120 });
    const covered = new Set<number>();
    for (const w of windows) {
      for (let i = w.startNode; i <= w.endNode; i++) covered.add(i);
    }
    expect(covered.size).toBe(6);
    expect(windows[windows.length - 1].endNode).toBe(5);
  });
});
