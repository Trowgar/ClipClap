import { describe, expect, it } from "vitest";
import { mergeCandidates, selectCriticCandidates } from "../analyze-v2/candidates";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { AnalyzeConfig } from "../analyze-v2/config";
import type { ScanCandidate, SentenceNode } from "../analyze-v2/types";

/**
 * Tasks T3 (selectCriticCandidates + criticBudget stream override) and T4
 * (mergeCandidates burst expansion) of the stream-analyze-mode spec
 * (2026-08-19-stream-analyze-mode.md, §S3/§S4). Mirrors the fixture style of
 * candidates.test.ts rather than importing from it (that file exports
 * nothing - its helpers are file-local).
 */

const cfg = loadAnalyzeConfig({});

/** Contiguous nodes, `secEach` seconds apart, zero gap between consecutive
 *  nodes - the same shape candidates.test.ts's own `nodes()` builds. */
function nodes(count: number, secEach = 5): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * secEach,
    end: i * secEach + secEach,
    text: `n${i}`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

/** Like `nodes()`, but inserts one extra `gapSec` of silence between node
 *  `gapAfterIndex` and the next one - everything before and after stays
 *  internally contiguous at `secEach`. Built for the T4 silence-gap test:
 *  it needs ONE real scene cut at a known position, nothing else. */
function nodesWithGap(
  count: number,
  secEach: number,
  gapAfterIndex: number,
  gapSec: number
): SentenceNode[] {
  const out: SentenceNode[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i === gapAfterIndex + 1) t += gapSec;
    out.push({
      index: i,
      start: t,
      end: t + secEach,
      text: `n${i}`,
      hasWords: true,
      trailingStrength: 1.0,
      leadingStrength: 1.0,
    });
    t += secEach;
  }
  return out;
}

function cand(p: Partial<ScanCandidate>): ScanCandidate {
  return {
    startNode: 0,
    endNode: 2,
    payoffNode: 1,
    interest: 0.5,
    type: "funny",
    windowIndex: 0,
    ...p,
  };
}

function spanSec(c: { startNode: number; endNode: number }, ns: SentenceNode[]): number {
  return ns[c.endNode].end - ns[c.startNode].start;
}

describe("mergeCandidates - stream burst expansion (T4)", () => {
  it("standard mode: a 2s candidate stays 2s (no expansion)", () => {
    const ns = nodes(30, 1);
    const merged = mergeCandidates([cand({ startNode: 10, endNode: 11, payoffNode: 10 })], ns, cfg);
    expect(merged[0].startNode).toBe(10);
    expect(merged[0].endNode).toBe(11);
    expect(spanSec(merged[0], ns)).toBe(2);
  });

  it("standard mode with an explicit 'standard' argument matches the no-mode call (byte-identical)", () => {
    const ns = nodes(40, 6);
    const input = [
      cand({ startNode: 0, endNode: 4, payoffNode: 3, interest: 0.5 }),
      cand({ startNode: 2, endNode: 5, payoffNode: 4, interest: 0.8, type: "reveal" }),
      cand({ startNode: 10, endNode: 10, payoffNode: 10, interest: 0.2, thread: "bet" }),
      cand({ startNode: 30, endNode: 31, payoffNode: 30, interest: 0.9, thread: "bet" }),
    ];
    const withoutMode = mergeCandidates(input, ns, cfg);
    const withMode = mergeCandidates(input, ns, cfg, "standard");
    expect(withMode).toEqual(withoutMode);
  });

  it("stream mode: a lone 3s candidate with nothing nearby expands BACKWARD FIRST to the 12s floor", () => {
    // secEach=1s, fully contiguous, no other candidates - nothing to stop it
    // but the target span itself, so the whole expansion has to come from
    // the "prefer backward" rule, not from any guard forcing a direction.
    const ns = nodes(30, 1);
    const merged = mergeCandidates(
      [cand({ startNode: 15, endNode: 17, payoffNode: 16 })],
      ns,
      cfg,
      "stream"
    );
    expect(merged).toHaveLength(1);
    expect(spanSec({ startNode: 15, endNode: 17 }, ns)).toBe(3); // sanity: it really started at 3s
    // endNode untouched - every added node came off the front
    expect(merged[0].endNode).toBe(17);
    expect(merged[0].startNode).toBe(6); // 9 nodes pulled backward: 15 -> 6
    expect(spanSec(merged[0], ns)).toBe(cfg.streamMinCandidateSec);
  });

  it("stream mode: backward expansion stops at a >3s silence gap, then forward compensates", () => {
    // gap of 5s (>3) sits between node 10 and node 11. The candidate starts
    // well past the gap; backward expansion can only harvest 4 nodes before
    // hitting it (15 -> 11), so the guard is load-bearing here - without it
    // the run would keep pulling backward and cross into node 10.
    const ns = nodesWithGap(40, 1, 10, 5);
    const merged = mergeCandidates(
      [cand({ startNode: 15, endNode: 17, payoffNode: 16 })],
      ns,
      cfg,
      "stream"
    );
    expect(merged).toHaveLength(1);
    const c = merged[0];
    expect(c.startNode).toBe(11); // stopped AT the first node past the gap
    expect(c.startNode).toBeGreaterThan(10); // never crossed the gap into node 10
    expect(c.endNode).toBe(22); // forward picked up the remaining 5 nodes the gap refused
    expect(spanSec(c, ns)).toBe(cfg.streamMinCandidateSec);
  });

  it("stream mode: expansion stops at a sibling candidate's own (pre-expansion) range", () => {
    // Candidate A [0,15] is already 16s (>=12s, untouched). Candidate B
    // [20,21] is a 2s stub that wants to reach back toward A but must never
    // swallow A's territory - it stops exactly at node 16, one past A's end.
    const ns = nodes(40, 1);
    const merged = mergeCandidates(
      [
        cand({ startNode: 0, endNode: 15, payoffNode: 5, interest: 0.4 }),
        cand({ startNode: 20, endNode: 21, payoffNode: 20, interest: 0.9 }),
      ],
      ns,
      cfg,
      "stream"
    );
    expect(merged).toHaveLength(2);
    const [a, b] = merged;
    // A was already at/above the floor - the while loop's own condition never
    // fires for it, so it is untouched, not merely "close enough"
    expect(a.startNode).toBe(0);
    expect(a.endNode).toBe(15);
    expect(b.startNode).toBe(16); // stopped exactly at A.endNode + 1
    expect(b.startNode).toBeGreaterThan(a.endNode); // no overlap with A
    expect(b.endNode).toBe(27); // forward makes up the rest (fwdLimit is open)
    expect(spanSec(b, ns)).toBe(cfg.streamMinCandidateSec);
  });

  it("stream mode: expansion never crosses node 0", () => {
    const ns = nodes(30, 1);
    const merged = mergeCandidates(
      [cand({ startNode: 1, endNode: 2, payoffNode: 1 })],
      ns,
      cfg,
      "stream"
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].startNode).toBe(0); // floor, never negative
    expect(merged[0].endNode).toBe(11); // forward makes up the remaining 9 nodes
    expect(spanSec(merged[0], ns)).toBe(cfg.streamMinCandidateSec);
  });

  it("stream mode: payoffNode stays inside the widened range", () => {
    const ns = nodes(30, 1);
    const merged = mergeCandidates(
      // payoff pinned to the candidate's own end - the edge case most likely
      // to fall outside the range if the clamp were missing
      [cand({ startNode: 15, endNode: 16, payoffNode: 16 })],
      ns,
      cfg,
      "stream"
    );
    expect(merged).toHaveLength(1);
    const c = merged[0];
    expect(c.payoffNode).toBe(16); // unchanged - widening only grows outward
    expect(c.payoffNode).toBeGreaterThanOrEqual(c.startNode);
    expect(c.payoffNode).toBeLessThanOrEqual(c.endNode);
  });

  it("stream mode: a candidate already >= streamMinCandidateSec is untouched byte-identically", () => {
    const ns = nodes(30, 1);
    const input = [cand({ startNode: 5, endNode: 19, payoffNode: 12, interest: 0.7 })]; // 15s span
    expect(spanSec({ startNode: 5, endNode: 19 }, ns)).toBeGreaterThanOrEqual(cfg.streamMinCandidateSec);
    const stream = mergeCandidates(input, ns, cfg, "stream");
    const standard = mergeCandidates(input, ns, cfg, "standard");
    expect(stream).toEqual(standard); // the expansion block is a complete no-op here
  });
});

describe("selectCriticCandidates - stream budget (T3)", () => {
  it("standard mode with an explicit 'standard' argument matches the no-mode call (byte-identical)", () => {
    const ns = nodes(400, 5);
    const all: ScanCandidate[] = [];
    for (let w = 0; w < 20; w++) {
      for (let k = 0; k < 4; k++) {
        const start = w * 20 + k * 4;
        all.push(
          cand({
            startNode: start,
            endNode: start + 1,
            payoffNode: start + 1,
            interest: (w + k) % 3 === 0 ? 0.9 : 0.3 + k * 0.05,
            windowIndex: w,
          })
        );
      }
    }
    const merged = mergeCandidates(all, ns, cfg);
    const withoutMode = selectCriticCandidates(merged, ns, cfg);
    const withMode = selectCriticCandidates(merged, ns, cfg, "standard");
    expect(withMode).toEqual(withoutMode);
  });

  it("stream mode: per-window quota is 1, not perWindowMinCandidates(2)", () => {
    // 5 windows x 10 candidates, distinct interests inside each window so the
    // top pick is unambiguous. streamCriticMaxCandidates pinned to exactly
    // the window count so quota alone reaches K - any extra slot leaking in
    // would be visible immediately as selected.length > 5.
    const ns = nodes(400, 15); // plenty of source minutes - floor/cap never binds K here
    const testCfg: AnalyzeConfig = { ...cfg, streamCriticMaxCandidates: 5, regionMaxCandidates: 999 };
    const all: ScanCandidate[] = [];
    const tops: number[] = [];
    for (let w = 0; w < 5; w++) {
      for (let k = 0; k < 10; k++) {
        const start = w * 30 + k * 2;
        all.push(
          cand({ startNode: start, endNode: start, payoffNode: start, interest: 0.9 - k * 0.05, windowIndex: w })
        );
        if (k === 0) tops.push(start); // k=0 carries the highest interest in its window
      }
    }
    const merged = mergeCandidates(all, ns, testCfg);
    const selected = selectCriticCandidates(merged, ns, testCfg, "stream");
    expect(selected).toHaveLength(5);
    for (let w = 0; w < 5; w++) {
      expect(selected.filter((c) => c.windowIndex === w)).toHaveLength(1);
    }
    const selectedStarts = selected.map((c) => c.startNode).sort((a, b) => a - b);
    expect(selectedStarts).toEqual([...tops].sort((a, b) => a - b));
  });

  it("stream mode: streamCriticMaxCandidates(80) caps selection even when the pool is bigger", () => {
    const ns = nodes(400, 15); // 100 source minutes -> uncapped rate would give 100
    const testCfg: AnalyzeConfig = { ...cfg, regionMaxCandidates: 999 }; // isolate the K cap from the region cap
    const all = Array.from({ length: 100 }, (_, i) =>
      cand({ startNode: i * 3, endNode: i * 3, payoffNode: i * 3, interest: i === 0 ? 1 : 0.5, windowIndex: 0 })
    );
    const merged = mergeCandidates(all, ns, testCfg);
    expect(merged).toHaveLength(100); // disjoint singles, nothing merges
    const standardSelected = selectCriticCandidates(merged, ns, testCfg);
    const streamSelected = selectCriticCandidates(merged, ns, testCfg, "stream");
    expect(standardSelected).toHaveLength(testCfg.criticMaxCandidates); // 40, unaffected by this task
    expect(streamSelected).toHaveLength(testCfg.streamCriticMaxCandidates); // 80, the new ceiling
    expect(streamSelected.some((c) => c.startNode === 0)).toBe(true); // the guaranteed quota pick survives
  });

  it("stream mode rescues the ration-victim shape: a candidate buried behind per-window quota in standard mode is selected once the quota drops to 1 and frees a slot for global interest order", () => {
    // Reproduces the phase-1 measurement's MECHANISM, isolated from the K
    // cap on purpose: both modes here share the SAME criticMaxCandidates
    // (15) - only perWindowMinCandidates differs (stream's override to 1
    // vs the standard 2), so this test is sensitive to the quota change
    // specifically, not to streamCriticMaxCandidates existing (that half is
    // already pinned by the "caps selection" test above).
    //
    // 10 windows. Window `target` holds 3 candidates: two strong ones
    // (0.99, 0.95) and the victim (0.9) - "3rd-best in its own window", the
    // exact phase-1 shape. Every other window holds 2 weak candidates
    // (0.05, 0.04) - just enough to cost a quota slot without competing for
    // extras. With K=15: standard's quota (2/window x 10 = 20) already
    // exceeds K, so extras never run and the victim - never in the top 2 of
    // its own window - is rationed out exactly like "осуждаю" was. Stream's
    // quota (1/window x 10 = 10) leaves 5 slots for extras, where the
    // victim ranks 2nd globally (behind only its own window's 0.95) and is
    // rescued.
    const ns = nodes(100, 10); // 1000s = 16.7 source-minutes -> round(17) clears K=15, cap binds
    const testCfg: AnalyzeConfig = {
      ...cfg,
      criticMaxCandidates: 15,
      streamCriticMaxCandidates: 15,
      regionMaxCandidates: 999, // isolate budget/quota from the region cap
    };
    const targetWindow = 5;
    const all: ScanCandidate[] = [];
    let victimStart = -1;
    for (let w = 0; w < 10; w++) {
      const base = w * 10;
      if (w === targetWindow) {
        all.push(cand({ startNode: base, endNode: base, payoffNode: base, interest: 0.99, windowIndex: w }));
        all.push(cand({ startNode: base + 4, endNode: base + 4, payoffNode: base + 4, interest: 0.95, windowIndex: w }));
        all.push(cand({ startNode: base + 8, endNode: base + 8, payoffNode: base + 8, interest: 0.9, windowIndex: w }));
        victimStart = base + 8;
      } else {
        all.push(cand({ startNode: base, endNode: base, payoffNode: base, interest: 0.05, windowIndex: w }));
        all.push(cand({ startNode: base + 4, endNode: base + 4, payoffNode: base + 4, interest: 0.04, windowIndex: w }));
      }
    }
    const merged = mergeCandidates(all, ns, testCfg); // disjoint singles, nothing merges - ids track input order
    expect(merged).toHaveLength(21);

    const standard = selectCriticCandidates(merged, ns, testCfg); // no mode -> today's behaviour, quota=2
    const stream = selectCriticCandidates(merged, ns, testCfg, "stream"); // quota=1

    expect(standard).toHaveLength(20); // quota alone (2/window x 10) already exceeds K(15) - extras never ran,
    // and coverage beats the cap for the guaranteed tier (see selectCriticCandidates's own closing comment)
    expect(standard.some((c) => c.startNode === victimStart)).toBe(false); // rationed out, exactly like phase 1
    expect(stream.some((c) => c.startNode === victimStart)).toBe(true); // freed slot reaches it
  });

  it("stream mode: region cap still bounds extras per 10-minute region (not disabled by the quota override)", () => {
    // Same shape as candidates.test.ts's standard-mode region-cap test,
    // just run in stream mode - pins that dropping the quota from 2 to 1
    // did not also quietly drop the region cap.
    const ns = nodes(150, 5); // region boundary at node 120 (600s)
    const all = [
      ...Array.from({ length: 10 }, (_, i) =>
        cand({
          startNode: i * 4,
          endNode: i * 4 + 1,
          payoffNode: i * 4 + 1,
          interest: 0.9 - i * 0.01,
          windowIndex: 0,
        })
      ),
      cand({ startNode: 120, endNode: 121, payoffNode: 121, interest: 0.5, windowIndex: 1 }),
      cand({ startNode: 124, endNode: 125, payoffNode: 125, interest: 0.49, windowIndex: 1 }),
    ];
    const merged = mergeCandidates(all, ns, cfg);
    expect(merged).toHaveLength(12);
    const selected = selectCriticCandidates(merged, ns, cfg, "stream");
    const region0 = selected.filter((c) => ns[c.payoffNode].start < 600);
    expect(region0).toHaveLength(cfg.regionMaxCandidates); // capped despite K room
    expect(selected).toHaveLength(cfg.regionMaxCandidates + 2);
  });
});
