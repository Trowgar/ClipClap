import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { projectService } from "@clipclap/shared";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await projectService.deleteProject(id, session.user.id);

  if (result.status === "not_found") {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    deletedClips: result.deletedClips,
  });
}
