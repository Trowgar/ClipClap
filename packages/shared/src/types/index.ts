import type { Job, Clip, User } from "@prisma/client";

export type { Job, Clip, User } from "@prisma/client";
export { Plan, JobStatus } from "@prisma/client";

export type ClipKind =
  | "reaction"
  | "conflict"
  | "insight"
  | "story"
  | "funny"
  | "reveal"
  | "question"
  | "opinion"
  | "other";

export interface Highlight {
  start: number;
  end: number;
  /**
   * Optional inner anchor - the most engaging core of the clip.
   * The boundary machine never cuts inside [hookStart, hookEnd].
   */
  hookStart?: number;
  hookEnd?: number;
  title: string;
  /** V1 only. Optional so V2 highlights and inline trim highlights typecheck. */
  reason?: string;
  /** V2 fields - all optional so V1 JSON keeps parsing. */
  description?: string;
  score?: number;
  payoffAt?: number;
  language?: string;
  lowQuality?: boolean;
  shortMoment?: boolean;
  kind?: string;
}

export interface CreateJobInput {
  userId: string;
  sourceUrl?: string;
  sourceKey?: string;
  originalFilename?: string;
  subtitles?: boolean;
  sourceDurationSec?: number;
}

export interface EditClipInput {
  clipId: string;
  userId: string;
  /** Source-absolute seconds (same timeline as Clip.startTime/endTime). */
  start: number;
  end: number;
  subtitles: boolean;
  /** Cues relative to the original clip file; omitted = keep the stored track. */
  subtitleTrack?: SubtitleTrack;
}

export interface SubtitleWord {
  text: string;
  start: number; // seconds, relative to the same timeline as the owning segment/cue
  end: number;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  words?: SubtitleWord[];
}

/** Editor working format. Cue times are seconds relative to the clip file (0 = clip start). */
export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
  words?: SubtitleWord[];
}

export interface SubtitleTrack {
  cues: SubtitleCue[];
}

export interface TranscriptionResult {
  text: string;
  segments: WhisperSegment[];
  /** ISO-639-1 only (never a raw Whisper name); null/undefined if unmapped. */
  language?: string;
  /** Whisper's raw language name, verbatim (e.g. "russian"). */
  languageRaw?: string;
  /** Source ranges Whisper never heard (failed chunks). Candidates must not cross these. */
  missingRanges?: Array<{ start: number; end: number; reason: string }>;
}

export interface PipelineContext {
  jobId: string;
  userId: string;
  localVideoPath: string;
  transcription?: TranscriptionResult;
  highlights?: Highlight[];
  clipPaths?: string[];
}
