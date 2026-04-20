import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { jobService, userService } from "@clipfast/shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;

  // Check plan limits
  const check = await userService.canCreateJob(userId);
  if (!check.allowed) {
    return NextResponse.json(
      { error: check.reason, usage: check.usage, limit: check.limit },
      { status: 429 }
    );
  }

  const body = await req.json();
  const { url, sourceKey, originalFilename, subtitles, subtitlePreset } = body;

  if (!url && !sourceKey) {
    return NextResponse.json(
      { error: "Provide a video URL or upload a file first" },
      { status: 400 }
    );
  }

  const job = await jobService.createJob({
    userId,
    sourceUrl: url || undefined,
    sourceKey: sourceKey || undefined,
    originalFilename: originalFilename || undefined,
    subtitles: subtitles !== false,
    subtitlePreset: subtitlePreset || "tiktok",
  });

  return NextResponse.json(job, { status: 201 });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobs = await jobService.getUserJobs(session.user.id);
  return NextResponse.json(jobs);
}
