import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { unlink } from "fs/promises";
import OpenAI from "openai";
import type {
  SubtitleWord,
  TranscriptionResult,
  WhisperSegment,
} from "@clipfast/shared";

const execFileAsync = promisify(execFile);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeVideo(
  videoPath: string
): Promise<TranscriptionResult> {
  const audioPath = join(tmpdir(), `clipfast-audio-${randomUUID()}.mp3`);

  await execFileAsync("ffmpeg", [
    "-i",
    videoPath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-b:a",
    "32k",
    audioPath,
    "-y",
  ]);

  try {
    // Send to Whisper API with verbose_json for segments
    const response = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
    });

    const raw = response as unknown as {
      text: string;
      segments: Array<{ start: number; end: number; text: string }>;
      words?: Array<{ word: string; start: number; end: number }>;
    };

    // Word timings can be missing or unreliable (music, cross-talk); the
    // burn falls back to segment-level cues when a segment has no words.
    const allWords: SubtitleWord[] = (raw.words ?? []).map((w) => ({
      text: w.word.trim(),
      start: w.start,
      end: w.end,
    }));

    const segments: WhisperSegment[] = raw.segments.map((s) => {
      const words = allWords.filter((w) => w.start < s.end && w.end > s.start);
      return {
        start: s.start,
        end: s.end,
        text: s.text.trim(),
        ...(words.length > 0 ? { words } : {}),
      };
    });

    return {
      text: raw.text,
      segments,
    };
  } finally {
    await unlink(audioPath).catch(() => {});
  }
}
