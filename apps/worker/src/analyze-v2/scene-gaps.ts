import type { AnalyzeConfig } from "./config";
import type { SentenceNode } from "./types";

/**
 * The last node before the source cuts to a different scene.
 *
 * A clip may never be extended across one of these. On a compilation reel - and
 * the first real one arrived on 2026-08-03, kept as the `sitcom-friends`
 * fixture - the next scene is unrelated material with different people in it,
 * so an extension that crosses a cut does not lengthen a moment, it staples two
 * moments together.
 *
 * The signal is a silent hole in the timeline, which is what a hard cut leaves
 * behind: consecutive nodes normally abut (median gap 0.44s on sitcom-friends)
 * while the verified cut at t=1370 leaves 17.0s of nothing. Podcasts have no
 * such holes, so this returns the end of the graph there and the guard is
 * inert - which is the correct behaviour, not a limitation.
 *
 * Two invariants callers may rely on. The result is always at or AFTER fromIdx,
 * so it is safe to use directly as a ceiling and can never shorten the clip
 * that asked. And it EQUALS fromIdx when the very next node is already across a
 * cut: an empty extension window, which is a legal and meaningful answer rather
 * than an error, and exactly what a clip that already ends at a cut produces.
 * fromIdx must itself be a valid node index - there is no correct ceiling to
 * return for an invalid one, so this deliberately invents no fallback.
 *
 * Gaps are measured between consecutive nodes of ANY kind, opaque ones
 * included, and that distinction is the whole measurement. Counting the silence
 * between WORD-BEARING nodes instead - which is what eval-laugh-probe.ts prints
 * - treats every music/laughter node as a hole and reports a 44.4s maximum on
 * the podcast fixtures, which have no cuts at all. No threshold separates the
 * two populations under that metric; under this one they do not even overlap
 * (podcast max 4.26s, sitcom-friends max 17.0s).
 *
 * The two error directions are not symmetric and the threshold is chosen to
 * reflect that: this function only ever CAPS an extension, so declaring a cut
 * that is not there costs one forgone extension, while missing a real one ships
 * a clip made of two unrelated scenes. That is why sceneGapSec sits as low as
 * the no-cut fixtures allow. Callers must keep that contract - use this as a
 * ceiling, never to force a clip to end here.
 *
 * It is a partial rail, and knowing which half it covers matters more than the
 * count. A cut the audience laughs through gets a segment from Whisper, so it
 * becomes an opaque NODE and leaves no hole at all: of the 17 word-free
 * stretches of 8s or more on sitcom-friends, only 8 contain a true silence at
 * the shipped threshold. This finds the cuts that fall silent, which are the
 * long ones - it does not find them all.
 *
 * The threshold itself, and why 5: both podcast fixtures have no cuts and their
 * largest node-to-node hole is 4.26s (p99 2.0s over 52 minutes each), so 4
 * gives each of them a boundary and 5 is the smallest integer leaving both at
 * zero. That lands at the low end of the admissible range on purpose, per the
 * asymmetry above. Re-measure before moving it; SCENE_GAP_SEC overrides it.
 */
export function sceneEndAfter(
  nodes: SentenceNode[],
  fromIdx: number,
  cfg: AnalyzeConfig
): number {
  for (let i = fromIdx + 1; i < nodes.length; i++) {
    if (nodes[i].start - nodes[i - 1].end >= cfg.sceneGapSec) return i - 1;
  }
  return nodes.length - 1;
}

/**
 * The backward twin of sceneEndAfter, built for start-extension.ts (spec
 * 2026-08-10 task 3): the earliest node a clip's START may be widened onto
 * without crossing a silent hole into the PREVIOUS scene. Same rail, same
 * measurement (sceneGapSec's derivation lives above and is not repeated here),
 * mirrored in the other time direction.
 *
 * The two invariants sceneEndAfter documents both mirror exactly. The result
 * is always at or BEFORE fromIdx, so it is safe to use directly as a floor and
 * can never widen a clip past its own start into nothing. And it EQUALS
 * fromIdx when the very PREVIOUS node is already across a cut: an empty
 * widening window, which is the correct answer for a clip that already opens
 * at a cut, not an error. fromIdx must itself be a valid node index - as with
 * sceneEndAfter, there is no correct floor to return for an invalid one.
 *
 * Podcasts have no cuts (§ sceneEndAfter's own measurement), so this returns 0
 * there and the guard is inert - same correct-not-limited behaviour as the
 * forward version.
 */
export function sceneStartBefore(
  nodes: SentenceNode[],
  fromIdx: number,
  cfg: AnalyzeConfig
): number {
  for (let i = fromIdx - 1; i >= 0; i--) {
    if (nodes[i + 1].start - nodes[i].end >= cfg.sceneGapSec) return i + 1;
  }
  return 0;
}
