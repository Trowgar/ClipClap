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
  /** A silent hole this long or longer between consecutive nodes is a cut to a
   *  different scene, and nothing may be extended across one. Measured on all
   *  four eval fixtures 2026-08-04, not guessed: 5 is the smallest integer that
   *  leaves both podcast fixtures at ZERO boundaries. The derivation, the reason
   *  the gap is measured between nodes of ANY kind, and what this guard cannot
   *  see are all in analyze-v2/scene-gaps.ts - re-measure there before moving
   *  this, and keep that doc the single copy. */
  sceneGapSec: number;
  /** Master switch for the end-extension stage - the pass that may move a
   *  clip's end FORWARD to a later beat. Off until measured: it is the only
   *  stage that lets a model move a shipped boundary, so it ships dark and is
   *  turned on per-job once the eval numbers justify it. */
  endExtensionEnabled: boolean;
  /** How far past the current end the stage may look, in seconds. Bounds both
   *  what the model is SHOWN and what it is allowed to choose, so it is the one
   *  number deciding how much foreign material a proposal can reach.
   *  25 is a starting value, not a measurement. What IS measured (spec
   *  2026-08-04 §3.2): of six clips three human-proxy reviewers read in full,
   *  five ended early - the four the spec puts numbers on by 17, 24, 27 and 55
   *  seconds - so a window under ~17s cannot reach the ends that were wrong.
   *  The far end of that range is out of reach on purpose: maxSec still caps the
   *  clip, and a 55s reach on one model call is more trust than this stage has
   *  earned. Re-measure with eval-end-audit.ts before moving it. */
  endExtensionWindowSec: number;
  /** Master switch for the arc-audit stage (spec 2026-08-10) - the per-clip
   *  ENTRY/EXIT/STANDALONE detector that runs after selectAndOrder and before
   *  extendClipEnds. Off until measured, the same discipline as
   *  endExtensionEnabled: this task ships it as flags and telemetry only, with
   *  ZERO boundary moves, so a dark run must be indistinguishable from today. */
  arcAuditEnabled: boolean;
  /** Clips per arc-audit call. Small on purpose - the design's whole argument
   *  is that the finalizer's failure mode is thin attention across many clips
   *  and many rules, so this stage asks three questions about a handful of
   *  clips at a time. */
  arcAuditBatchSize: number;
  /** Master switch for the start-extension stage (spec 2026-08-10 task 3) - the
   *  widen-only, backward-only mover fed EXCLUSIVELY by arcAudit's gated
   *  `entry.fixStartNode` pointers. SEPARATE from arcAuditEnabled on purpose:
   *  detection can ship (flags and telemetry only) without repair, so the two
   *  flags are independent doors and the stage no-ops unless BOTH are on - see
   *  start-extension.ts's own top-of-function guard, which checks both rather
   *  than trusting an empty flags map to make the dependency true by accident.
   *  Off until measured, the same discipline as endExtensionEnabled and
   *  arcAuditEnabled. */
  startExtensionEnabled: boolean;
  /** How far BACKWARD (in seconds, converted through node START times) a
   *  gated `entry.fix_start_node` pointer may reach - the mirror of
   *  endExtensionWindowSec, which already bounds the FORWARD `exit.fix_end_node`
   *  pointer this stage also emits. 20 is a starting value, not a measurement
   *  (spec 2026-08-10 §2c: "measured in task 3"). Deliberately NOT a variant
   *  key - a tuning door, the same refusal as endExtensionWindowSec. */
  startExtensionWindowSec: number;
  /** Master switch for the HINT-DRIVEN half of end-extension (spec 2026-08-10
   *  task 4) - separate from `endExtensionEnabled`, which is the SELF-MOTIVATED
   *  path (every clip with a window offered cold, no audit involved) and stays
   *  net negative on compilation reels (engine-notes §3). This flag instead adds
   *  clips to the offered set because arcAudit's gated `exit.fixEndNode` named a
   *  completing line, and renders that pointer as a labeled note in the clip's
   *  prompt block - the model still decides and may still answer `extend: false`.
   *  Independently switchable from `endExtensionEnabled` on purpose: the
   *  compilation-reel harm was measured on the SELF-MOTIVATED path, and the
   *  audit-hinted path is the thing being tested as its separable replacement,
   *  so one must be able to ship without the other. No-ops without
   *  `arcAuditEnabled` too (end-extension.ts checks both, the same doubling
   *  start-extension.ts uses for its own dependency on the audit). Off until
   *  measured, the same discipline as every other stage switch in this file. */
  endExtensionHintsEnabled: boolean;
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
  /** FINALIZE: one judge over the whole shipped set (spec 2026-07-24 §4.3).
   *  `off` skips the LLM call only - hook dedup and every other deterministic
   *  layer still run, so the kill switch degrades quality without reverting
   *  the code half of the pair. */
  finalizerEnabled: boolean;
  /** Defaults to the critic model: the finalizer is a harder evaluative task
   *  than the critic's (cross-clip, full speech, veto authority) and runs ONCE
   *  per job, so it is the cheapest place in the engine to buy judgement. */
  finalizerModel: string;
  /** Extra clips selection hands the finalizer above softCap, so its drops are
   *  absorbed by the surplus instead of thinning the shipped set. */
  finalizerHeadroom: number;
  /** Jaccard floor for the deterministic opening-line dedup pass. */
  hookDedupSimilarity: number;
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
    criticModel: env.OPENAI_CRITIC_MODEL || "gpt-5.6-luna",
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
    sceneGapSec: num(env, "SCENE_GAP_SEC", 5),
    // Exact literal "on", the same discipline as REFRAME_STREAM: a stage that
    // moves boundaries must not be switched on by a stray truthy value.
    endExtensionEnabled: env.END_EXTENSION === "on",
    endExtensionWindowSec: num(env, "END_EXTENSION_WINDOW_SEC", 25),
    // Exact literal "on", same discipline as END_EXTENSION/REFRAME_STREAM: a
    // stage whose flags this task publishes must not arm itself off a stray
    // truthy env value.
    arcAuditEnabled: env.ARC_AUDIT === "on",
    arcAuditBatchSize: num(env, "ARC_AUDIT_BATCH_SIZE", 4),
    // Exact literal "on", same discipline as ARC_AUDIT/END_EXTENSION/REFRAME_
    // STREAM: a stage that moves a shipped boundary must not arm itself off a
    // stray truthy env value.
    startExtensionEnabled: env.START_EXTENSION === "on",
    startExtensionWindowSec: num(env, "START_EXTENSION_WINDOW_SEC", 20),
    // Exact literal "on", same discipline as every other stage switch in this
    // file: a stray truthy env value must not arm a stage that renders an
    // arc-audit pointer into a prompt a real user's job will read.
    endExtensionHintsEnabled: env.END_EXTENSION_HINTS === "on",
    teaserWindowSec: num(env, "TEASER_WINDOW_SEC", 120),
    teaserMinHits: num(env, "TEASER_MIN_HITS", 3),
    finalizerEnabled: env.ANALYZE_FINALIZER !== "off",
    finalizerModel:
      env.OPENAI_FINALIZER_MODEL || env.OPENAI_CRITIC_MODEL || "gpt-5.6-luna",
    finalizerHeadroom: num(env, "FINALIZER_HEADROOM", 4),
    hookDedupSimilarity: num(env, "HOOK_DEDUP_SIMILARITY", 0.8),
  };
}
