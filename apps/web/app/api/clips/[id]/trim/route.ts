import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipfast/shared";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();

  if (typeof body.start !== "number" || typeof body.end !== "number") {
    return NextResponse.json(
      { error: "start and end are required numbers" },
      { status: 400 }
    );
  }

  if (body.end <= body.start) {
    return NextResponse.json(
      { error: "end must be greater than start" },
      { status: 400 }
    );
  }

  const clip = await clipService.trimClip({
    clipId: id,
    userId: session.user.id,
    start: body.start,
    end: body.end,
    subtitles: body.subtitles ?? true,
    subtitlePreset: body.subtitlePreset,
  });

  return NextResponse.json(clip, { status: 201 });
}
