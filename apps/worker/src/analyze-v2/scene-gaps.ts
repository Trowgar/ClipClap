import type { AnalyzeConfig } from "./config";
import type { SentenceNode } from "./types";

/**
 * The last node before the source cuts to a different scene.
 *
 * A clip may never be extended across one of these. On a compilation reel - and
 * the first real one arrived on 2026-08-03 - the next scene is unrelated
 * material with different people in it, so an extension that crosses a cut does
 * not lengthen a moment, it staples two moments together.
 *
 * The signal is a silent hole in the timeline, which is what a hard cut leaves
 * behind: consecutive nodes normally abut (median gap 0.44s on the sitcom
 * fixture) while the verified cut at t=1370 leaves 17.0s of nothing. Podcasts
 * have no such holes, so this returns the end of the graph there and the guard
 * is inert - which is the correct behaviour, not a limitation.
 *
 * Gaps are measured between consecutive nodes of ANY kind, opaque ones
 * included, and that distinction is the whole measurement. Counting the silence
 * between WORD-BEARING nodes instead - which is what eval-laugh-probe.ts prints
 * - treats every music/laughter node as a hole and reports a 44.4s maximum on
 * the podcast fixtures, which have no cuts at all. No threshold separates the
 * two populations under that metric; under this one they do not even overlap
 * (podcast max 4.26s, compilation max 17.0s).
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
 * stretches of 8s or more on the compilation fixture, only 8 contain a true
 * silence at the shipped threshold. This finds the cuts that fall silent, which
 * are the long ones - it does not find them all.
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
