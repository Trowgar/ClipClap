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
  /** Clips shorter than this pay a score surcharge - lone reaction fragments
   *  ("этот контент - экстремизм", 7s) need to EARN their brevity. */
  shortClipStrictSec: number;
  shortClipScoreBonus: number;
  /** Clips ENDING on a question pay this surcharge - a dropped "so is it
   *  true?" with no answer inside is an unfinished clip, not a cliffhanger. */
  questionEndScoreBonus: number;
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
  /** How far into a video an intro trailer montage may reach. Bounds the region
   *  scan in analyze-v2/teaser.ts; 0 switches montage detection off entirely,
   *  which is the kill switch. (spec 2026-07-24 §4.1) */
  teaserWindowSec: number;
  /** How many opening sentences must reproduce distant speech before the
   *  opening counts as a trailer montage. Measured on both eval fixtures
   *  (2026-07-25) and derived from the gap between two distributions rather
   *  than tuned: over 1623 later offsets the most clustered recurrences
   *  ordinary conversation produced is 2, a constructed legitimate cold open
   *  produces 1, and the real montage produces 11 (6 with half the montage, 3-4
   *  under adversarial jitter). 3 is the smallest integer strictly above
   *  everything ordinary speech produced and the largest that still catches the
   *  degraded cases. NOTE this replaced TEASER_RECURRENCE_FRAC on 2026-07-25 -
   *  the units are hit COUNTS now, not a similarity share, and a value tuned
   *  against the old metric does not transfer. */
  teaserMinHits: number;
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
    shortClipStrictSec: num(env, "SHORT_CLIP_STRICT_SEC", 12),
    shortClipScoreBonus: num(env, "SHORT_CLIP_SCORE_BONUS", 0.15),
    questionEndScoreBonus: num(env, "QUESTION_END_SCORE_BONUS", 0.15),
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
    maxStartExpansionSec: num(env, "MAX_START_EXPANSION_SEC", 6),
    gapSentence: num(env, "GAP_SENTENCE", 0.6),
    gapPhrase: num(env, "GAP_PHRASE", 0.3),
    nodeMaxSec: num(env, "NODE_MAX_SEC", 12),
    leadInSec: num(env, "LEAD_IN_SEC", 0.15),
    tailHoldSec: num(env, "TAIL_HOLD_SEC", 0.3),
    payoffMaxTailSec: num(env, "PAYOFF_MAX_TAIL_SEC", 4),
    teaserWindowSec: num(env, "TEASER_WINDOW_SEC", 120),
    teaserMinHits: num(env, "TEASER_MIN_HITS", 3),
  };
}
