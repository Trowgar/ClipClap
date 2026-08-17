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
  /** Which node spans buildScanWindows may count toward the per-window budget
   *  (spec 2026-08-11 "Scan recall remedy", engine-notes §6a/§3). "speech" -
   *  the default, and BYTE-IDENTICAL to every behavior this repo had before
   *  this knob existed, proven by the eval-snapshot suite rather than merely
   *  asserted - counts word-bearing node spans only, same as today. "source"
   *  counts EVERY node's span, opaque included - the same definition
   *  candidates.ts's `sourceSeconds()` already uses for the critic budget.
   *  §3 measured `speechSec` at roughly half of `sourceSec` on real material
   *  (opaque nodes - material the scanner and critic both still read - are
   *  ~36% of a 52-minute episode), so a `scanWindowSec` of 600 "speech"
   *  seconds was actually rendering ~1130s of transcript per window, halving
   *  both window count and the scanner's own per-window candidate ceiling.
   *  Exact-literal "source" switches; anything else (unset, "speech", a typo)
   *  is "speech" - the same discipline as every other stage switch in this
   *  file, because this one silently doubles the scanner's candidate pool and
   *  critic spend if it fires by accident (spec's own "what it costs"
   *  section). NOT in VariantOverrides - it changes what the scanner is
   *  asked, which the variant whitelist's own doc comment forbids; its
   *  measurement path is `eval-scan-probe.ts`, not a variant. */
  scanWindowBudget: "speech" | "source";
  /** How many times `runScanner` asks the SAME window the SAME prompt (spec
   *  2026-08-11 "Scan recall remedy", Phase B - "the 2x scan union"). Default
   *  1, today's behavior byte for byte: the Phase A probe measured a THIRD
   *  lottery alongside the critic's and finalizer's - one temperature-0.4
   *  scanner sample misses a moment another sample finds - and this is the
   *  remedy: union N independent draws per window before `mergeCandidates`
   *  (which already dedupes overlaps), diversity coming from sampling at a
   *  fixed temperature, not from varying the prompt.
   *
   *  RECORD FOOT-GUN, read before ever setting this above 1 anywhere near a
   *  fixture: the replay client keys a recording by sha256(model, system,
   *  user) only. Two passes at passes>1 send the IDENTICAL request, so they
   *  share ONE key - a recording captures one answer and REPLAYS it to both
   *  passes, and the union of two copies of the same answer is just that one
   *  answer wearing a union's clothes. A fixture "recorded" at passes>1 is a
   *  lie by construction: it would replay green while proving nothing about
   *  what a second real sample would have found. That is why `scanPasses`
   *  lives in the eval-fingerprint (`EngineFingerprint.scanPasses`) rather
   *  than trusting the request hash to notice - the hash CANNOT notice this
   *  one, the same silent-match shape `scanWindowBudget`'s own fingerprint
   *  entry documents. It is measured live only, via
   *  `scripts/eval-scan-probe.ts --passes N` (no recording, no replay,
   *  real API calls the operator runs and pays for).
   *
   *  NOT in VariantOverrides, for the same reason `scanWindowBudget` is not:
   *  it changes what the scanner is asked (how many times), which the variant
   *  whitelist's own doc comment forbids. Garbage, zero or negative all fall
   *  back to 1 - the same discipline as every numeric knob in this file,
   *  sharpened here because a value below 1 would silently skip scanning
   *  windows outright rather than merely mis-tuning a rate. */
  scanPasses: number;
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
  /** Master switch for the long-clip exception (spec 2026-08-10 §2e, task 5) -
   *  the owner's two conditions in code: a clip over `maxSec` ships only as an
   *  EXPLICIT finalizer decision, and only on material arcAudit judged clean
   *  on all three axes. Off until measured, the same discipline as every other
   *  stage switch in this file. With ARC_AUDIT off nothing can ever be
   *  blessed (arc-audit.ts's isFullyOk requires flags that only exist when the
   *  audit ran), so LONG_CLIPS alone degrades to today's unconditional
   *  snap-time compression - the dependency is deliberate, see index.ts. */
  longClipsEnabled: boolean;
  /** Ceiling for a BLESSED over-length clip, in seconds. Measured 2026-08-11
   *  from the five fixtures' recorded critic answers (262 distinct verdicts,
   *  186 keep): 16 keep-verdicts span over 90s - min 90 / median 104 / max
   *  130s. 150 covers the whole measured tail with 20s of margin. NOT a
   *  variant key (tuning door, same refusal as endExtensionWindowSec /
   *  startExtensionWindowSec). */
  longClipMaxSec: number;
  /** Master switch for rendering a clip's STANDING `_arcFlags` into the
   *  finalizer's own prompt block as an AUDIT NOTE line (spec 2026-08-10 task
   *  6) - information for the finalizer's EXISTING rules (chiefly rule 5/6,
   *  `broken_opening`, and rule 9), never a new drop authority: the rules,
   *  verbs and gates stay untouched. Off until measured, the same discipline
   *  as every other stage switch in this file. No-ops without
   *  `arcAuditEnabled` too - the same defence-in-depth doubling
   *  endExtensionHintsEnabled/startExtensionEnabled already use for their own
   *  dependency on the audit, checked again where `finalizerUserPrompt` looks
   *  up a clip's flags rather than trusted from an empty map alone. */
  arcFinalizerNotesEnabled: boolean;
  /** Master switch for the unrepairable-flag DOWNRANK stage (spec 2026-08-10
   *  task 7) - the first drop authority the arc audit ever earns. Placed where
   *  the task 5 long-clip policy already sits: after arcAudit and BOTH
   *  extension stages (so `repaired` is final), before finalizeClips. Off
   *  until measured, the same discipline as every other stage switch in this
   *  file. Motivation, measured on 56 clips / 8 users / 4 languages
   *  (engine-notes §5c): audit flag precision 0.97 clears the §5 bar for
   *  downrank authority (>=90% over two more jobs), and crossing STANDING
   *  flags against the architect's verdicts found the separating signal is
   *  the COUNT of standing axes, not any single axis - all 9 SKIP clips carry
   *  >=1 standing flag, 5 of 9 carry >=2, and of 24 POST clips ZERO carry two
   *  or more (2 carry exactly one, both soft cases: an accepted cold-open and
   *  a deliberate withholding that IS the hook). No-ops without
   *  `arcAuditEnabled` too - the same defence-in-depth doubling every audit
   *  consumer in this file uses (no flags = nothing to downrank), checked
   *  again in index.ts rather than trusted from an empty `arcFlags` map
   *  alone. */
  arcDownrankEnabled: boolean;
  /** Score penalty applied when a clip carries TWO OR MORE standing axes
   *  (`ok: false && !repaired`). Default 0.15, sized directly from the
   *  corpus (spec 2026-08-10 task 7, engine-notes §5c): two-flag SKIP scores
   *  in the corpus run 0.62-0.79, so 0.15 puts every two-flag SKIP (max 0.79)
   *  under the 0.6 threshold with margin, while a two-flag POST (none exist
   *  in the corpus) would need a score >= 0.75 to survive it. */
  arcDownrankPenalty2: number;
  /** Score penalty applied when a clip carries EXACTLY ONE standing axis.
   *  Default 0.0 - the corpus explicitly does NOT separate SKIP from POST on
   *  a single flag (2 of 24 POST clips carry exactly one, the same rate as
   *  noise), so this ships inert until a future corpus measures it live. The
   *  knob exists anyway so that measurement can turn it on without a code
   *  change - and because a penalty of exactly 0 is itself the same
   *  "can silence the stage" case `endExtensionWindowSec`/`longClipMaxSec`
   *  document in eval-fingerprint.ts: at the default, every one-flag clip's
   *  effective score equals its recorded score, so a fixture recorded at
   *  this default would replay identically under a materially different
   *  value, which is why both penalties (not just `arcDownrankEnabled`) carry
   *  their own fingerprint key. */
  arcDownrankPenalty1: number;
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
  /** Master switch for the song-lyric source refusal gate (spec 2026-08-10
   *  task 8) - a deterministic, pre-scan check in `stages/analyze.ts` that
   *  resolves a verse-shaped transcript to `NO_USABLE_SPEECH` before the
   *  scanner ever runs, instead of shipping a clip cut from a song's lyrics
   *  (engine-notes §5c: measured on a real outside-user upload). Off until
   *  measured, the same discipline as every other stage switch in this file.
   *  The two thresholds `detectSong` applies are NOT config fields - see
   *  `analyze-v2/song-gate.ts`'s doc comment for why (this task's own
   *  measurement output, not a tuning door). */
  songGateEnabled: boolean;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Like `num`, but rejects anything that is not a positive integer - garbage,
 *  zero, negative and fractional values all fall back rather than parsing
 *  through to a knob that expects a count of API calls. */
function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
    // Exact literal "source", same discipline as every other stage switch in
    // this file: a stray truthy env value must not silently double the
    // scanner's candidate pool and critic spend.
    scanWindowBudget: env.SCAN_WINDOW_BUDGET === "source" ? "source" : "speech",
    scanPasses: positiveInt(env, "SCAN_PASSES", 1),
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
    // Exact literal "on", same discipline as every other stage switch in this
    // file: a stray truthy env value must not let a clip ship over maxSec by
    // accident.
    longClipsEnabled: env.LONG_CLIPS === "on",
    longClipMaxSec: num(env, "LONG_CLIP_MAX_SEC", 150),
    // Exact literal "on", same discipline as every other stage switch in this
    // file: a stray truthy env value must not render an arc-audit finding
    // into the finalizer's prompt for a real user's job.
    arcFinalizerNotesEnabled: env.ARC_AUDIT_FINALIZER_NOTES === "on",
    // Exact literal "on", same discipline as every other stage switch in this
    // file: a stray truthy env value must not give the arc audit drop
    // authority over a real user's clip.
    arcDownrankEnabled: env.ARC_DOWNRANK === "on",
    arcDownrankPenalty2: num(env, "ARC_DOWNRANK_PENALTY_2", 0.15),
    arcDownrankPenalty1: num(env, "ARC_DOWNRANK_PENALTY_1", 0.0),
    teaserWindowSec: num(env, "TEASER_WINDOW_SEC", 120),
    teaserMinHits: num(env, "TEASER_MIN_HITS", 3),
    finalizerEnabled: env.ANALYZE_FINALIZER !== "off",
    finalizerModel:
      env.OPENAI_FINALIZER_MODEL || env.OPENAI_CRITIC_MODEL || "gpt-5.6-luna",
    finalizerHeadroom: num(env, "FINALIZER_HEADROOM", 4),
    hookDedupSimilarity: num(env, "HOOK_DEDUP_SIMILARITY", 0.8),
    // Exact literal "on", same discipline as every other stage switch in this
    // file: a stray truthy env value must not refuse a real user's video.
    songGateEnabled: env.SONG_GATE === "on",
  };
}
