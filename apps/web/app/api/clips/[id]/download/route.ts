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
  const url = await clipService.getDownloadUrl(id, session.user.id);
  return NextResponse.json({ url });
}
