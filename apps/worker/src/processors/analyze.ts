import OpenAI from "openai";
import type { Highlight, TranscriptionResult } from "@clipfast/shared";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are an expert short-form video editor and viral content analyst for TikTok, Instagram Reels, and YouTube Shorts.

Your task is to analyze a transcript with timestamps and select the best self-contained moments that can become engaging short-form clips.

CRITICAL TIMESTAMP RULE:
- All timestamps are in SECONDS as decimal numbers.
- Input timestamps are already in seconds.
- Output timestamps MUST be raw seconds only.
- NEVER use minute:second notation.
- Example correct: 1516.0
- Example wrong: "25:16"

WHAT MAKES A GOOD CLIP:
A good clip should work even for someone who has NOT watched the full video.

Prioritize moments that contain at least one of these:
- strong emotional reaction
- funny moment
- conflict or disagreement
- surprising statement
- useful insight
- clear story arc
- strong opinion
- dramatic or intense moment
- mistake, fail, rage, clutch, reveal, or unexpected outcome
- a question followed by an interesting answer
- a setup and payoff
- curiosity hook or bait element that makes the viewer want to keep watching

BAIT / HOOK RULE:
Each selected clip should have a strong bait element. This does NOT mean misleading clickbait. It means the clip should create curiosity, tension, or anticipation.

The beginning of the clip should make the viewer think:
- "wait, what happens next?"
- "why did he say that?"
- "how will this end?"
- "this looks funny / intense / unexpected"

Good bait elements include:
- an unfinished thought that makes viewers wait for the answer
- a surprising or controversial statement
- visible confusion, tension, rage, laughter, shock, or excitement
- a clear "what happens next?" setup
- a mistake, challenge, conflict, or unexpected reveal
- a strong reaction before the full context is explained
- a question that promises an interesting answer

Avoid clips where:
- the interesting part only happens at the very end
- the first 3 seconds are boring
- there is no reason to keep watching
- the clip feels like random context without a payoff

The first 3 seconds must give the viewer a reason not to scroll away.

Avoid:
- boring explanations with no payoff
- generic conversation
- greetings, intros, outros, sponsorships
- clips that require too much missing context
- moments that start or end mid-sentence
- clips with weak endings
- multiple clips about the same exact idea
- selecting only informative moments if they are not engaging

CLIP SELECTION RULES:
- Find 3 to 5 best clips.
- Each clip MUST be between 30 and 90 seconds long.
- Prefer 35-65 seconds when possible.
- Start 1-3 seconds before the actual hook if needed for context.
- End after the payoff, punchline, conclusion, or emotional peak.
- Clips should feel complete: hook → build-up → payoff.
- Do not overlap clips unless absolutely necessary.
- Prefer fewer high-quality clips over more weak clips.
- If the transcript has limited good moments, still return the best available moments that satisfy duration rules.

SCORING MINDSET:
Rank clips by short-form potential, not by how important they are in the full video.

Ask yourself:
- Would someone stop scrolling for this?
- Is there a strong hook in the first 3 seconds?
- Does the first 3 seconds create curiosity, tension, or a reason to keep watching?
- Is there a scroll-stopper moment at the beginning?
- Does the clip tease a payoff without giving everything away immediately?
- Does the clip have a clear reason to keep watching?
- Is there a payoff?
- Could this get comments, shares, or saves?

TITLE RULES:
- Titles must be short, catchy, and curiosity-driven.
- Do not use clickbait that misrepresents the clip.
- Maximum 70 characters.
- Good examples:
  - "He Realized the Mistake Too Late"
  - "This Changed the Whole Match"
  - "The Funniest Reaction of the Stream"
  - "Nobody Expected This Answer"

OUTPUT RULES:
- Return ONLY valid JSON.
- No markdown.
- No explanations outside JSON.
- Because JSON object mode is enabled, return an object with a "highlights" array.
- start and end must be numbers, not strings.
- reason should briefly explain why the clip is engaging.

OUTPUT FORMAT:
{
  "highlights": [
    {
      "start": 125.0,
      "end": 180.5,
      "hook_start": 142.0,
      "hook_end": 160.0,
      "title": "Short catchy title",
      "reason": "This moment has a strong hook, curiosity bait, clear build-up, and satisfying payoff."
    }
  ]
}

The "hook_start" and "hook_end" fields mark the inner anchor - the most engaging core of the clip (the punchline, the reaction, the payoff). They MUST satisfy start ≤ hook_start < hook_end ≤ end. They tell the post-processor what part of the clip absolutely cannot be cut, even if the surrounding range is later trimmed or expanded.`;

const MAX_TITLE_LENGTH = 80;
const TARGET_MIN_DURATION_SEC = 30;
const HARD_MAX_DURATION_SEC = 90;
const DROP_BELOW_DURATION_SEC = 15;

export async function analyzeHighlights(
  transcription: TranscriptionResult
): Promise<Highlight[]> {
  // Format transcript with raw second timestamps to avoid M:SS ambiguity
  const formattedTranscript = transcription.segments
    .map(
      (s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`
    )
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
    temperature: 0.2,
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

  // Parse → snap to segment boundaries → expand short clips around hook → drop overlaps
  const cleaned = highlights
    .map((h) => parseHighlight(h))
    .filter((h): h is Highlight => h !== null)
    .map((h) => snapToSegmentBoundaries(h, transcription.segments))
    .map((h) =>
      expandClipToMinDuration(
        h,
        transcription.segments,
        TARGET_MIN_DURATION_SEC,
        HARD_MAX_DURATION_SEC
      )
    )
    .filter(
      (h) =>
        h.end - h.start >= DROP_BELOW_DURATION_SEC &&
        h.end - h.start <= HARD_MAX_DURATION_SEC
    );

  const deduped = dropOverlappingClips(cleaned);

  if (deduped.length === 0) {
    throw new Error(
      `LLM returned no clips with duration ≥ ${DROP_BELOW_DURATION_SEC}s`
    );
  }

  return deduped;
}

function parseHighlight(raw: unknown): Highlight | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const start = Number(r.start);
  const end = Number(r.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  const rawHookStart = Number(r.hook_start ?? r.hookStart);
  const rawHookEnd = Number(r.hook_end ?? r.hookEnd);
  let hookStart: number | undefined;
  let hookEnd: number | undefined;
  if (
    Number.isFinite(rawHookStart) &&
    Number.isFinite(rawHookEnd) &&
    rawHookStart >= start &&
    rawHookEnd <= end &&
    rawHookEnd > rawHookStart
  ) {
    hookStart = rawHookStart;
    hookEnd = rawHookEnd;
  }

  return {
    start,
    end,
    hookStart,
    hookEnd,
    title: truncateTitle(String(r.title ?? "Untitled")),
    reason: String(r.reason ?? ""),
  };
}

function truncateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + "…";
}

function expandClipToMinDuration(
  highlight: Highlight,
  segments: TranscriptionResult["segments"],
  targetMin: number,
  hardMax: number
): Highlight {
  let { start, end } = highlight;
  if (end - start >= targetMin) return highlight;

  const sorted = [...segments].sort((a, b) => a.start - b.start);

  let expanded = true;
  while (expanded && end - start < targetMin) {
    expanded = false;

    const prevSeg = sorted.filter((s) => s.start < start).pop();
    const nextSeg = sorted.find((s) => s.end > end);
    if (!prevSeg && !nextSeg) break;

    const prevAdds = prevSeg ? start - prevSeg.start : Infinity;
    const nextAdds = nextSeg ? nextSeg.end - end : Infinity;

    if (nextSeg && nextAdds <= prevAdds) {
      if (nextSeg.end - start <= hardMax) {
        end = nextSeg.end;
        expanded = true;
        continue;
      }
    }
    if (prevSeg) {
      if (end - prevSeg.start <= hardMax) {
        start = prevSeg.start;
        expanded = true;
      }
    }
  }

  return { ...highlight, start, end };
}

function dropOverlappingClips(clips: Highlight[]): Highlight[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const result: Highlight[] = [];
  for (const clip of sorted) {
    const previous = result[result.length - 1];
    if (!previous || clip.start >= previous.end) {
      result.push(clip);
    }
  }
  return result;
}

function snapToSegmentBoundaries(
  highlight: Highlight,
  segments: TranscriptionResult["segments"]
): Highlight {
  if (segments.length === 0) return highlight;

  // Anchor the snap boundaries to the hook when present so we never cut the
  // engaging core. Without a hook fall back to the LLM-chosen start/end with
  // a 1s slack on each side.
  const startUpperBound =
    highlight.hookStart !== undefined
      ? Math.min(highlight.hookStart, highlight.start + 1)
      : highlight.start + 1;
  const endLowerBound =
    highlight.hookEnd !== undefined
      ? Math.max(highlight.hookEnd, highlight.end - 1)
      : highlight.end - 1;

  const startCandidates = segments.filter((s) => s.start <= startUpperBound);
  const snappedStart =
    startCandidates.length > 0
      ? startCandidates[startCandidates.length - 1].start
      : segments[0].start;

  const endCandidates = segments.filter((s) => s.end >= endLowerBound);
  const snappedEnd =
    endCandidates.length > 0
      ? endCandidates[0].end
      : segments[segments.length - 1].end;

  return {
    ...highlight,
    start: snappedStart,
    end: snappedEnd,
  };
}
