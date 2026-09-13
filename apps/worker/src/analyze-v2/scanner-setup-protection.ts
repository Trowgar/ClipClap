import { isCleanStart, looksLikeQuestion } from "./sentence-graph";
import { startSecFor } from "./snap";
import type { AnalyzeConfig } from "./config";
import type { MergedCandidate, SentenceNode, SnappedClip } from "./types";

/**
 * Restores a short question/setup that the scanner included and the critic
 * removed from an otherwise kept episode. The narrow geometry is deliberate:
 * September data had one shipped false negative at two nodes / 6.1 seconds,
 * while broader question restoration mostly targeted candidates that never
 * survived and would add up to 51 seconds of unrelated context.
 */
export function restoreScannerQuestionSetup(
  clip: SnappedClip,
  candidate: MergedCandidate | undefined,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
): boolean {
  if (!candidate || clip.finalStartNode <= candidate.startNode) return false;
  const removedNodes = clip.finalStartNode - candidate.startNode;
  if (removedNodes > 2) return false;
  const first = nodes[candidate.startNode];
  const current = nodes[clip.finalStartNode];
  const end = nodes[clip.finalEndNode];
  if (
    !first || !current || !end ||
    !Number.isFinite(first.start) || !Number.isFinite(current.start) || !Number.isFinite(end.end) ||
    !looksLikeQuestion(first.text)
  ) return false;
  if (!isCleanStart(nodes, candidate.startNode)) return false;
  for (let index = candidate.startNode + 1; index <= clip.finalStartNode; index++) {
    if (nodes[index].start - nodes[index - 1].end >= cfg.sceneGapSec) return false;
  }
  if (current.start - first.start > 8 || clip.endSec - startSecFor(nodes, first, cfg) > cfg.maxSec) return false;
  clip.finalStartNode = candidate.startNode;
  clip.startSec = startSecFor(nodes, first, cfg);
  clip.shortMoment = clip.endSec - clip.startSec < cfg.targetMinSec;
  if (!first.hasWords) clip.boundaryConfidence = "segment";
  return true;
}
