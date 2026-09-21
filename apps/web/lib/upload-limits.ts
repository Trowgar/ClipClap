export function getUploadLimit(durationSec: number | null, remainingSec: number, maxSec: number) {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (Math.round(durationSec) > maxSec) return "TOO_LONG";
  return Math.round(durationSec) > remainingSec ? "QUOTA" : null;
}
