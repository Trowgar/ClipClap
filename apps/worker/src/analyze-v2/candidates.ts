import type { AnalyzeConfig } from "./config";
import type { AnalysisMode } from "./mode";
import type { MergedCandidate, ScanCandidate, SentenceNode } from "./types";

const SPAN_GUARD_SEC = 130;
const REGION_SEC = 600;

/** STREAM MODE burst expansion (spec 2026-08-19-stream-analyze-mode §S4):
 *  a silence gap strictly longer than this between two adjacent nodes is a
 *  real scene cut, and expansion may not cross one. Literal, not a cfg
 *  field - the spec names this exact number, not a tuning door. */
const BURST_EXPANSION_GAP_SEC = 3;

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
  cfg: AnalyzeConfig,
  // consumed by tasks T2-T4 of the stream-analyze-mode spec
  mode: AnalysisMode = "standard"
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

  // STREAM MODE burst expansion (spec §S4, task T4). Phase-1 measurement
  // (2026-08-19-stream-moment-selection.md): merge only unions OVERLAPPING
  // candidates, so a lone 1-node scanner hit shipped as a 3.2-second
  // candidate (the "ГОЛЫЙ КОРОЛЬ" label) - too short for any critic verdict
  // to save (it died at critic score 0.12). Every stream-mode candidate
  // still under streamMinCandidateSec widens node-by-node, BACKWARD FIRST -
  // "the trigger of a reaction lives before the burst" (spec §S4): a
  // scream's setup line sits just before it, not after, so recovering that
  // context is worth more than a trailing node the reaction has already
  // finished by. Backward expansion runs until it is blocked (a >3s silence
  // gap, another candidate's own pre-expansion range, or node 0), and only
  // then does forward expansion take over for whatever span is still
  // missing - never the two interleaved, and never past `maxNode`.
  // Standard mode never reaches this block; the return value is otherwise
  // unchanged by its presence.
  if (mode === "stream") {
    // Neighbor walls, computed ONCE from every candidate's range as it
    // stands right now (post-merge, post-split, pre-expansion) and fixed
    // for the whole pass - so candidate A's expansion can never be widened
    // or narrowed by the fact that candidate B, processed earlier in this
    // same loop, already grew. Order-independent by construction.
    const order = guarded
      .map((_, i) => i)
      .sort((a, b) => guarded[a].startNode - guarded[b].startNode);
    const backLimit: number[] = new Array(guarded.length);
    const fwdLimit: number[] = new Array(guarded.length);
    for (let k = 0; k < order.length; k++) {
      const idx = order[k];
      backLimit[idx] = k > 0 ? guarded[order[k - 1]].endNode + 1 : 0;
      fwdLimit[idx] = k < order.length - 1 ? guarded[order[k + 1]].startNode - 1 : maxNode;
    }

    for (let i = 0; i < guarded.length; i++) {
      const c = guarded[i];
      while (nodes[c.endNode].end - nodes[c.startNode].start < cfg.streamMinCandidateSec) {
        const canBack =
          c.startNode > backLimit[i] &&
          nodes[c.startNode].start - nodes[c.startNode - 1].end <= BURST_EXPANSION_GAP_SEC;
        if (canBack) {
          c.startNode--;
          continue;
        }
        const canFwd =
          c.endNode < fwdLimit[i] &&
          nodes[c.endNode + 1].start - nodes[c.endNode].end <= BURST_EXPANSION_GAP_SEC;
        if (canFwd) {
          c.endNode++;
          continue;
        }
        break; // both directions blocked - ships shorter than the target, never crashes
      }
      // payoffNode clamp, same convention as the top of this function: widening
      // can only ever keep an already-inside payoff inside, so this is a
      // defensive no-op on every real input, not a live code path.
      if (c.payoffNode < c.startNode) c.payoffNode = c.startNode;
      if (c.payoffNode > c.endNode) c.payoffNode = c.endNode;
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
  return budgetForCap(nodes, cfg.criticMaxCandidates);
}

/** The rate/floor math behind `criticBudget`, pulled out so
 *  `selectCriticCandidates` can apply the STREAM MODE cap override (spec
 *  §S3, task T3) by passing a different ceiling, without duplicating the
 *  per-minute rate or the CRITIC_MIN_CANDIDATES floor and without touching
 *  `criticBudget`'s own signature - every existing caller (index.ts's
 *  telemetry line, eval-selection-autopsy.ts) keeps reading the
 *  standard-mode number, unchanged, exactly as before this task. */
function budgetForCap(nodes: SentenceNode[], maxCandidates: number): number {
  const sourceMinutes = sourceSeconds(nodes) / 60;
  return Math.min(
    maxCandidates,
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
  cfg: AnalyzeConfig,
  // consumed by tasks T2-T4 of the stream-analyze-mode spec
  mode: AnalysisMode = "standard"
): MergedCandidate[] {
  // STREAM MODE budget override (spec §S3, task T3). Phase-1 measurement
  // (2026-08-19-stream-moment-selection.md): on a 3h stream the per-window
  // quota (perWindowMinCandidates=2, ~18 windows) consumed 36 of
  // criticMaxCandidates=40 slots before global interest fill ever ran - the
  // scanner's OWN find, the corpus's most-viral labeled moment (15,847
  // views, "осуждаю"), was rationed out unjudged. The cap swaps to
  // streamCriticMaxCandidates (80) rather than adding a flat number, so K
  // still SCALES WITH SPEECH exactly as standard mode does (`budgetForCap`
  // unchanged) - just against double the ceiling. That doubling is free: a
  // full 3h scan+critic run measured 126k in / 15k out tokens (~$0.04)
  // against the spec's own ~$1.21 total cost for a 3h job (spec §0.1).
  const K = budgetForCap(nodes, mode === "stream" ? cfg.streamCriticMaxCandidates : cfg.criticMaxCandidates);

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

  // guaranteed per-window quota. STREAM MODE drops this 2 -> 1 (spec §S3):
  // the 2-per-window guarantee is exactly what ate the budget above (36 of
  // 40 slots on the measured 3h source) - dropping to 1 keeps the coverage
  // promise (every window still gets its single best candidate judged) and
  // frees the rest of K to global interest order, which is where the
  // ration-victim moment actually lived.
  const perWindowQuota = mode === "stream" ? 1 : cfg.perWindowMinCandidates;
  for (const list of byWindow.values()) {
    list
      .sort((a, b) => b.interest - a.interest)
      .slice(0, perWindowQuota)
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
