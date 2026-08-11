import type { AnalyzeConfig } from "./config";
import {
  endsOnQuestionMark,
  endsOnSentenceMark,
  isCleanEnd,
  isCleanStart,
} from "./sentence-graph";
import type { CriticVerdict, SentenceNode, SnapResult } from "./types";

const EPS = 0.05;
/** Extra window the PAYOFF-CONTAINMENT fallback may borrow when no strong
 *  boundary exists within payoffMaxTailSec. Untouched at 3s. */
const SENTENCE_SLACK_SEC = 3;
/**
 * How far the clean-end repair may reach FORWARD to close a sentence the end
 * node left open.
 *
 * 5, not 3, and the number came from the transcripts rather than from taste: the
 * two `"...космические корабли,"` offenders are completed by an opaque node
 * **4.22s** past their end node, so a 3s reach rescued 1 of the 4 clips this
 * repair can save and 5s rescues 4 of 4. It is a CEILING on how much foreign
 * material a repair may add, so it should be the smallest number that clears the
 * measured cases, and 5 is a 0.78s margin over 4.22.
 *
 * DELIBERATELY ITS OWN CONSTANT rather than a second use of SENTENCE_SLACK_SEC,
 * which it was on 2026-08-05. The two answer different questions - how far past
 * the payoff a strong boundary may be hunted, versus how far past the end node a
 * sentence may be closed - and sharing one number means widening this reach
 * silently widens the payoff window too, which nothing measured.
 *
 * MEASURED ON FOUR SOURCES ONLY (two Russian podcast transcriptions of the same
 * episode, one sitcom, one creator vlog). On its own - the old rule, this reach -
 * it moves no shipped clip on any of them; it only extends the repair's arm.
 * Anyone widening it again should say which source asked for it.
 */
const CLEAN_END_REACH_SEC = 5;
const STRONG = 0.8;

/**
 * Where a clip ENDS in seconds, given the node it ends on. Two rules, both
 * audible.
 *
 * The tail hold may only ever move within silence, so it is capped at the next
 * node's onset: without the cap the clip plays the first word of the next
 * sentence, an end-of-clip artifact. And the cap may never cut the end node's
 * own last word, so the node's end outranks it - word timings NEST (see the
 * `max, not last` comment on `end:` in buildSentenceGraph: a long word
 * containing a short one passes the reliability check), which lets a node's end
 * overrun its successor's start.
 *
 * Shared with end-extension.ts because an end this engine MOVES has to be placed
 * by the same arithmetic as an end it snapped, or the same node would sound
 * different depending on which stage put the boundary there. It was copied there
 * once and defended with a comment; parity a reader has to re-verify by eye is
 * parity that drifts, so it lives here, in the module that owns boundaries.
 *
 * Payoff containment is deliberately NOT here. snap applies it on the next line
 * because snap is the only module that knows the payoff, and the one other
 * caller only ever moves an end later, where the payoff cannot be stranded.
 *
 * One caveat, measured on 2026-08-04 rather than assumed: the eval fixtures
 * cannot see the nested-word clamp. Deleting it leaves all six snapshot replays
 * GREEN - no shipped clip on those four sources ends on a node whose nested end
 * overruns its successor - while deleting the tail hold reddens all six, so the
 * replay does watch these seconds, just not that branch. Its only guard in the
 * repo is end-extension.test.ts, "never cuts the last word of the new end node".
 * A green fixture run is not evidence about this line.
 */
export function endSecFor(
  nodes: SentenceNode[],
  e: SentenceNode,
  cfg: AnalyzeConfig
): number {
  const next = e.index < nodes.length - 1 ? nodes[e.index + 1] : null;
  return Math.max(
    Math.min(e.end + cfg.tailHoldSec, next ? next.start : Infinity),
    e.end
  );
}

/** The start-side twin of endSecFor, and exported for the same reason: the
 *  stage that moves a start backward (start-extension.ts) must place a node at
 *  exactly the second snap would, or the two disagree about where one node
 *  starts. The lead-in only ever moves within silence - capped by the previous
 *  node's own end (nested word timings can make prev.end run past this node's
 *  start; worst case the clip starts exactly at s.start with no lead-in) and
 *  never earlier than leadInSec before the onset. Until 2026-08-10 this
 *  expression lived inline in snapNodes TWICE (main start + compression
 *  candidate) and was about to be hand-copied into a third file. */
export function startSecFor(
  nodes: SentenceNode[],
  s: SentenceNode,
  cfg: AnalyzeConfig
): number {
  const prev = s.index > 0 ? nodes[s.index - 1] : null;
  return Math.max(Math.min(prev ? prev.end : 0, s.start), s.start - cfg.leadInSec);
}

/**
 * Minimal shape `compressToFit` needs. NOT a `SnappedClip` - the function runs
 * from two places: mid-way through `snapNodes` (before a `SnappedClip` exists
 * at all, only a candidate start node and a fixed end second) and from
 * index.ts's long-clip policy / the finalizer's defence-in-depth gate (spec
 * 2026-08-10 task 5), both of which already hold a real `SnappedClip` and just
 * read three fields off it.
 */
export interface CompressInput {
  /** The clip's current start node index - the walk begins one PAST this. */
  startNode: number;
  /** The clip's end in seconds. Compression only ever moves the START;
   *  callers that also want the end recomputed are not this function's job. */
  endSec: number;
  /** The hook the critic named. The walk may never pass it - see snapNodes's
   *  own 5a comment for why that bound is not "never eat the setup". */
  hookStartNode: number;
}

export type CompressResult =
  | { ok: true; startNode: number; startSec: number }
  | { ok: false };

/**
 * Extracted 2026-08-10 (spec task 5) from snapNodes's own 5a compression walk,
 * which lived inline there since before this file's history and was about to
 * be hand-copied a second time for the long-clip policy. Byte-identical
 * semantics to the walk it replaced: EARLIEST fitting clean start (never the
 * strongest or the latest - see snapNodes's own comment for why "earliest"
 * deletes the least), never past `hookStartNode`, seconds via `startSecFor` -
 * the same arithmetic snap uses everywhere else, so a node this function
 * accepts can never be placed at two different seconds by two different
 * callers.
 */
export function compressToFit(
  clip: CompressInput,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): CompressResult {
  for (let i = clip.startNode + 1; i <= clip.hookStartNode; i++) {
    const cand = nodes[i];
    // isCleanStart already requires hasWords - an opaque node has no reliable
    // onset to cut at - so there is no separate word-bearing test here.
    if (!isCleanStart(nodes, i)) continue;
    const candidateStart = startSecFor(nodes, cand, cfg);
    if (clip.endSec - candidateStart <= cfg.maxSec) {
      return { ok: true, startNode: i, startSec: candidateStart };
    }
  }
  return { ok: false };
}

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
  //     FORWARD (within CLEAN_END_REACH_SEC) only when no clean end exists
  //     between the payoff and e - i.e. the payoff's own sentence is still open
  //     and must be completed. The forward scan takes the NEAREST node that can
  //     end the clip, word-bearing or opaque: everything in between plays either
  //     way, so the nearer end adds the least. Neither works -> drop, better lost
  //     than broken.
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
        if (nodes[i].end - e.end > CLEAN_END_REACH_SEC) break;
        if (nodes[i].hasWords && isCleanEnd(nodes, i)) {
          repaired = nodes[i];
          break;
        }
        // An OPAQUE node may close the sentence, and usually it is the node that
        // does: the continuation the end node was cut off from is inside the gap,
        // not past it. Ending here is not a new kind of clip - 12 of the 44 clips
        // the four eval fixtures ship already end on an opaque node - and its
        // segment edge is a real Whisper boundary, just coarser than a word edge,
        // which is exactly what "segment" confidence records.
        //
        // Only when the text CLOSES a sentence. Without that guard this branch
        // would end clips in the middle of a laugh, and the guard refuses 46-52
        // opaque nodes per fixture, so it is doing the work its name claims.
        if (!nodes[i].hasWords && endsOnSentenceMark(nodes[i].text)) {
          repaired = nodes[i];
          boundaryConfidence = "segment";
          break;
        }
      }
    }
    if (!repaired) return { ok: false, reason: "no_clean_end" };
    e = repaired;
  }

  // 3. seconds from real node edges (lead-in/tail-hold only ever move within
  //    silence). The end side - the next-node bleed cap and the nested-word
  //    clamp - is endSecFor above, shared with the stage that moves an end
  //    forward so the two can never place the same node differently.
  let startSec = startSecFor(nodes, s, cfg);
  let endSec = endSecFor(nodes, e, cfg);
  endSec = Math.max(endSec, p.end); // payoff containment outranks the bleed cap - a nested long payoff word extends the clip

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
  //
  //     Extracted to `compressToFit`, above, 2026-08-10 (spec task 5) - the
  //     walk itself is now shared with the long-clip policy in index.ts, which
  //     runs the SAME compression on a clip this function shipped wide when
  //     arc-audit did not bless it. Behaviour here is unchanged.
  //
  //     DEFERRAL (spec 2026-08-10 §2e, task 5): when `longClipsEnabled` and
  //     the span fits `longClipMaxSec`, the compression walk is SKIPPED
  //     entirely and the clip ships wide, marked `overLength`. This is a
  //     mechanical defer, not a decision - snapNodes has no opinion on
  //     whether the clip DESERVES to stay long; index.ts's policy (fed by
  //     arc-audit's flags, which have not run yet at this point in the
  //     pipeline) makes that call before extendClipStarts. A span over
  //     `longClipMaxSec` always compresses here, exactly as before the flag
  //     existed - `longClipMaxSec` is a ceiling on the DEFERRAL, not a second
  //     `maxSec`. Flag off: this whole branch is unreachable and the function
  //     is byte-for-byte identical to before task 5.
  let overLength = false;
  if (endSec - startSec > cfg.maxSec) {
    if (cfg.longClipsEnabled && endSec - startSec <= cfg.longClipMaxSec) {
      overLength = true;
    } else {
      const compressed = compressToFit(
        { startNode: s.index, endSec, hookStartNode: verdict.hookStartNode },
        nodes,
        cfg
      );
      if (!compressed.ok) return { ok: false, reason: "too_long" };
      s = nodes[compressed.startNode];
      startSec = compressed.startSec;
    }
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
      ...(overLength ? { overLength: true } : {}),
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
