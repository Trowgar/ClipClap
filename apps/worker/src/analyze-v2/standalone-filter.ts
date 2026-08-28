import { isFullyOk } from "./arc-audit";
import type { ArcFlags, SnappedClip } from "./types";

export interface StandaloneFilterTelemetry {
  considered: number;
  eligible: number;
  dropped: number;
  bypassedNoCleanAlternative: number;
}

export interface StandaloneFilterDrop {
  id: string;
  score: number;
}

export interface StandaloneFilterResult {
  clips: SnappedClip[];
  drops: StandaloneFilterDrop[];
  telemetry: StandaloneFilterTelemetry;
}

export function filterStandaloneClips(
  clips: SnappedClip[],
  arcFlags: ReadonlyMap<string, ArcFlags>,
  scoreThreshold: number,
  penalty: number,
): StandaloneFilterResult {
  const eligible = clips.filter((clip) => {
    const flags = arcFlags.get(clip.verdict.id);
    return !!flags && flags.standalone.ok === false && clip.verdict.score - penalty < scoreThreshold;
  });
  const cleanAlternative = clips.some((clip) => isFullyOk(arcFlags.get(clip.verdict.id)));
  const telemetry = {
    considered: clips.length,
    eligible: eligible.length,
    dropped: cleanAlternative ? eligible.length : 0,
    bypassedNoCleanAlternative: cleanAlternative ? 0 : eligible.length,
  };

  if (!cleanAlternative) {
    return { clips, drops: [], telemetry };
  }

  const eligibleClips = new Set(eligible);
  return {
    clips: clips.filter((clip) => !eligibleClips.has(clip)),
    drops: eligible.map((clip) => ({ id: clip.verdict.id, score: clip.verdict.score })),
    telemetry,
  };
}
