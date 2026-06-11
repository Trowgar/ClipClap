import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipfast/shared";

export async function GET(
  _req: NextRequest,
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

  return NextResponse.json(clip.subtitleTrack ?? { cues: [] });
}
