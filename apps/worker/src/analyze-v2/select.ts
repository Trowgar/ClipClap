import type { AnalyzeConfig } from "./config";
import type { SnappedClip } from "./types";

export interface SelectionResult {
  selected: SnappedClip[];
  tier: "strong" | "weak" | "none";
  droppedByNms: number;
}

/** Spec selection flow steps 9-12. Input clips have already passed
 *  eligibility (keep, grounded, selfContained, valid boundaries, valid copy). */
export function selectAndOrder(
  clips: SnappedClip[],
  cfg: AnalyzeConfig
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
    const collides = kept.some((k) => {
      const overlap = Math.min(k.endSec, c.endSec) - Math.max(k.startSec, c.startSec);
      if (overlap <= 0) return false;
      const shorter = Math.min(k.endSec - k.startSec, c.endSec - c.startSec);
      return overlap > shorter * 0.3;
    });
    if (collides) {
      droppedByNms += 1;
      continue;
    }
    kept.push(c);
  }

  return { selected: kept.slice(0, cfg.softCap), tier, droppedByNms };
}
