export type ResolvedEngine = "legacy" | "recall-critic" | "shadow";

/** FNV-1a over the jobId - stable across BullMQ retries and deploys. */
export function jobBucket(jobId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < jobId.length; i++) {
    hash ^= jobId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

export function resolveEngine(
  jobId: string,
  cfg: { engine: "legacy" | "recall-critic" | "shadow"; v2Pct: number }
): ResolvedEngine {
  if (cfg.engine === "recall-critic" || cfg.engine === "shadow") return cfg.engine;
  return jobBucket(jobId) < cfg.v2Pct ? "recall-critic" : "legacy";
}
