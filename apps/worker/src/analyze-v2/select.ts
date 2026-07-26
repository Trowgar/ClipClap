import type { AnalyzeConfig } from "./config";
import type { SnappedClip } from "./types";

export interface SelectionResult {
  selected: SnappedClip[];
  tier: "strong" | "weak" | "none";
  droppedByNms: number;
}

/** Overlap above this share of the SHORTER clip makes two clips the same
 *  moment for a viewer. */
const NMS_OVERLAP_FRAC = 0.3;

/**
 * The one definition of "these two clips are the same moment".
 *
 * Exported because the finalizer can move a start AFTER this selection ran, and
 * a stage that reshapes a clip behind NMS's back has to be able to ask the same
 * question NMS asks - with the same numbers, not a second copy of them.
 */
export function nmsCollides(
  a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number }
): boolean {
  const overlap = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  if (overlap <= 0) return false;
  const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
  return overlap > shorter * NMS_OVERLAP_FRAC;
}

/** Spec selection flow steps 9-12. Input clips have already passed
 *  eligibility (keep, grounded, selfContained, valid boundaries, valid copy).
 *
 *  `limit` exists for FINALIZE: that stage must see MORE clips than the job
 *  ships, so its drops come out of the surplus instead of out of the user's
 *  clip count. The soft cap is then applied to what survives it. */
export function selectAndOrder(
  clips: SnappedClip[],
  cfg: AnalyzeConfig,
  limit: number = cfg.softCap
): SelectionResult {
  // Deterministic backstop for lone reaction fragments: the critic is TOLD to
  // reject short clips without their target inside, but LLM discipline is not
  // a guarantee - very short clips must beat a raised bar instead.
  const surcharge = (c: SnappedClip) =>
    (c.endSec - c.startSec < cfg.shortClipStrictSec ? cfg.shortClipScoreBonus : 0) +
    (c.endsOnQuestion ? cfg.questionEndScoreBonus : 0);
  const strong = clips.filter(
    (c) => c.verdict.score >= cfg.scoreThreshold + surcharge(c)
  );

  let tier: SelectionResult["tier"];
  let pool: SnappedClip[];
  if (strong.length > 0) {
    tier = "strong";
    pool = strong;
  } else {
    const weak = clips
      .filter((c) => c.verdict.score >= cfg.weakFallbackMinScore + surcharge(c))
      .sort((a, b) => b.verdict.score - a.verdict.score)
      .slice(0, 2)
      .map((c) => ({ ...c, verdict: { ...c.verdict, lowQuality: true } }));
    tier = weak.length > 0 ? "weak" : "none";
    pool = weak;
  }

  // keep-or-drop NMS by score - never trim, never merge after the critic
  const byScore = [...pool].sort(
    (a, b) => b.verdict.score - a.verdict.score || a.startSec - b.startSec
  );
  const kept: SnappedClip[] = [];
  let droppedByNms = 0;
  for (const c of byScore) {
    if (kept.some((k) => nmsCollides(k, c))) {
      droppedByNms += 1;
      continue;
    }
    kept.push(c);
  }

  return { selected: kept.slice(0, limit), tier, droppedByNms };
}
