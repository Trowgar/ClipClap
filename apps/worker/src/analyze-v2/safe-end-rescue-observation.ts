import type { AnalyzeConfig } from "./config";
import type { ArcAuditGeometryEvidence } from "./arc-audit";
import { compressToFit, snapNodes } from "./snap";
import {
  safeEndGeometryReference,
  zeroTailHandoff,
  type RescueArcEvidence,
  type RescueProposedAction,
  type SafeEndRescueObservation,
  type SafeEndRescueRecord,
} from "./safe-end-audit";
import type { CriticVerdict, SentenceNode, SnappedClip } from "./types";

function sameGeometry(clip: SnappedClip, evidence: ArcAuditGeometryEvidence): boolean {
  const geometry = safeEndGeometryReference(clip);
  return (
    geometry.candidateId === evidence.id &&
    geometry.startNode === evidence.finalStartNode &&
    geometry.endNode === evidence.finalEndNode &&
    geometry.startMs === evidence.startMs &&
    geometry.endMs === evidence.endMs
  );
}

function arcEvidenceFor(
  clip: SnappedClip,
  evidence: ReadonlyMap<string, ArcAuditGeometryEvidence>,
): RescueArcEvidence {
  const matching = evidence.get(clip.verdict.id);
  if (!matching || !sameGeometry(clip, matching)) return "stale_or_absent";
  const standing =
    (!matching.flags.entry.ok && matching.flags.entry.repaired !== true) ||
    (!matching.flags.exit.ok && matching.flags.exit.repaired !== true) ||
    !matching.flags.standalone.ok;
  return standing ? "matching_standing" : "matching_clear";
}

function proposedAction(
  zeroTail: boolean,
  arcEvidence: RescueArcEvidence,
): RescueProposedAction {
  const standing = arcEvidence === "matching_standing";
  if (zeroTail && standing) return "both";
  if (zeroTail) return "zero_tail_handoff";
  if (standing) return "standing_arc";
  return "none";
}

/**
 * Observes exactly the geometry rescue can realize. This intentionally stops
 * before rescue's copy regrounding/fallback and never selects an output: its
 * selected marker merely names the first realizable geometry under rescue's
 * existing score/id ordering.
 */
export function observeRescueCandidates(
  verdicts: readonly CriticVerdict[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  arcEvidence: ReadonlyMap<string, ArcAuditGeometryEvidence>,
): SafeEndRescueObservation[] {
  const ordered = [...verdicts].sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id),
  );
  const observations: SafeEndRescueObservation[] = [];

  for (const [index, verdict] of ordered.entries()) {
    const snapped = snapNodes(verdict, nodes, cfg);
    if (!snapped.ok) {
      observations.push({
        candidateId: verdict.id,
        score: verdict.score,
        scoreRank: index + 1,
        language: verdict.language,
        ...(verdict.kind ? { kind: verdict.kind } : {}),
        status: "unrealizable",
        reason: snapped.reason,
        zeroTailHandoff: false,
        arcEvidence: "stale_or_absent",
        proposedAction: "none",
        selectedState: "not_selected",
      });
      continue;
    }
    let clip = snapped.clip;
    if (clip.overLength) {
      const compressed = compressToFit(
        {
          startNode: clip.finalStartNode,
          endSec: clip.endSec,
          hookStartNode: clip.verdict.hookStartNode,
        },
        nodes,
        cfg,
      );
      if (!compressed.ok) {
        observations.push({
          candidateId: verdict.id,
          score: verdict.score,
          scoreRank: index + 1,
          language: verdict.language,
          ...(verdict.kind ? { kind: verdict.kind } : {}),
          status: "unrealizable",
          reason: "compress_failed",
          zeroTailHandoff: false,
          arcEvidence: "stale_or_absent",
          proposedAction: "none",
          selectedState: "not_selected",
        });
        continue;
      }
      clip = {
        ...clip,
        startSec: compressed.startSec,
        finalStartNode: compressed.startNode,
        overLength: false,
        shortMoment: clip.endSec - compressed.startSec < cfg.targetMinSec,
      };
    }
    const matchedArcEvidence = arcEvidenceFor(clip, arcEvidence);
    const zeroTail = zeroTailHandoff(clip, nodes);
    observations.push({
      geometry: safeEndGeometryReference(clip),
      score: verdict.score,
      scoreRank: index + 1,
      language: verdict.language,
      ...(verdict.kind ? { kind: verdict.kind } : {}),
      status: "realizable",
      reason: null,
      zeroTailHandoff: zeroTail,
      arcEvidence: matchedArcEvidence,
      proposedAction: proposedAction(zeroTail, matchedArcEvidence),
      selectedState: observations.some((observation) => observation.status !== "unrealizable")
        ? "not_selected"
        : "selected",
    });
  }
  return observations;
}
