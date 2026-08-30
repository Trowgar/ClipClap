import type { Keyframe } from "./types";

export const MIN_RENDER_RAMP_DT = 0.001;

export function formatLayoutTime(n: number): string {
  return n.toFixed(2);
}

export function formatRampTime(n: number): string {
  return n.toFixed(3);
}

export function roundLayoutTime(n: number): number {
  return Number(formatLayoutTime(n));
}

export function roundRampTime(n: number): number {
  return Number(formatRampTime(n));
}

/** Evaluates the flat clipped-ramp expression emitted by filtergraph.rampX. */
export function interpolateRenderedTrajectory(
  keys: Keyframe[],
  t: number
): number {
  if (keys.length === 0) return Number.NaN;
  let x = keys[0].x;
  for (let i = 1; i < keys.length; i++) {
    const previous = keys[i - 1];
    const current = keys[i];
    const delta = current.x - previous.x;
    const rawDuration = Math.max(current.t - previous.t, MIN_RENDER_RAMP_DT);
    const duration = roundRampTime(rawDuration);
    const start = roundRampTime(previous.t);
    const progress = Math.min(1, Math.max(0, (t - start) / duration));
    x += delta * progress;
  }
  return x;
}
