/** Pure 9:16 geometry, in its own module so that `camera.ts` can use it without
 *  importing `plan.ts`, which imports `camera.ts` back. */

export function cropWidthFor(sourceHeight: number): number {
  return 2 * Math.round((sourceHeight * 9) / 16 / 2);
}

export function tileWidthFor(sourceHeight: number): number {
  return 2 * Math.round((sourceHeight * 9) / 8 / 2);
}

export function evenClamp(x: number, cropW: number, sourceWidth: number): number {
  const clamped = Math.min(Math.max(0, x), sourceWidth - cropW);
  return 2 * Math.round(clamped / 2);
}
