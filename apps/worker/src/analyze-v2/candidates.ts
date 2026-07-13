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
  // copy before clamping - callers' objects must stay untouched
  const valid = candidates
    .filter(
      (c) =>
        Number.isInteger(c.startNode) &&
        Number.isInteger(c.endNode) &&
        c.startNode >= 0 &&
        c.endNode <= maxNode &&
        c.startNode <= c.endNode
    )
    .map((c) => ({ ...c }));
  for (const c of valid) {
    if (!Number.isInteger(c.payoffNode) || c.payoffNode < c.startNode || c.payoffNode > c.endNode) {
      c.payoffNode = c.startNode;
    }
    c.interest = Math.min(1, Math.max(0, c.interest));
  }

  const sorted = valid.sort((a, b) => a.startNode - b.startNode);
  const merged: ScanCandidate[] = [];
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const shorter = Math.min(prev.endNode - prev.startNode + 1, c.endNode - c.startNode + 1);
      const overlap = overlapNodes(prev, c);
      const shouldMerge =
        overlap > shorter * 0.5 ||
        // payoff proximity only counts when the ranges actually share a node -
        // zero-overlap adjacent moments are distinct
        (overlap >= 1 && Math.abs(prev.payoffNode - c.payoffNode) <= 1);
      // merge gate: never build a union carrying more speech than the span
      // guard allows. Overlapping near-duplicates that stay separate are fine -
      // the critic sees both and post-critic NMS dedups.
      const union = {
        startNode: Math.min(prev.startNode, c.startNode),
        endNode: Math.max(prev.endNode, c.endNode),
      };
      if (shouldMerge && speechSpanSec(union, nodes) <= SPAN_GUARD_SEC) {
        const stronger = c.interest > prev.interest ? c : prev;
        prev.startNode = union.startNode;
        prev.endNode = union.endNode;
        prev.interest = Math.max(prev.interest, c.interest);
        prev.type = stronger.type;
        prev.payoffNode = stronger.payoffNode;
        // the earliest constituent's windowIndex is kept (quota attribution
        // bias accepted); on cross-thread merge the first thread label wins
        // and the other is dropped
        prev.thread = prev.thread ?? c.thread;
        continue;
      }
    }
    merged.push({ ...c });
  }

  // span guard: merges can no longer exceed the guard (the gate above bounds
  // unions), but a single raw scanner candidate still can. Iteratively split:
  // prefer the strongest payoff when the head [start, payoff] fits; otherwise
  // split at the midpoint, keeping the original payoff in whichever half
  // contains it (the other half re-anchors its payoff on its own end node).
  // Every split strictly shrinks the range, so this terminates with all pieces
  // within the guard (except an unsplittable single node).
  const guarded: ScanCandidate[] = [];
  for (const c of merged) {
    const stack: ScanCandidate[] = [c];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur.startNode >= cur.endNode || speechSpanSec(cur, nodes) <= SPAN_GUARD_SEC) {
        guarded.push(cur);
        continue;
      }
      const payoffInside = cur.payoffNode > cur.startNode && cur.payoffNode < cur.endNode;
      let head: ScanCandidate;
      let tail: ScanCandidate;
      if (
        payoffInside &&
        speechSpanSec({ startNode: cur.startNode, endNode: cur.payoffNode }, nodes) <= SPAN_GUARD_SEC
      ) {
        head = { ...cur, endNode: cur.payoffNode };
        tail = { ...cur, startNode: cur.payoffNode + 1, payoffNode: cur.endNode };
      } else {
        const mid = Math.floor((cur.startNode + cur.endNode) / 2);
        if (cur.payoffNode <= mid) {
          head = { ...cur, endNode: mid };
          tail = { ...cur, startNode: mid + 1, payoffNode: cur.endNode };
        } else {
          head = { ...cur, endNode: mid, payoffNode: mid };
          tail = { ...cur, startNode: mid + 1 };
        }
      }
      stack.push(tail, head); // head is popped first to keep position order
    }
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
