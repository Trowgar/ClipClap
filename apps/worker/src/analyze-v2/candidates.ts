import type { AnalyzeConfig } from "./config";
import type { MergedCandidate, ScanCandidate, SentenceNode } from "./types";

const SPAN_GUARD_SEC = 130;
const REGION_SEC = 600;

function speechSpanSec(c: { startNode: number; endNode: number }, nodes: SentenceNode[]): number {
  let sec = 0;
  for (let i = c.startNode; i <= c.endNode; i++) {
    if (nodes[i]?.hasWords) sec += nodes[i].end - nodes[i].start;
  }
  return sec;
}

function overlapNodes(a: ScanCandidate, b: ScanCandidate): number {
  return Math.max(0, Math.min(a.endNode, b.endNode) - Math.max(a.startNode, b.startNode) + 1);
}

export function mergeCandidates(
  candidates: ScanCandidate[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): MergedCandidate[] {
  const maxNode = nodes.length - 1;
  const valid = candidates.filter(
    (c) =>
      Number.isInteger(c.startNode) &&
      Number.isInteger(c.endNode) &&
      c.startNode >= 0 &&
      c.endNode <= maxNode &&
      c.startNode <= c.endNode
  );
  for (const c of valid) {
    if (!Number.isInteger(c.payoffNode) || c.payoffNode < c.startNode || c.payoffNode > c.endNode) {
      c.payoffNode = c.startNode;
    }
    c.interest = Math.min(1, Math.max(0, c.interest));
  }

  const sorted = [...valid].sort((a, b) => a.startNode - b.startNode);
  const merged: ScanCandidate[] = [];
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const shorter = Math.min(prev.endNode - prev.startNode + 1, c.endNode - c.startNode + 1);
      const shouldMerge =
        overlapNodes(prev, c) > shorter * 0.5 ||
        Math.abs(prev.payoffNode - c.payoffNode) <= 1;
      if (shouldMerge) {
        const stronger = c.interest > prev.interest ? c : prev;
        prev.startNode = Math.min(prev.startNode, c.startNode);
        prev.endNode = Math.max(prev.endNode, c.endNode);
        prev.interest = Math.max(prev.interest, c.interest);
        prev.type = stronger.type;
        prev.payoffNode = stronger.payoffNode;
        prev.thread = prev.thread ?? c.thread;
        continue;
      }
    }
    merged.push({ ...c });
  }

  // span guard: split oversized unions at the payoff, keep two tight halves
  const guarded: ScanCandidate[] = [];
  for (const c of merged) {
    if (speechSpanSec(c, nodes) <= SPAN_GUARD_SEC || c.payoffNode <= c.startNode || c.payoffNode >= c.endNode) {
      guarded.push(c);
      continue;
    }
    guarded.push({ ...c, endNode: c.payoffNode });
    guarded.push({ ...c, startNode: c.payoffNode + 1, payoffNode: c.endNode });
  }

  // thread collation: earliest start node per thread label
  const threadSetup = new Map<string, number>();
  for (const c of guarded) {
    if (!c.thread) continue;
    const prev = threadSetup.get(c.thread);
    if (prev === undefined || c.startNode < prev) threadSetup.set(c.thread, c.startNode);
  }

  return guarded.map((c, i) => ({
    ...c,
    id: `c${i}`,
    threadSetupNode: c.thread ? threadSetup.get(c.thread) : undefined,
  }));
}

/** Stratified, coverage-aware pick of at most K candidates for the critic. */
export function selectCriticCandidates(
  merged: MergedCandidate[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  sourceMinutes: number
): MergedCandidate[] {
  const K = Math.min(
    cfg.criticMaxCandidates,
    Math.max(8, Math.round(sourceMinutes / 2))
  );

  const byWindow = new Map<number, MergedCandidate[]>();
  for (const c of merged) {
    const list = byWindow.get(c.windowIndex) ?? [];
    list.push(c);
    byWindow.set(c.windowIndex, list);
  }

  const picked = new Set<string>();
  const result: MergedCandidate[] = [];
  const take = (c: MergedCandidate) => {
    if (picked.has(c.id)) return;
    picked.add(c.id);
    result.push(c);
  };

  // guaranteed per-window quota
  for (const list of byWindow.values()) {
    list
      .sort((a, b) => b.interest - a.interest)
      .slice(0, cfg.perWindowMinCandidates)
      .forEach(take);
  }

  // global extras by interest, capped per 10-min region of the payoff
  const regionCount = new Map<number, number>();
  for (const c of result) {
    const region = Math.floor(nodes[c.payoffNode].start / REGION_SEC);
    regionCount.set(region, (regionCount.get(region) ?? 0) + 1);
  }
  const extras = merged
    .filter((c) => !picked.has(c.id))
    .sort((a, b) => b.interest - a.interest);
  for (const c of extras) {
    if (result.length >= K) break;
    const region = Math.floor(nodes[c.payoffNode].start / REGION_SEC);
    if ((regionCount.get(region) ?? 0) >= cfg.regionMaxCandidates) continue;
    regionCount.set(region, (regionCount.get(region) ?? 0) + 1);
    take(c);
  }

  // Quota picks are never evicted - coverage beats the cap for the guaranteed
  // tier; extras only ever fill up to K (the loop above stops at K).
  return result;
}
