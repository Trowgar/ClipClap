import type { AnalyzeConfig } from "./config";
import {
  anaphoricRunEnd,
  endsOnQuestionMark,
  isCleanEnd,
  isCleanStart,
} from "./sentence-graph";
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

  // 2b. clean end - the mirror of the clean-start guard. A weak trailing
  //     boundary followed by a lowercase continuation ("...искала ты его
  //     потому,") is a mid-clause cut. Repair order: BACKWARD first - trimming
  //     the dangling fragment to the latest clean end at or after the payoff
  //     never adds foreign content ("...единорога." wins over "...потому,").
  //     FORWARD (within SENTENCE_SLACK) only when no clean end exists between
  //     the payoff and e - i.e. the payoff's own sentence is still open and
  //     must be completed. Neither works -> drop, better lost than broken.
  if (e.hasWords && !isCleanEnd(nodes, e.index)) {
    let repaired: SentenceNode | null = null;
    for (let i = e.index - 1; i >= p.index; i--) {
      if (nodes[i].hasWords && isCleanEnd(nodes, i)) {
        repaired = nodes[i];
        break;
      }
    }
    if (!repaired) {
      for (let i = e.index + 1; i < nodes.length; i++) {
        if (nodes[i].end - e.end > SENTENCE_SLACK_SEC) break;
        if (nodes[i].hasWords && isCleanEnd(nodes, i)) {
          repaired = nodes[i];
          break;
        }
      }
    }
    if (!repaired) return { ok: false, reason: "no_clean_end" };
    e = repaired;
  }

  // 3. seconds from real node edges (lead-in/tail-hold only ever move within
  //    silence). The next-node cap stops the tail-hold from bleeding into the
  //    next sentence's first word - an audible end-of-clip artifact; it can only
  //    trim hold-silence, never the payoff's last word, because of the max guard.
  const prevS = s.index > 0 ? nodes[s.index - 1] : null;
  // Nested prev.end must never push the start past the sentence onset; worst
  // case we start exactly at s.start with no lead-in.
  let startSec = Math.max(Math.min(prevS ? prevS.end : 0, s.start), s.start - cfg.leadInSec);
  const endSecFor = (n: SentenceNode) => {
    const next = n.index < maxIdx ? nodes[n.index + 1] : null;
    let sec = Math.min(n.end + cfg.tailHoldSec, next ? next.start : Infinity);
    sec = Math.max(sec, n.end); // nested-word ends: the cap must never cut the last word
    return Math.max(sec, p.end); // payoff containment outranks the bleed cap - a nested long payoff word extends the clip
  };

  // 3b. anaphoric run - the mirror of every other guard here, pointed at what
  //     happens JUST AFTER the cut rather than at the cut itself.
  //
  //     A clip must not end on the first or a middle beat of a run of sentences
  //     opening on the same word. Job cms2c8ahm shipped 87.4-157.0s ending on
  //     "Планета еще и не такое видала" with "Планета видала вулканические
  //     катастрофы / Планета видала астероидные импакты / Планете 4 5 миллиарда
  //     лет" following it; every check in this file passed and the owner still
  //     said "it seems to cut off". See sentence-graph.ts for the definition and
  //     the measured base rate (one run per 52-minute episode).
  //
  //     THE END RULE OWNS ITSELF and outranks two neighbours on purpose:
  //     - It runs AFTER the payoff-tail pullback (step 2), so it may put the end
  //       further past the payoff than payoffMaxTailSec allows. That bound
  //       exists to stop aimless padding; a rhetorical build is the payoff's own
  //       completion, not padding.
  //     - It runs BEFORE the cap (step 5a), so an extension that does not fit is
  //       never paid for by compressing the start - the fit is tested against
  //       the start we already have.
  //     A run whose end sits behind an unclean boundary is left alone rather
  //     than repaired forward: 2b has already certified the current end, and
  //     walking further would trade a known-good boundary for an unknown one.
  //
  //     WHEN IT DOES NOT FIT the clip ships truncated. Dropping is the
  //     alternative and it is worse by this engine's standing asymmetry: an
  //     invisible loss nobody can report beats a visible mediocrity that the
  //     owner can (and did). The critic already approved this moment; a
  //     boundary rule with no repair available may not veto it.
  if (e.hasWords) {
    const runEnd = anaphoricRunEnd(nodes, e.index);
    if (
      runEnd !== null &&
      isCleanEnd(nodes, runEnd) &&
      endSecFor(nodes[runEnd]) - startSec <= cfg.maxSec
    ) {
      e = nodes[runEnd];
    }
  }

  let endSec = endSecFor(e);

  const hookStartSec = nodes[verdict.hookStartNode].start;
  const hookEndSec = nodes[verdict.hookEndNode].end;

  // 5a. over-length compression BEFORE invariants: pull the start forward onto
  //     a legal clip start, never past the hook; impossible -> drop.
  //
  //     LEGAL MEANS isCleanStart, the same test as the walk-back at the top of
  //     this function, as the critic's ¶ window markers, and as the finalizer's
  //     trim gate. It used to mean `leadingStrength >= STRONG`, which is neither
  //     necessary nor sufficient, and both errors were measured on job
  //     cms2c8ahm: node #805 has leadingStrength 0.80 but opens lowercase
  //     mid-thought ("или отупеть до состояния совсем полена"), while #807 has
  //     leadingStrength 0.20 and IS a clean start because an opaque node - the
  //     host's question - precedes it. Compression skipped #807 for its weak
  //     number and landed on #808, deleting the framing the whole clip answers
  //     and 30.7s more than the cap required.
  //
  //     EARLIEST fitting candidate, not the strongest or the latest: the loop
  //     walks forward and stops at the first fit, which is by construction the
  //     one that deletes the least. Preferring the latest fitting start would
  //     have taken the same clip from #807 to #821 and the neanderthal clip from
  //     #755 to #756, deleting more of a range the critic had already approved
  //     for no gain - the cap is a ceiling, not a target.
  //
  //     The hook bound is the one thing compression may never eat: the critic
  //     named those nodes as the moment itself. It is deliberately NOT extended
  //     to "never delete the setup the critic put before the hook" - that would
  //     drop the survival clip outright, because its hook sits 19 nodes and 88s
  //     after its start, and engine-notes §3 measured hook geometry as critic
  //     variance rather than signal.
  if (endSec - startSec > cfg.maxSec) {
    let compressed = false;
    for (let i = s.index + 1; i <= verdict.hookStartNode; i++) {
      const cand = nodes[i];
      // isCleanStart already requires hasWords - an opaque node has no reliable
      // onset to cut at - so there is no separate word-bearing test here.
      if (!isCleanStart(nodes, i)) continue;
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
      // The range that shipped, which is what every later "is this node inside
      // the clip" question has to be answered against. Publishing the critic's
      // proposal instead is how a description came to narrate a node that four
      // lines of compression had just deleted (job cms2c8ahm).
      finalStartNode: s.index,
      finalEndNode: e.index,
      hookStartSec,
      hookEndSec,
      payoffSec: p.end,
      shortMoment: duration < cfg.targetMinSec,
      boundaryConfidence,
      endsOnQuestion: endsOnQuestionMark(e.text),
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
