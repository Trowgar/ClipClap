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

/** Diagnostic fields persisted inside Job.highlights (v2 shape). */
export type V2Highlight = Highlight & {
  _startNode?: number;
  _endNode?: number;
  _titleEvidenceNodes?: number[];
  _descriptionEvidenceNodes?: number[];
  _grounded?: boolean;
  _boundaryConfidence?: "word" | "segment";
};

export interface V2Result {
  highlights: V2Highlight[];
  noClipsReason?: NoClipsReasonValue;
  telemetry: Record<string, unknown>;
  usage: LlmUsage;
}
