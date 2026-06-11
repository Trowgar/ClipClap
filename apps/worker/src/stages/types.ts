import type {
  Highlight,
  SubtitleTrack,
  TranscriptionResult,
} from "@clipfast/shared";

export interface BaseStagePayload {
  jobId: string;
  userId: string;
}

export type DownloadStagePayload = BaseStagePayload;
export type TranscribeStagePayload = BaseStagePayload;
export type AnalyzeStagePayload = BaseStagePayload;
export type FinalizeStagePayload = BaseStagePayload;

export type RenderStagePayload =
  | (BaseStagePayload & { mode: "clips" })
  | (BaseStagePayload & {
      mode: "trim";
      clipId: string;
      originalClipStorageKey: string;
      start: number;
      end: number;
      subtitles: boolean;
      subtitleTrack?: SubtitleTrack;
      /** Clean re-render source: cut [sourceStart, sourceEnd] (source-absolute
       *  seconds) from the job's source artifact instead of re-encoding the
       *  already-subtitled clip file (which would double-burn subtitles). */
      sourceArtifactKey?: string;
      sourceStart?: number;
      sourceEnd?: number;
    });

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function asTranscription(value: unknown): TranscriptionResult {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as TranscriptionResult).text !== "string" ||
    !Array.isArray((value as TranscriptionResult).segments)
  ) {
    throw new Error("Job transcriptJson is missing or invalid");
  }
  return value as TranscriptionResult;
}

export function asHighlights(value: unknown): Highlight[] {
  if (!Array.isArray(value)) {
    throw new Error("Job highlights are missing or invalid");
  }
  return value as Highlight[];
}

export function inferDurationFromSegments(
  transcription: TranscriptionResult
): number {
  const lastEnd = transcription.segments.reduce(
    (max, segment) => Math.max(max, segment.end),
    0
  );
  return Math.ceil(lastEnd);
}
