import type { Job, Clip, User } from "@prisma/client";

export type { Job, Clip, User } from "@prisma/client";
export { Plan, JobStatus } from "@prisma/client";

export interface Highlight {
  start: number;
  end: number;
  title: string;
  reason: string;
}

export interface CreateJobInput {
  userId: string;
  sourceUrl?: string;
  sourceKey?: string;
  originalFilename?: string;
  subtitles?: boolean;
  subtitlePreset?: string;
  sourceDurationSec?: number;
}

export interface TrimClipInput {
  clipId: string;
  userId: string;
  start: number;
  end: number;
  subtitles: boolean;
  subtitlePreset?: string;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: WhisperSegment[];
}

export interface PipelineContext {
  jobId: string;
  userId: string;
  localVideoPath: string;
  transcription?: TranscriptionResult;
  highlights?: Highlight[];
  clipPaths?: string[];
}

export type SubtitlePreset = "tiktok" | "minimal" | "bold";
