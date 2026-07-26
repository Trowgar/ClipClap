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

/** Smallest critic budget any source gets. Governs SHORT sources, where the
 *  per-minute rate would buy one or two candidates and the pool is a handful of
 *  overlapping views of the same few moments - judging all of them is both
 *  cheap and the only way a 4-minute video gets a considered answer. */
export const CRITIC_MIN_CANDIDATES = 8;

/** Critic candidates bought per minute of speech-bearing source.
 *
 *  Derived, not tuned. The pool this budget rations is produced at a measured
 *  0.58 (podcast-ecology) and 0.72 (podcast-answer-arc) candidates per source
 *  minute, and its structural ceiling is the scanner's own schema: at most 12
 *  moments per scan window, one window per ~510s of speech, i.e. ~1.4/min. A
 *  rate of 1 sits ABOVE what real material produces - so on ordinary sources K
 *  stops binding at all and the critic judges the whole pool - and BELOW the
 *  scanner ceiling, so a pathologically generous scan is still rationed by the
 *  stratifier below rather than billed in full.
 *
 *  The old rate of 0.5 sat below the production rate by construction, so K bound
 *  on every dense source and the final cut among candidates fell to `interest`,
 *  a gpt-4o-mini hunch, instead of to the strict judge (job cms2c8ahm: 14 of 29
 *  judged). Cost of the change, measured on both fixtures at batch size 6 and
 *  gpt-5.1 list price: $0.103 -> $0.195 and $0.110 -> $0.239 per 52-minute job. */
export const CRITIC_CANDIDATES_PER_SOURCE_MINUTE = 1;

/**
 * Seconds of source the transcript says carry speech.
 *
 * ALL nodes, opaque ones included - and that inclusion is the whole point.
 * `hasWords` does not mean "this is speech"; it means "Whisper gave us word
 * timings we trust enough to CUT on" (sentence-graph.ts, wordsUnreliable). An
 * opaque node still carries Whisper's segment text, the scanner reads it, the
 * critic reads it, and clips are routinely built around it.
 *
 * Measured on the two eval fixtures - the same 52-minute podcast, two
 * transcription runs (2026-07-26):
 *
 *     wall clock                  3136s
 *     word-bearing node spans     1603s / 1649s   <- what this used to sum
 *     opaque node spans           1167s / 1119s
 *     gaps between nodes           366s /  368s   (longest single gap: 4.3s)
 *
 * There is no 47% of silence in that episode; the longest pause in 52 minutes is
 * 4.3 seconds. The missing half was Whisper's word-timing quality. Budgeting
 * from it charged the critic for a transcription artefact.
 *
 * WHY NOT WALL CLOCK, the obvious alternative: it cannot tell a podcast from an
 * hour of dead air with six minutes of talk in it, and would hand the second one
 * the same budget as the first. Node spans exclude real silence (a silent hour
 * produces no nodes) while including speech we merely could not time - exactly
 * the two properties the budget needs. The residual gap term above (12%) is
 * sub-5s pauses, which no budget should be paying for anyway.
 */
export function sourceSeconds(nodes: SentenceNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.end - n.start), 0);
}

/**
 * How many candidates the strict model may judge for this source.
 *
 * Deliberately computed HERE from the node graph rather than accepted as a
 * caller-supplied number. The defect this replaces was exactly that: index.ts
 * passed `speechSec / 60` into a parameter named `sourceMinutes`, the two
 * disagreed by a factor of two, and nothing in the type system or the tests
 * could notice. The function already had `nodes`; there was never a reason for
 * the caller to hand it a derived quantity it could get wrong.
 */
export function criticBudget(nodes: SentenceNode[], cfg: AnalyzeConfig): number {
  const sourceMinutes = sourceSeconds(nodes) / 60;
  return Math.min(
    cfg.criticMaxCandidates,
    Math.max(
      CRITIC_MIN_CANDIDATES,
      Math.round(sourceMinutes * CRITIC_CANDIDATES_PER_SOURCE_MINUTE)
    )
  );
}

/** Stratified, coverage-aware pick of at most K candidates for the critic. */
export function selectCriticCandidates(
  merged: MergedCandidate[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): MergedCandidate[] {
  const K = criticBudget(nodes, cfg);

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
