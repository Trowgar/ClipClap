import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createReadStream, statSync } from "fs";
import { unlink } from "fs/promises";
import OpenAI from "openai";
import type {
  SubtitleWord,
  TranscriptionResult,
  WhisperSegment,
} from "@clipclap/shared";
import {
  parseSilences,
  planChunks,
  stitchTranscripts,
  type RawChunkTranscript,
  type SilenceInterval,
} from "./audio-chunks";
import { whisperLanguageToIso } from "../analyze-v2/language";
import { transcriptionModel } from "../models";

const execFileAsync = promisify(execFile);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHUNK_BYTES_THRESHOLD = 24 * 1024 * 1024; // Whisper hard limit is 25MB
const CHUNK_DURATION_THRESHOLD_SEC = 95 * 60;
const SILENCE_SEEK_WINDOW_SEC = 15;
const HARD_CUT_OVERLAP_SEC = 3;
const CHUNK_CONCURRENCY = 3;
const PROBE_SEC = 60;

export interface TranscribeOutcome {
  transcription: TranscriptionResult;
  coverage: number;
  partial: boolean;
  missingRanges: Array<{ start: number; end: number; reason: string }>;
}

interface RawWhisperResponse {
  text: string;
  language?: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

export async function transcribeVideo(
  videoPath: string
): Promise<TranscribeOutcome> {
  const audioPath = join(tmpdir(), `clipclap-audio-${randomUUID()}.mp3`);
  const tempFiles: string[] = [audioPath];

  try {
    await execFileAsync("ffmpeg", [
      "-i", videoPath, "-vn", "-acodec", "libmp3lame",
      "-ar", "16000", "-ac", "1", "-b:a", "32k", audioPath, "-y",
    ]);

    const bytes = statSync(audioPath).size;
    const durationSec = await probeDurationSec(audioPath);

    if (bytes <= CHUNK_BYTES_THRESHOLD && durationSec <= CHUNK_DURATION_THRESHOLD_SEC) {
      const raw = await whisperCall(audioPath, undefined);
      return {
        transcription: toTranscription(raw, 0),
        coverage: 1,
        partial: false,
        missingRanges: [],
      };
    }

    // ---- chunked path (spec §9) ----
    const silences = parseSilences(await runSilenceDetect(audioPath));
    const chunkSec = Number(process.env.WHISPER_CHUNK_SEC) || 1200;
    const plans = planChunks(
      durationSec, silences, chunkSec, SILENCE_SEEK_WINDOW_SEC, HARD_CUT_OVERLAP_SEC
    );

    // language locked from a speech-rich probe of the beginning (spec §8)
    const probed = await probeLanguage(audioPath, silences, tempFiles);

    const rawChunks: RawChunkTranscript[] = [];
    const missingRanges: Array<{ start: number; end: number; reason: string }> = [];

    for (let i = 0; i < plans.length; i += CHUNK_CONCURRENCY) {
      const batch = plans.slice(i, i + CHUNK_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (plan) => {
          const chunkPath = join(tmpdir(), `clipclap-chunk-${randomUUID()}.mp3`);
          tempFiles.push(chunkPath);
          const from = plan.overlapStart ?? plan.start;
          await execFileAsync("ffmpeg", [
            "-ss", String(from), "-to", String(plan.end),
            "-i", audioPath, "-c", "copy", chunkPath, "-y",
          ]);
          let raw: RawWhisperResponse;
          try {
            raw = await whisperCall(chunkPath, probed?.iso ?? undefined);
          } catch {
            raw = await whisperCall(chunkPath, probed?.iso ?? undefined);
          }
          return { raw, from };
        })
      );
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        if (s.status === "fulfilled") {
          rawChunks.push({
            offsetSec: s.value.from,
            text: s.value.raw.text,
            segments: toTranscription(s.value.raw, 0).segments,
          });
        } else {
          missingRanges.push({
            start: batch[j].start,
            end: batch[j].end,
            reason: "chunk_failed",
          });
        }
      }
    }

    const stitched = stitchTranscripts(rawChunks, {
      totalDurationSec: durationSec,
      missingRanges,
    });

    return {
      transcription: {
        text: stitched.text,
        segments: stitched.segments,
        language: probed?.iso ?? undefined,
        languageRaw: probed?.raw,
        // persisted inside transcriptJson so analyze can refuse candidates
        // that would span a hole (spec §9)
        ...(missingRanges.length > 0 ? { missingRanges } : {}),
      },
      coverage: stitched.coverage,
      partial: missingRanges.length > 0,
      missingRanges,
    };
  } finally {
    await Promise.all(tempFiles.map((f) => unlink(f).catch(() => {})));
  }
}

async function whisperCall(
  audioPath: string,
  languageIso: string | undefined
): Promise<RawWhisperResponse> {
  const response = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: transcriptionModel(),
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"],
    ...(languageIso ? { language: languageIso } : {}),
  });
  return response as unknown as RawWhisperResponse;
}

/** Single-call path keeps the old word->segment mapping; also captures language. */
function toTranscription(raw: RawWhisperResponse, offset: number): TranscriptionResult {
  const allWords: SubtitleWord[] = (raw.words ?? []).map((w) => ({
    text: w.word.trim(),
    start: w.start + offset,
    end: w.end + offset,
  }));
  const segments: WhisperSegment[] = raw.segments.map((s) => {
    const start = s.start + offset;
    const end = s.end + offset;
    const words = allWords.filter((w) => w.start < end && w.end > start);
    return {
      start,
      end,
      text: s.text.trim(),
      ...(words.length > 0 ? { words } : {}),
    };
  });
  const iso = raw.language ? whisperLanguageToIso(raw.language) : null;
  return {
    text: raw.text,
    segments,
    language: iso ?? undefined,
    languageRaw: raw.language,
  };
}

async function probeDurationSec(audioPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", audioPath,
  ]);
  return Number(stdout.trim()) || 0;
}

async function runSilenceDetect(audioPath: string): Promise<string> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-i", audioPath, "-af", "silencedetect=noise=-30dB:d=0.3",
      "-f", "null", "-",
    ]);
    return stderr ?? "";
  } catch (error) {
    // ffmpeg exits non-zero on some null-muxer paths; stderr still has the data
    const e = error as { stderr?: string };
    return e.stderr ?? "";
  }
}

/** Speech-rich language probe: first 60s of detected speech, not the first 60s. */
async function probeLanguage(
  audioPath: string,
  silences: SilenceInterval[],
  tempFiles: string[]
): Promise<{ iso: string | null; raw: string } | null> {
  const leading = silences.find((s) => s.start <= 0.5);
  const speechStart = leading ? leading.end : 0;
  const probePath = join(tmpdir(), `clipclap-probe-${randomUUID()}.mp3`);
  tempFiles.push(probePath);
  await execFileAsync("ffmpeg", [
    "-ss", String(speechStart), "-t", String(PROBE_SEC),
    "-i", audioPath, "-c", "copy", probePath, "-y",
  ]);
  try {
    const raw = await whisperCall(probePath, undefined);
    if (!raw.language) return null;
    return { iso: whisperLanguageToIso(raw.language), raw: raw.language };
  } catch {
    return null; // probe failure is not fatal - chunks auto-detect
  }
}
