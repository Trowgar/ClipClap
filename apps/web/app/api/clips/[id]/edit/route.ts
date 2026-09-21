import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipclap/shared";
import type { SubtitleCue, SubtitleTrack } from "@clipclap/shared";

const MAX_CUES = 500;
const MAX_CUE_TEXT = 500;

function parseTrack(value: unknown): SubtitleTrack | null | "invalid" {
  if (value == null) return null;
  const track = value as SubtitleTrack;
  if (!Array.isArray(track.cues) || track.cues.length > MAX_CUES) {
    return "invalid";
  }
  for (const cue of track.cues as SubtitleCue[]) {
    if (
      !cue ||
      typeof cue.id !== "string" ||
      typeof cue.text !== "string" ||
      typeof cue.start !== "number" ||
      typeof cue.end !== "number" ||
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      cue.start < 0 ||
      !(cue.end > cue.start) ||
      cue.text.length > MAX_CUE_TEXT
    ) {
      return "invalid";
    }
  }
  return {
    cues: track.cues.map(({ id, start, end, text, words }) => ({
      id,
      start,
      end,
      text,
      words,
    })),
  };
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const clip = await clipService.getClip(id, session.user.id);
  if (!clip) {
    return NextResponse.json({ error: "Clip not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid edit request" }, { status: 400 });
  }
  const track = parseTrack(body.subtitleTrack);
  if (track === "invalid") {
    return NextResponse.json({ error: "Invalid subtitleTrack" }, { status: 400 });
  }

  const start = body.trim?.start === undefined ? clip.startTime : body.trim.start;
  const end = body.trim?.end === undefined ? clip.endTime : body.trim.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      (body.extendEndSeconds !== undefined && body.extendEndSeconds !== 2 && body.extendEndSeconds !== 5) ||
      (body.framing !== undefined && body.framing !== "safe-fit") ||
      (body.subtitles !== undefined && typeof body.subtitles !== "boolean")) {
    return NextResponse.json({ error: "Invalid trim range" }, { status: 400 });
  }

  try {
    const newClip = await clipService.editClip({
    clipId: id,
    userId: session.user.id,
    start,
    end,
    subtitles: body.subtitles ?? true,
    subtitleTrack: track ?? undefined,
    extendEndSeconds: body.extendEndSeconds,
    framing: body.framing,
  });

  return NextResponse.json(newClip, { status: 201 });
  } catch (error) {
    if (error instanceof clipService.ClipEditError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
