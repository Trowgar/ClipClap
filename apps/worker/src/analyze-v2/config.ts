export type AnalyzeEngineSetting = "legacy" | "recall-critic" | "shadow";

export interface AnalyzeConfig {
  engine: AnalyzeEngineSetting;
  v2Pct: number;
  scanModel: string;
  criticModel: string;
  criticModelFallback: string;
  reasoningEffort: string;
  scoreThreshold: number;
  weakFallbackMinScore: number;
  softCap: number;
  hardMinSec: number;
  targetMinSec: number;
  maxSec: number;
  scanWindowSec: number;
  scanOverlapSec: number;
  criticBatchSize: number;
  criticMaxCandidates: number;
  perWindowMinCandidates: number;
  regionMaxCandidates: number;
  maxConcurrency: number;
  maxStartExpansionSec: number;
  gapSentence: number;
  gapPhrase: number;
  nodeMaxSec: number;
  leadInSec: number;
  tailHoldSec: number;
  payoffMaxTailSec: number;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadAnalyzeConfig(env: Env = process.env): AnalyzeConfig {
  const engine = env.ANALYZE_ENGINE;
  return {
    engine:
      engine === "recall-critic" || engine === "shadow" ? engine : "legacy",
    v2Pct: Math.min(100, Math.max(0, num(env, "ANALYZE_V2_PCT", 0))),
    scanModel: env.OPENAI_SCAN_MODEL || "gpt-4o-mini",
    criticModel: env.OPENAI_CRITIC_MODEL || "gpt-5.1",
    criticModelFallback: env.CRITIC_MODEL_FALLBACK || "gpt-5-mini",
    reasoningEffort: env.SELECTION_REASONING_EFFORT || "low",
    scoreThreshold: num(env, "CLIP_SCORE_THRESHOLD", 0.6),
    weakFallbackMinScore: num(env, "WEAK_FALLBACK_MIN_SCORE", 0.35),
    softCap: num(env, "CLIP_SOFT_CAP", 12),
    hardMinSec: num(env, "CLIP_HARD_MIN_SEC", 6),
    targetMinSec: num(env, "CLIP_TARGET_MIN_SEC", 8),
    maxSec: num(env, "CLIP_MAX_SEC", 90),
    scanWindowSec: num(env, "SCAN_WINDOW_SEC", 600),
    scanOverlapSec: num(env, "SCAN_OVERLAP_SEC", 90),
    criticBatchSize: num(env, "CRITIC_BATCH_SIZE", 6),
    criticMaxCandidates: num(env, "CRITIC_MAX_CANDIDATES", 40),
    perWindowMinCandidates: num(env, "PER_WINDOW_MIN_CANDIDATES", 2),
    regionMaxCandidates: num(env, "REGION_MAX_CANDIDATES", 6),
    maxConcurrency: num(env, "ANALYZE_MAX_CONCURRENCY", 5),
    maxStartExpansionSec: num(env, "MAX_START_EXPANSION_SEC", 3),
    gapSentence: num(env, "GAP_SENTENCE", 0.6),
    gapPhrase: num(env, "GAP_PHRASE", 0.3),
    nodeMaxSec: num(env, "NODE_MAX_SEC", 12),
    leadInSec: num(env, "LEAD_IN_SEC", 0.15),
    tailHoldSec: num(env, "TAIL_HOLD_SEC", 0.3),
    payoffMaxTailSec: num(env, "PAYOFF_MAX_TAIL_SEC", 4),
  };
}
