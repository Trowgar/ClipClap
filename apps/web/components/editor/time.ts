/** 75.4 -> "1:15.40" (m:ss.cc). withCs=false drops centiseconds: "1:15". */
export function formatTimecode(seconds: number, withCs = true): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  if (!withCs) return `${m}:${s.toString().padStart(2, "0")}`;
  const cs = Math.floor((safe * 100) % 100);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}
