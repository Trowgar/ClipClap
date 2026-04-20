import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { unlink } from "fs/promises";
import OpenAI from "openai";
import type { TranscriptionResult, WhisperSegment } from "@clipfast/shared";

const execFileAsync = promisify(execFile);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeVideo(
  videoPath: string
): Promise<TranscriptionResult> {
  // Extract audio with ffmpeg
  const audioPath = join(tmpdir(), `clipfast-audio-${randomUUID()}.wav`);

  await execFileAsync("ffmpeg", [
    "-i",
    videoPath,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    audioPath,
    "-y",
  ]);

  try {
    // Send to Whisper API with verbose_json for segments
    const response = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });

    const segments: WhisperSegment[] = (
      (response as unknown as Record<string, unknown>).segments as Array<{
        start: number;
        end: number;
        text: string;
      }>
    ).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));

    return {
      text: response.text,
      segments,
    };
  } finally {
    await unlink(audioPath).catch(() => {});
  }
}
