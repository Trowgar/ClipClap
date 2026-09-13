import { nmsCollides } from "./select";
import type { AnalyzeConfig } from "./config";

export type SupplementalRecallVariant =
  | "existing-rubric"
  | "delivered-payoff"
  | "delivered-payoff-medium";

/** The episode lane may follow an audited payoff up to the ordinary clip cap. */
export function supplementalQualityConfig(
  cfg: AnalyzeConfig,
  variant: SupplementalRecallVariant,
): AnalyzeConfig {
  if (variant !== "delivered-payoff-medium") return cfg;
  return {
    ...cfg,
    reasoningEffort: "medium",
    endExtensionWindowSec: Math.max(cfg.endExtensionWindowSec, cfg.maxSec),
  };
}

type ArcAwareRange = {
  start: number;
  end: number;
  _arcFlags?: {
    entry: { ok: boolean };
    exit: { ok: boolean; defect?: string };
    standalone: { ok: boolean };
  };
};

function completeArc(clip: ArcAwareRange): boolean {
  const flags = clip._arcFlags;
  return !!flags && flags.entry.ok && flags.exit.ok && flags.standalone.ok;
}

function setupOnly(clip: ArcAwareRange): boolean {
  return clip._arcFlags?.exit.ok === false &&
    clip._arcFlags.exit.defect === "setup_no_payoff";
}

export function shouldRunSupplementalRecall(
  primary: readonly ArcAwareRange[],
  limit: number,
): boolean {
  return primary.length < limit || primary.some(setupOnly);
}

/** Add independent results, or replace one setup-only teaser with its complete episode. */
export function appendSupplementalClips<T extends ArcAwareRange>(
  primary: readonly T[], supplemental: readonly T[], limit: number,
  missingRanges: readonly { start: number; end: number }[] = []
): T[] {
  const kept = [...primary];
  for (const clip of supplemental) {
    // Critic/repair may widen a nominee that originally avoided the hole.
    if (missingRanges.some(r => clip.start < r.end && clip.end > r.start)) continue;
    const collisions = kept.flatMap((item, index) => nmsCollides(
      { startSec: item.start, endSec: item.end }, { startSec: clip.start, endSec: clip.end }
    ) ? [index] : []);
    if (collisions.length === 0) {
      if (kept.length < limit) kept.push(clip);
      continue;
    }
    if (collisions.length !== 1) continue;
    const index = collisions[0];
    const existing = kept[index];
    if (
      setupOnly(existing) &&
      completeArc(clip) &&
      clip.start <= existing.start &&
      clip.end > existing.end
    ) kept[index] = clip;
  }
  return kept;
}
