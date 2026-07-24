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

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
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
