import type { Highlight } from "@clipclap/shared";

export interface SentenceNode {
  index: number;
  start: number;
  end: number;
  text: string;
  /** false = opaque: no/unreliable word timings (music, crosstalk). */
  hasWords: boolean;
  /** 0..1 - how strong a boundary the END of this node is. */
  trailingStrength: number;
  /** prev node's trailingStrength; 1.0 for node 0. */
  leadingStrength: number;
}

export interface ScanWindow {
  index: number;
  startNode: number;
  endNode: number; // inclusive
  /** The accumulated budget value that closed this window - word-bearing
   *  seconds only under `cfg.scanWindowBudget === "speech"` (the field's
   *  name and meaning before that knob existed), every node's seconds under
   *  `"source"`. See windows.ts's `nodeBudgetSpan`. */
  speechSec: number;
}

export interface ScanCandidate {
  startNode: number;
  endNode: number;
  payoffNode: number;
  interest: number;
  type: string;
  thread?: string;
  windowIndex: number;
  /** Which of `cfg.scanPasses` identical-prompt calls over this window
   *  produced this candidate (0-indexed) - spec 2026-08-11 "Scan recall
   *  remedy", Phase B. Absent from candidates minted outside `runScanner`
   *  (e.g. index.ts's tiny-transcript path) and always 0 at the default
   *  `scanPasses` of 1, so nothing that predates this field or ignores it
   *  changes behavior. `mergeCandidates` never reads it - it rides along
   *  `{...c}` spreads unexamined, same as `thread` - and it exists for
   *  `scripts/eval-scan-probe.ts`'s per-pass breakdown and the union-order
   *  tests, not for production selection logic. */
  passIndex?: number;
}

/** Closed safe vocabulary retained in candidate audit metadata. */
export const CANDIDATE_TYPES = Object.freeze([
  "reaction",
  "conflict",
  "insight",
  "story",
  "funny",
  "reveal",
  "question",
  "opinion",
  "other",
  "visual_action",
] as const);
export type CandidateType = (typeof CANDIDATE_TYPES)[number];

export function isCandidateType(value: unknown): value is CandidateType {
  return typeof value === "string" && CANDIDATE_TYPES.includes(value as CandidateType);
}

export function isNormalizedCandidateInterest(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export interface MergedCandidate extends ScanCandidate {
  id: string; // "c0", "c1", ...
  threadSetupNode?: number;
}

export interface CriticVerdict {
  id: string;
  keep: boolean;
  score: number;
  grounded: boolean;
  selfContained: boolean;
  startNode: number;
  payoffNode: number;
  endNode: number;
  hookStartNode: number;
  hookEndNode: number;
  title: string;
  description: string;
  titleEvidenceNodes: number[];
  descriptionEvidenceNodes: number[];
  language: string;
  /** Set by degraded paths (critic fallback); flows to Clip.lowQuality. */
  lowQuality?: boolean;
  kind?: string;
}

export interface SnappedClip {
  verdict: CriticVerdict;
  startSec: number;
  endSec: number;
  /** The node range the clip ACTUALLY covers. `verdict.startNode`/`endNode` are
   *  the critic's PROPOSAL; snap owns boundaries and moves them - clean-start
   *  walk-back, payoff containment, clean-end repair, over-length compression -
   *  so the two disagree whenever any of those fired. Everything that asks "is
   *  this node inside the clip" must ask these: the seconds are derived from
   *  them, and the verdict range is what the critic wanted, not what shipped. */
  finalStartNode: number;
  finalEndNode: number;
  hookStartSec: number;
  hookEndSec: number;
  payoffSec: number;
  shortMoment: boolean;
  /** "segment" when an edge rode an opaque node's segment boundary (word
   *  timings unreliable there - e.g. a punchline drowned in laughter). */
  boundaryConfidence?: "word" | "segment";
  /** The clip's final sentence is interrogative - selection charges these a
   *  score surcharge (answer-completeness backstop). */
  endsOnQuestion?: boolean;
  /** Span exceeds `maxSec` but fits `longClipMaxSec`, and `longClipsEnabled`
   *  was on: snapNodes DEFERRED the 5a compression walk instead of running it
   *  (spec 2026-08-10 §2e, task 5). Optional so nothing existing changes
   *  shape - absent, never `false`, on every clip this task does not touch.
   *  index.ts's long-clip policy is what turns this into a shipped decision:
   *  a BLESSED clip (arc-audit.ts's isFullyOk) keeps it and ships wide; every
   *  other clip is compressed via `compressToFit` (clearing the flag) or
   *  dropped. */
  overLength?: boolean;
}

/** How far the end-extension stage may reach for one clip: the highest node
 *  index it may be extended to, and equal to the clip's own end when no
 *  extension is possible. Minted only by extensionWindow, which is where the
 *  three bounds behind it are documented. */
export interface ExtensionWindow {
  lastNode: number;
}

/** Closed set of reasons the FINALIZE judge may drop a shipped clip. Mirrored
 *  in FINALIZER_SCHEMA's enum and explained one-by-one in the finalizer prompt;
 *  finalizer-prompt.test.ts holds those three in sync. */
export type FinalizerDropReason =
  | "duplicate"
  | "unanswered_title"
  | "broken_opening"
  | "no_payoff"
  | "redundant"
  | "teaser_montage"
  | "incoherent";

/** One finalizer verdict, normalized from the model's snake_case row. Every
 *  field here is a PROPOSAL - none of it changes a clip until the code gates in
 *  finalize.ts accept it (spec §4.4). */
export interface FinalizerEntry {
  id: string;
  verdict: "ship" | "drop";
  dropReason: FinalizerDropReason | null;
  duplicateOf: string | null;
  sharedClaim: string | null;
  title: string | null;
  titleEvidenceNodes: number[] | null;
  trimStartNode: number | null;
}

export type DropReason =
  | "no_clean_start"
  | "no_clean_end"
  | "opaque_end"
  | "opaque_payoff"
  | "invariant_violation"
  | "too_short"
  | "too_long";

export type SnapResult =
  | { ok: true; clip: SnappedClip }
  | { ok: false; reason: DropReason };

/** Tokens and calls charged to ONE model id. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

/**
 * What the engine spent, in total AND per model.
 *
 * The totals came first and are kept: every caller and every persisted row reads
 * them, and Job.analysisInputTokens/analysisOutputTokens are exactly these two.
 *
 * `byModel` exists because the totals cannot be priced. A job that degrades to
 * the fallback model spends tokens on TWO models (job cmscht6rp001xq41s5rhjx6q0,
 * 2026-08-03: every critic batch and the finalizer failed on gpt-5.6-luna and was
 * re-run on gpt-5-mini), and the scanner has always run on a third and cheaper
 * one. Pricing the sum at the CONFIGURED critic's rate understated that job by
 * ~48%, and that figure is what settleFreeLedger charges against the free-tier
 * budget. The totals are the sum of the buckets, always - callJsonSchema writes
 * both in one place.
 *
 * A failed attempt appears here as a request with zero tokens: the SDK throws
 * before any usage object exists, so the tokens it really billed are unknowable
 * from our side. Truncated and refused responses DO carry usage and are counted
 * in full, against the model that produced them.
 */
export interface LlmUsage extends ModelUsage {
  byModel: Record<string, ModelUsage>;
}

export type NoClipsReasonValue =
  | "NO_USABLE_SPEECH"
  | "NO_VIABLE_MOMENTS"
  | "PARTIAL_TRANSCRIPT";

/** Closed terminal dispositions for the primary candidate lane. A candidate
 * may receive exactly one of these and that record is immutable. */
export type CandidatePrimaryDisposition =
  | "not_selected_for_critic"
  | "critic_unjudged"
  | "critic_rejected"
  | "evidence_rejected"
  | "snap_rejected"
  | "selection_not_chosen"
  | "arc_rejected"
  | "post_boundary_rejected"
  | "standalone_rejected"
  | "finalizer_rejected"
  | "shipped";

/** Recovery uses the same quality authorities, but has its own immutable lane
 * accounting so recovery never rewrites primary history. */
export type CandidateRecoveryDisposition = Exclude<
  CandidatePrimaryDisposition,
  "not_selected_for_critic"
>;

/** Terminal vocabulary emitted by the shared quality lane. Partitioning is
 * the only stage allowed to say a candidate was not selected for critic. */
export type QualityLaneDisposition = Exclude<
  CandidatePrimaryDisposition,
  "not_selected_for_critic"
>;

/** Backwards-friendly aliases for consumers that refer to the shared closed
 * disposition vocabulary without naming the lane. */
export type CandidateDisposition = CandidatePrimaryDisposition;
export type RecoveryDisposition = CandidateRecoveryDisposition;

/** Closed defect vocabulary for a broken ENTRY, verbatim from the arc-audit
 *  design (spec 2026-08-10 §2a). Mirrored in ARC_AUDIT_SCHEMA's enum. */
export type ArcEntryDefect =
  | "dangling_reference"
  | "mid_story"
  | "borrowed_answer"
  | "meta_opening";

/** Closed defect vocabulary for a broken EXIT, verbatim from the arc-audit
 *  design (spec 2026-08-10 §2a). Mirrored in ARC_AUDIT_SCHEMA's enum. */
export type ArcExitDefect =
  | "mid_thought"
  | "setup_no_payoff"
  | "transition_out"
  | "refuted_after";

/**
 * One clip's arc-audit verdict (spec 2026-08-10 §2a/§2b), published as
 * `V2Highlight._arcFlags` and returned from `runArcAudit` keyed by clip id.
 *
 * `defect`/`fixStartNode`/`fixEndNode`/`missing` are absent, never `null`, when
 * there is nothing to report - the same "absent means nothing happened" rule
 * `ExtensionTelemetry.skipped` documents, so a JSON diff shows exactly the
 * fields a defect actually touched. `fixStartNode`/`fixEndNode` are the
 * GATED pointer only: a pointer the structural gates in arc-audit.ts refused
 * never reaches here, even though `ok` still reports the defect - the flag
 * survives a failed gate, only the pointer is dropped (arc-audit.ts,
 * `ArcAuditTelemetry.gatedOut`).
 *
 * `repaired` (follow-up, 2026-08-11, real job cmsoqmy47008fuhfjosaxi86s): set
 * to `true` on an axis exactly where a widen-only repair for that axis
 * APPLIED - `entry.repaired` by `extendClipStarts`'s success path,
 * `exit.repaired` by `extendClipEnds`'s. It is NOT a second verdict and does
 * NOT overwrite `ok` - `ok` stays the detector's record of what it saw at
 * audit time, `repaired` says the boundary has since moved so that record is
 * stale. Absent, never `false`, exactly like every other optional field here.
 * `standalone` has no `repaired` field: the audit has no drop or repair verb
 * for it (§2b), so nothing can ever apply one. Consumers: `isFullyOk`
 * (arc-audit.ts) deliberately does NOT read this - a repaired axis still
 * blesses nothing, see that function's own comment - and
 * `resolveArcAuditNote`/`composeAuditNote` (prompts.ts) DO read it, so a
 * clip's finalizer AUDIT NOTE only ever names axes still standing.
 */
export interface ArcFlags {
  entry: { ok: boolean; defect?: ArcEntryDefect; fixStartNode?: number; repaired?: true };
  exit: { ok: boolean; defect?: ArcExitDefect; fixEndNode?: number; repaired?: true };
  standalone: { ok: boolean; missing?: string };
}

/** Diagnostic fields persisted inside Job.highlights (v2 shape). */
export type V2Highlight = Highlight & {
  _startNode?: number;
  _endNode?: number;
  _titleEvidenceNodes?: number[];
  _descriptionEvidenceNodes?: number[];
  _grounded?: boolean;
  _boundaryConfidence?: "word" | "segment";
  /** Absent unless arcAuditEnabled and the clip was actually audited - see
   *  ArcFlags. Dark-stage control: this key must not exist when the stage is
   *  off (spec 2026-08-10, task 2). */
  _arcFlags?: ArcFlags;
};

export interface V2Result {
  highlights: V2Highlight[];
  noClipsReason?: NoClipsReasonValue;
  telemetry: Record<string, unknown>;
  usage: LlmUsage;
}
