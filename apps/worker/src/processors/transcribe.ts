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
import { transcriptionModel } from "../model-selection";

import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
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
  /** Per-second mean RMS in dB of the whole extracted audio, or [] if the
   *  astats pass failed (see rmsEnvelope). Consumed by the music-shorts
   *  hook selector (spec 2026-08-23-music-shorts). */
  energyEnvelope: number[];
  /** Per-second mean luma (0-255) of the source VIDEO, or [] if the
   *  signalstats pass failed or the source has no video stream (see
   *  lumaEnvelope). Consumed by the music-shorts hook selector to steer
   *  hook windows off sustained-black stretches (spec 2026-08-23-music-
   *  shorts, task R2). */
  lumaEnvelope: number[];
  /** Per-second mean frame-to-frame luma difference of the source VIDEO. */
  motionEnvelope: number[];
}

export interface VideoEnvelopes {
  lumaEnvelope: number[];
  motionEnvelope: number[];
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
    ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });

    const bytes = statSync(audioPath).size;
    const durationSec = await probeDurationSec(audioPath);
    // One ffmpeg pass over the whole extracted audio, started here so it runs
    // parallel to whisper on both paths below. rmsEnvelope never rejects - a
    // failed pass must not fail transcription (see its own comment).
    // videoEnvelopes runs against the ORIGINAL video path, not audioPath (no
    // video stream survives extraction) - started here, alongside
    // envelopePromise, so both run in parallel with whisper on both paths
    // below. Never rejects, same discipline as rmsEnvelope. Luma and motion
    // are captured by this one video pass.
    const videoEnvelopesPromise = videoEnvelopes(videoPath);
    const envelopePromise = rmsEnvelope(audioPath);

    if (bytes <= CHUNK_BYTES_THRESHOLD && durationSec <= CHUNK_DURATION_THRESHOLD_SEC) {
      const [raw, energyEnvelope, videoEnv] = await Promise.all([
        whisperCall(audioPath, undefined),
        envelopePromise,
        videoEnvelopesPromise,
      ]);
      return {
        transcription: toTranscription(raw, 0),
        coverage: 1,
        partial: false,
        missingRanges: [],
        energyEnvelope,
        lumaEnvelope: videoEnv.lumaEnvelope,
        motionEnvelope: videoEnv.motionEnvelope,
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
          ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
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
      energyEnvelope: await envelopePromise,
      lumaEnvelope: (await videoEnvelopesPromise).lumaEnvelope,
      motionEnvelope: (await videoEnvelopesPromise).motionEnvelope,
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
  ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
  return Number(stdout.trim()) || 0;
}

/**
 * Per-second mean RMS energy (dB) of the whole audio, via ffmpeg astats.
 * Feeds the music-shorts hook selector (spec 2026-08-23-music-shorts), which
 * needs an energy envelope at ANALYZE time when no media file exists on that
 * container - this is computed once here, at TRANSCRIBE, from the same
 * extracted audio whisper already gets.
 *
 * ffmpeg's ametadata print lands the metadata on STDERR, one pair of lines
 * per audio FRAME (~43/s, not per second): a "pts_time:<seconds>" line
 * followed by the "RMS_level=<value>" line for that frame. Bucket by
 * int(pts_time) and average within each bucket - not the raw frame index,
 * which would silently stretch or compress the envelope's time axis.
 * "-inf" (true digital silence) maps to -90dB.
 *
 * Never rejects: an astats failure (bad input, maxBuffer overrun on a very
 * long source, ffmpeg missing) must not fail transcription. The consumer
 * treats [] as "no energy signal".
 */
export async function rmsEnvelope(audioPath: string): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-nostdin", "-i", audioPath,
      "-af", "astats=metadata=1:reset=1:length=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-f", "null", "-",
    ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
    return bucketRmsBySecond(stderr ?? "");
  } catch (error) {
    console.warn("rmsEnvelope: astats pass failed, continuing without an energy signal:", error);
    return [];
  }
}

function bucketRmsBySecond(stderr: string): number[] {
  const buckets = new Map<number, number[]>();
  let sec: number | null = null;
  for (const line of stderr.split("\n")) {
    const ptsMatch = line.match(/pts_time:([\d.]+)/);
    if (ptsMatch) {
      sec = Math.trunc(Number(ptsMatch[1]));
      continue;
    }
    const rmsMatch = line.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (rmsMatch && sec !== null) {
      const value = rmsMatch[1] === "-inf" ? -90 : Number(rmsMatch[1]);
      const bucket = buckets.get(sec);
      if (bucket) bucket.push(value);
      else buckets.set(sec, [value]);
    }
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((key) => {
    const values = buckets.get(key)!;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.round(mean * 10) / 10;
  });
}

/**
 * Per-second mean luma and luma difference (0-255) of the source VIDEO, via
 * one ffmpeg signalstats pass.
 * Feeds the music-shorts hook selector's dark-stretch avoidance (spec
 * 2026-08-23-music-shorts, task R2): the shipped Believer hook window
 * (53-77s) was measured to contain a ~4s near-black MV transition - a
 * music short opening on or holding through sustained black is a
 * scroll-away, so the selector needs a per-second brightness signal to
 * steer around it. This has to be captured HERE, at TRANSCRIBE, on the
 * VIDEO file: by the time ANALYZE runs there is no media file on that
 * container at all, only the transcript.
 *
 * Run on `videoPath` itself, not the extracted audio: an audio-only source
 * (the corpus's .m4a case) has no video stream, so ffmpeg's `-vf` has
 * nothing to apply it to and the pass simply emits no signalstats lines at
 * all (confirmed against a real .m4a fixture - ffmpeg exits 0, not
 * non-zero, in that case) - the video envelope parser then naturally returns
 * empty arrays
 * from empty input, same end state as the try/catch below reaching for a
 * source ffmpeg can't open at all.
 *
 * Output parsing mirrors rmsEnvelope/bucketRmsBySecond exactly: ffmpeg's
 * metadata=print filter writes one "pts_time:<seconds>" line followed by
 * one "lavfi.signalstats.YAVG=<value>" and one
 * "lavfi.signalstats.YDIF=<value>" line per frame, on STDERR. At
 * fps=1 each frame IS one second, but this still buckets by
 * int(pts_time) rather than trusting frame index 1:1 - the same
 * defensive reasoning as rmsEnvelope, for free, and it means a source
 * whose fps=1 pass drops/duplicates a frame degrades gracefully instead
 * of silently shifting the whole envelope's time axis.
 *
 * Never rejects: a signalstats failure (bad input, maxBuffer overrun,
 * ffmpeg missing) must not fail transcription. The consumer
 * (analyze-v2/music-hook.ts) treats [] as "no luma signal, do not shift or
 * guard windows"; the motion consumer applies the same fallback.
 */
export async function videoEnvelopes(videoPath: string): Promise<VideoEnvelopes> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-nostdin", "-i", videoPath,
      "-vf", "fps=1,signalstats,metadata=print",
      "-f", "null", "-",
    ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
    return bucketVideoEnvelopesBySecond(stderr ?? "");
  } catch (error) {
    console.warn("videoEnvelopes: signalstats pass failed, continuing without visual signals:", error);
    return { lumaEnvelope: [], motionEnvelope: [] };
  }
}

export async function lumaEnvelope(videoPath: string): Promise<number[]> {
  return (await videoEnvelopes(videoPath)).lumaEnvelope;
}

export function bucketVideoEnvelopesBySecond(stderr: string): VideoEnvelopes {
  const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const lumaBuckets = new Map<number, number[]>();
  const motionBuckets = new Map<number, number[]>();
  let sec: number | null = null;
  let invalidInput = false;
  for (const line of stderr.split("\n")) {
    const ptsToken = line.match(/pts_time:([^\s]+)/);
    if (ptsToken) {
      const pts = Number(ptsToken[1]);
      if (!numberToken.test(ptsToken[1]) || !Number.isFinite(pts) || pts < 0) {
        invalidInput = true;
        sec = null;
        continue;
      }
      sec = Math.trunc(pts);
      continue;
    }

    const yavgToken = line.match(/lavfi\.signalstats\.YAVG=([^\s]+)/);
    if (yavgToken) {
      const value = Number(yavgToken[1]);
      if (sec === null || !numberToken.test(yavgToken[1]) || !Number.isFinite(value)) {
        invalidInput = true;
        continue;
      }
      const bucket = lumaBuckets.get(sec);
      if (bucket) bucket.push(value);
      else lumaBuckets.set(sec, [value]);
      continue;
    }

    const ydifToken = line.match(/lavfi\.signalstats\.YDIF=([^\s]+)/);
    if (ydifToken) {
      const value = Number(ydifToken[1]);
      if (sec === null || !numberToken.test(ydifToken[1]) || !Number.isFinite(value)) {
        invalidInput = true;
        continue;
      }
      const bucket = motionBuckets.get(sec);
      if (bucket) bucket.push(value);
      else motionBuckets.set(sec, [value]);
    }
  }

  const seconds = [...new Set([
    ...lumaBuckets.keys(),
    ...motionBuckets.keys(),
  ])].sort((a, b) => a - b);
  if (invalidInput || seconds.length === 0 || seconds[0] !== 0) {
    return { lumaEnvelope: [], motionEnvelope: [] };
  }
  const maxSecond = seconds[seconds.length - 1];
  for (let second = 0; second <= maxSecond; second++) {
    const luma = lumaBuckets.get(second);
    const motion = motionBuckets.get(second);
    if (!luma || !motion || luma.some((value) => !Number.isFinite(value)) ||
      motion.some((value) => !Number.isFinite(value))) {
      return { lumaEnvelope: [], motionEnvelope: [] };
    }
  }

  const roundBuckets = (buckets: Map<number, number[]>) =>
    seconds.map((key) => {
      const values = buckets.get(key)!;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.round(mean * 10) / 10;
    });
  return {
    lumaEnvelope: roundBuckets(lumaBuckets),
    motionEnvelope: roundBuckets(motionBuckets),
  };
}

async function runSilenceDetect(audioPath: string): Promise<string> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-i", audioPath, "-af", "silencedetect=noise=-30dB:d=0.3",
      "-f", "null", "-",
    ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
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
  ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
  try {
    const raw = await whisperCall(probePath, undefined);
    if (!raw.language) return null;
    return { iso: whisperLanguageToIso(raw.language), raw: raw.language };
  } catch {
    return null; // probe failure is not fatal - chunks auto-detect
  }
}
