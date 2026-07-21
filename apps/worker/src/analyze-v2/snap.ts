import type { AnalyzeConfig } from "./config";
import { isCleanStart } from "./sentence-graph";
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

  // An opaque payoff (punchline drowned in laughter/music - words unreliable)
  // is NOT dropped: its segment-level start/end are real Whisper boundaries,
  // just coarser. Such clips ship with boundaryConfidence "segment".
  let boundaryConfidence: "word" | "segment" = p.hasWords ? "word" : "segment";

  // Shared clean-start semantics (also drives the critic's ¶ window markers).
  const cleanStartAt = (n: SentenceNode) => isCleanStart(nodes, n.index);

  // 1. clean start - the mid-thought guard the end already has via trailingStrength.
  //    Walk to an earlier node whose leading boundary is strong, adding at most
  //    maxStartExpansionSec of lead-in; no such node -> drop.
  if (!cleanStartAt(s) && s.index > 0) {
    let found: SentenceNode | null = null;
    for (let i = s.index - 1; i >= 0; i--) {
      const cand = nodes[i];
      if (s.start - cand.start > cfg.maxStartExpansionSec) break;
      if (cand.hasWords && cleanStartAt(cand)) {
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
  // An opaque end node has no reliable last-word time: prefer walking back to
  // the last word-bearing node at or after the payoff. When none exists (the
  // payoff itself is opaque), keep the opaque node - its segment edge is a real
  // Whisper boundary - and mark the clip segment-confidence.
  if (!e.hasWords) {
    const walked = lastWordBearingBefore(nodes, e.index);
    if (walked && walked.index >= p.index) {
      e = walked;
    } else if (e.index >= p.index) {
      boundaryConfidence = "segment";
    } else {
      return { ok: false, reason: "opaque_end" };
    }
  }

  // 3. seconds from real node edges (lead-in/tail-hold only ever move within
  //    silence). The next-node cap stops the tail-hold from bleeding into the
  //    next sentence's first word - an audible end-of-clip artifact; it can only
  //    trim hold-silence, never the payoff's last word, because of the max guard.
  const prevS = s.index > 0 ? nodes[s.index - 1] : null;
  // Nested prev.end must never push the start past the sentence onset; worst
  // case we start exactly at s.start with no lead-in.
  let startSec = Math.max(Math.min(prevS ? prevS.end : 0, s.start), s.start - cfg.leadInSec);
  const nextE = e.index < maxIdx ? nodes[e.index + 1] : null;
  let endSec = Math.min(e.end + cfg.tailHoldSec, nextE ? nextE.start : Infinity);
  endSec = Math.max(endSec, e.end); // nested-word ends: the cap must never cut the last word
  endSec = Math.max(endSec, p.end); // payoff containment outranks the bleed cap - a nested long payoff word extends the clip

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
      // same onset clamp as the main start: nested prev.end must not poison the candidate
      const candidateStart = Math.max(Math.min(prev ? prev.end : 0, cand.start), cand.start - cfg.leadInSec);
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
      boundaryConfidence,
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
