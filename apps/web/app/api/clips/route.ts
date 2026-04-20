import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clipService } from "@clipfast/shared";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clips = await clipService.getUserClips(session.user.id);
  return NextResponse.json(clips);
}
