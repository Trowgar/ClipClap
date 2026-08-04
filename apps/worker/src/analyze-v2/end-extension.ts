import type { AnalyzeConfig } from "./config";
import { endsOnQuestionMark, isCleanEnd } from "./sentence-graph";
import { sceneEndAfter } from "./scene-gaps";
import type { SentenceNode, SnappedClip } from "./types";

export interface ExtensionWindow {
  /** Highest node index this clip may legally be extended to. Equals the clip's
   *  own end when no extension is possible. */
  lastNode: number;
}

/**
 * How far this clip is allowed to reach. The tighter of two bounds: the next
 * scene cut, and endExtensionWindowSec of wall clock.
 *
 * A CEILING, never a target. Nothing here says a clip should end at lastNode -
 * it says nothing past lastNode may be offered to a model or accepted from one.
 * The common answer to "should this clip run longer" is no, and this function
 * has no opinion about it.
 *
 * The two bounds are not redundant and neither is decoration. The scene rail is
 * PARTIAL by construction: a cut the audience laughs through arrives as an
 * opaque node and leaves no silence behind, so only 8 of the 17 word-free
 * stretches on the sitcom-friends fixture are detectable at all (scene-gaps.ts).
 * When the rail is blind - which includes every podcast, where there are no cuts
 * to find - the clock is the only thing standing between a clip and the rest of
 * the video. And when the clock is generous the rail is what stops a compilation
 * clip from stapling two unrelated scenes together.
 *
 * The deadline is measured from the END NODE's last word, not from clip.endSec,
 * so the tail hold is not charged against the window: the hold is silence, and
 * "25 seconds further" should mean 25 seconds of further material. A node ending
 * exactly on the deadline is inside it.
 *
 * The loop BREAKS on the first node that overruns the deadline rather than
 * skipping it. A clip is a contiguous range: node i+1 cannot play without node
 * i, so a single long node closes the window for everything behind it. Skipping
 * would offer an end whose inclusion drags the clip far past the window - and
 * node ends really can overrun their successor's start, because word timings
 * nest (snap.ts:168).
 *
 * clip.finalEndNode must be a real index into `nodes` - sceneEndAfter refuses to
 * invent a ceiling for an invalid one, and neither does this.
 */
export function extensionWindow(
  clip: SnappedClip,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): ExtensionWindow {
  const from = clip.finalEndNode;
  const sceneEnd = sceneEndAfter(nodes, from, cfg);
  const deadline = nodes[from].end + cfg.endExtensionWindowSec;
  let last = from;
  for (let i = from + 1; i <= sceneEnd; i++) {
    if (nodes[i].end > deadline) break;
    last = i;
  }
  return { lastNode: last };
}

/**
 * Applies a proposed end node, or refuses it.
 *
 * Refusal is the default and returns null. Every branch below is a way for a
 * model's proposal to be wrong, and the caller's only job is to keep the clip it
 * already had when one fires. Nothing here is advisory.
 *
 * This stage may only ever move an end FORWARD: shortening is the finalizer's
 * `trim`, which has its own gates, and more importantly a shorter range can push
 * titleEvidenceNodes outside the clip and silently degrade copy - engine-notes
 * §6 "boundaries are code-owned", and the `Плюсы` defect it points at in §4.
 * Widening cannot, which is the whole reason this stage is safe to run after
 * copy has been grounded.
 *
 * The gates, and what each one is for:
 *
 * - INTEGER. A model that answers 8.5, or a NaN out of a parse, must never be
 *   used as an array index - nodes[8.5] is undefined and every later gate reads
 *   a property off it.
 * - FORWARD ONLY, by index. The never-shorten rule, stated above.
 * - INSIDE THE GRAPH. Belt to the window's braces: the window can only ever
 *   return an index that exists, so this cannot fire today, and it stays because
 *   it is the gate that keeps that true if the window's own bound ever changes.
 * - INSIDE THE WINDOW. The scene cut and the clock, above.
 * - WORD-BEARING. An opaque node's timings are segment-level (music, laughter,
 *   crosstalk), so ending on one puts the boundary at a coarse Whisper edge.
 *   snapNodes walks BACK off opaque ends for exactly this reason; walking ONTO
 *   one here would undo that.
 * - CLEAN END. The same test snap applies to every other end. A weak trailing
 *   boundary followed by a lowercase continuation is a mid-clause cut, and a
 *   clip that ends mid-clause is worse than a clip that ends early - which is
 *   the whole complaint this stage exists to answer.
 * - FORWARD ONLY, in seconds. Not implied by the index gate: word timings nest,
 *   so a later node can end EARLIER than the clip already does, and such a
 *   proposal would shorten the clip - and can strand the payoff outside it -
 *   while passing every index check. Equality is refused too, because a node
 *   whose whole span is already inside the clip adds no ending to extend; this
 *   is the same no-op the index gate refuses, wearing a different index. So an
 *   ACCEPTED extension always moves endSec strictly later, which is the property
 *   callers and telemetry can rely on.
 * - MAX LENGTH. maxSec is the platform ceiling, and this is the only stage that
 *   can approach it from below. snapNodes compresses an over-long clip by moving
 *   its START; there is no equivalent repair here, because moving the start is
 *   exactly what this stage promises not to do. So an over-long proposal is
 *   refused outright and the clip keeps the end it had.
 */
export function applyExtension(
  clip: SnappedClip,
  nodes: SentenceNode[],
  proposedEndNode: number,
  cfg: AnalyzeConfig
): SnappedClip | null {
  if (!Number.isInteger(proposedEndNode)) return null;
  if (proposedEndNode <= clip.finalEndNode) return null;
  if (proposedEndNode > nodes.length - 1) return null;

  const { lastNode } = extensionWindow(clip, nodes, cfg);
  if (proposedEndNode > lastNode) return null;

  const e = nodes[proposedEndNode];
  if (!e.hasWords) return null;
  if (!isCleanEnd(nodes, proposedEndNode)) return null;

  // Same seconds arithmetic as snap.ts:122-123, and for the same two reasons:
  // the tail hold may only ever move within silence, so it is capped at the next
  // node's onset; and the cap may never cut the end node's own last word, so the
  // node's end wins over the cap when timings nest.
  const next = proposedEndNode < nodes.length - 1 ? nodes[proposedEndNode + 1] : null;
  let endSec = Math.min(e.end + cfg.tailHoldSec, next ? next.start : Infinity);
  endSec = Math.max(endSec, e.end);
  if (endSec <= clip.endSec) return null;
  if (endSec - clip.startSec > cfg.maxSec) return null;

  // A NEW clip, never the argument mutated: clips travel by reference between
  // stages, and an accepted extension must not reach back into the caller's copy.
  //
  // Two fields are DERIVED from the end and are recomputed with the same
  // expressions snap.ts:204-206 used, because carrying them forward would leave
  // the clip describing an end it no longer has. shortMoment is a length verdict
  // and this stage changes the length; it is persisted onto the highlight, so a
  // stale `true` would mark a 20s clip a fragment. endsOnQuestion names the last
  // sentence, and "the answer to a question the clip ends on" is one of the beats
  // this stage exists to reach - the clip that ended on "so is it true?" now ends
  // on the answer, and the flag has to say so. Its consumer (select.ts) has
  // already run and priced the old end; nothing re-scores from it here.
  //
  // boundaryConfidence is NOT recomputed and does not need to be: it degrades to
  // "segment" for an opaque payoff or an opaque end, the payoff cannot move here
  // and an opaque end is refused above, so the value snap derived still holds.
  return {
    ...clip,
    endSec,
    finalEndNode: proposedEndNode,
    shortMoment: endSec - clip.startSec < cfg.targetMinSec,
    endsOnQuestion: endsOnQuestionMark(e.text),
  };
}
