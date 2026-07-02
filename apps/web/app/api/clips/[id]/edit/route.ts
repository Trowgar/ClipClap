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

  const body = await req.json();
  const track = parseTrack(body.subtitleTrack);
  if (track === "invalid") {
    return NextResponse.json({ error: "Invalid subtitleTrack" }, { status: 400 });
  }

  const start = body.trim?.start ?? clip.startTime;
  const end = body.trim?.end ?? clip.endTime;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) {
    return NextResponse.json({ error: "Invalid trim range" }, { status: 400 });
  }

  const newClip = await clipService.editClip({
    clipId: id,
    userId: session.user.id,
    start,
    end,
    subtitles: body.subtitles ?? true,
    subtitleTrack: track ?? undefined,
  });

  return NextResponse.json(newClip, { status: 201 });
}
