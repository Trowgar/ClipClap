import type { AnalyzeConfig } from "./config";
import type { CriticVerdict, SentenceNode, SnapResult } from "./types";

const EPS = 0.05;
const SENTENCE_SLACK_SEC = 3;
const STRONG = 0.8;

export function snapNodes(
  verdict: CriticVerdict,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): SnapResult {
  const maxIdx = nodes.length - 1;
  const idxOk = (i: number) => Number.isInteger(i) && i >= 0 && i <= maxIdx;
  if (
    !idxOk(verdict.startNode) ||
    !idxOk(verdict.endNode) ||
    !idxOk(verdict.payoffNode) ||
    !idxOk(verdict.hookStartNode) ||
    !idxOk(verdict.hookEndNode)
  ) {
    return { ok: false, reason: "invariant_violation" };
  }

  let s = nodes[verdict.startNode];
  const p = nodes[verdict.payoffNode];
  let e = nodes[verdict.endNode];

  if (!p.hasWords) return { ok: false, reason: "opaque_payoff" };
  if (!s.hasWords && !e.hasWords) return { ok: false, reason: "opaque_end" };

  // 1. clean start - the mid-thought guard the end already has via trailingStrength.
  //    Walk to an earlier node whose leading boundary is strong, adding at most
  //    maxStartExpansionSec of lead-in; no such node -> drop.
  if (s.leadingStrength < STRONG && s.index > 0) {
    let found: SentenceNode | null = null;
    for (let i = s.index - 1; i >= 0; i--) {
      const cand = nodes[i];
      if (s.start - cand.start > cfg.maxStartExpansionSec) break;
      if (cand.hasWords && cand.leadingStrength >= STRONG) {
        found = cand;
        break;
      }
    }
    if (!found) return { ok: false, reason: "no_clean_start" };
    s = found;
  }
  if (!s.hasWords) return { ok: false, reason: "no_clean_start" };

  // 2. payoff containment, then bounded tail.
  //    Honor the critic's end node - it is already a sentence boundary - but never
  //    end before the payoff. Only when the end drags MORE than payoffMaxTailSec
  //    past the payoff do we pull it back to the strongest strong boundary within
  //    that window (then +SENTENCE_SLACK, else the payoff itself). No length
  //    padding, ever; a clean in-range end from the critic is kept as-is.
  if (e.index < p.index) e = p;
  if (e.end - p.end > cfg.payoffMaxTailSec) {
    e =
      pickEnd(nodes, p, cfg.payoffMaxTailSec) ??
      pickEnd(nodes, p, cfg.payoffMaxTailSec + SENTENCE_SLACK_SEC) ??
      p;
  }
  // An opaque end node has no reliable last-word time: walk back to the last
  // word-bearing node, but never before the payoff, else drop.
  if (!e.hasWords) {
    const walked = lastWordBearingBefore(nodes, e.index);
    if (!walked || walked.index < p.index) return { ok: false, reason: "opaque_end" };
    e = walked;
  }

  // 3. seconds from real node edges. Lead-in only ever moves within the silence
  //    before the start (never into the previous, excluded sentence). Tail-hold
  //    always applies in full: protecting the payoff's last word beats avoiding a
  //    sub-frame bleed into the next node.
  const prevS = s.index > 0 ? nodes[s.index - 1] : null;
  let startSec = Math.max(prevS ? prevS.end : 0, s.start - cfg.leadInSec);
  const endSec = e.end + cfg.tailHoldSec;

  const hookStartSec = nodes[verdict.hookStartNode].start;
  const hookEndSec = nodes[verdict.hookEndNode].end;

  // 5a. over-length compression BEFORE invariants: pull the start forward along
  //     strong boundaries only, never past the hook; impossible -> drop.
  if (endSec - startSec > cfg.maxSec) {
    let compressed = false;
    for (let i = s.index + 1; i <= verdict.hookStartNode; i++) {
      const cand = nodes[i];
      if (!cand.hasWords || cand.leadingStrength < STRONG) continue;
      const prev = cand.index > 0 ? nodes[cand.index - 1] : null;
      const candidateStart = Math.max(prev ? prev.end : 0, cand.start - cfg.leadInSec);
      if (endSec - candidateStart <= cfg.maxSec) {
        s = cand;
        startSec = candidateStart;
        compressed = true;
        break;
      }
    }
    if (!compressed) return { ok: false, reason: "too_long" };
  }

  // 4. epsilon-tolerant invariants - violation means drop, better lost than broken
  if (
    !(startSec <= hookStartSec + EPS) ||
    !(hookStartSec < hookEndSec) ||
    !(hookEndSec <= endSec + EPS) ||
    !(startSec < p.end && p.end <= endSec + EPS)
  ) {
    return { ok: false, reason: "invariant_violation" };
  }

  const duration = endSec - startSec;
  if (duration < cfg.hardMinSec) return { ok: false, reason: "too_short" };

  return {
    ok: true,
    clip: {
      verdict,
      startSec,
      endSec,
      hookStartSec,
      hookEndSec,
      payoffSec: p.end,
      shortMoment: duration < cfg.targetMinSec,
    },
  };
}

function pickEnd(
  nodes: SentenceNode[],
  payoff: SentenceNode,
  windowSec: number
): SentenceNode | null {
  let best: SentenceNode | null = null;
  for (let i = payoff.index; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.end - payoff.end > windowSec) break;
    if (n.hasWords && n.trailingStrength >= STRONG) {
      if (!best || n.trailingStrength > best.trailingStrength) best = n;
      if (n.trailingStrength >= 1.0) break; // cannot beat a terminal boundary
    }
  }
  return best;
}

function lastWordBearingBefore(
  nodes: SentenceNode[],
  fromIdx: number
): SentenceNode | null {
  for (let i = fromIdx; i >= 0; i--) {
    if (nodes[i].hasWords) return nodes[i];
  }
  return null;
}
