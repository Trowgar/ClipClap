import { nmsCollides } from "./select";

/** Supplemental review cannot reorder or evict any primary result. */
export function appendSupplementalClips<T extends { start: number; end: number }>(
  primary: readonly T[], supplemental: readonly T[], limit: number,
  missingRanges: readonly { start: number; end: number }[] = []
): T[] {
  const kept = [...primary];
  for (const clip of supplemental) {
    if (kept.length >= limit) break;
    // Critic/repair may widen a nominee that originally avoided the hole.
    if (missingRanges.some(r => clip.start < r.end && clip.end > r.start)) continue;
    if (!kept.some(k => nmsCollides(
      { startSec: k.start, endSec: k.end }, { startSec: clip.start, endSec: clip.end }
    ))) kept.push(clip);
  }
  return kept;
}
