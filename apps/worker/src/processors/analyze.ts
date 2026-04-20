import OpenAI from "openai";
import type { Highlight, TranscriptionResult } from "@clipfast/shared";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a video content analyst. Given a transcript with timestamps, identify the most engaging, funny, insightful, or viral-worthy moments for short-form content (TikTok, Reels, Shorts).

Rules:
- Find 3-5 best moments
- Each clip should be 30-90 seconds long
- Prefer moments with strong hooks (questions, surprises, emotional peaks)
- Avoid mid-sentence cuts — start and end at natural breaks
- Return ONLY valid JSON, no markdown

Output format:
[
  {
    "start": 12.5,
    "end": 55.2,
    "title": "Short catchy title for the clip",
    "reason": "Why this moment is engaging"
  }
]`;

export async function analyzeHighlights(
  transcription: TranscriptionResult
): Promise<Highlight[]> {
  // Format transcript with timestamps for the LLM
  const formattedTranscript = transcription.segments
    .map((s) => `[${formatTime(s.start)} - ${formatTime(s.end)}] ${s.text}`)
    .join("\n");

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_HIGHLIGHTS_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Analyze this transcript and find the best moments:\n\n${formattedTranscript}`,
      },
    ],
    temperature: 0.7,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from LLM");

  const parsed = JSON.parse(content);

  // Handle both {highlights: [...]} and [...] formats
  const highlights: Highlight[] = Array.isArray(parsed)
    ? parsed
    : parsed.highlights || parsed.moments || parsed.clips || [];

  if (highlights.length === 0) {
    throw new Error("No highlights found in the video");
  }

  // Validate and clean
  return highlights.map((h) => ({
    start: Number(h.start),
    end: Number(h.end),
    title: String(h.title),
    reason: String(h.reason),
  }));
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
