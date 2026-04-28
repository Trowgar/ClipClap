import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { jobService, prisma, getPlanLimits, canSubmitJob } from "@clipfast/shared";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = [
  "PENDING",
  "DOWNLOADING",
  "TRANSCRIBING",
  "ANALYZING",
  "CUTTING",
] as const;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const body = await req.json();
  const { url, sourceKey, originalFilename, subtitles, subtitlePreset, sourceDurationSec } = body;

  if (!url && !sourceKey) {
    return NextResponse.json(
      { error: "Provide a video URL or upload a file first" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.plan === "NONE") {
    return NextResponse.json(
      { error: "Active subscription required to create jobs" },
      { status: 402 }
    );
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");

  let durationMinutes = 0;
  if (typeof sourceDurationSec === "number" && sourceDurationSec > 0) {
    durationMinutes = Math.ceil(sourceDurationSec / 60);
    if (durationMinutes > limits.maxSourceDurationMinutes) {
      return NextResponse.json(
        {
          error: `Source exceeds max duration (${limits.maxSourceDurationMinutes} min). Trim before uploading.`,
        },
        { status: 400 }
      );
    }
  }

  const submission = await canSubmitJob(userId, durationMinutes);
  if (!submission.allowed) {
    return NextResponse.json({ error: submission.reason }, { status: 402 });
  }

  // Daily job count
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const jobsToday = await prisma.job.count({
    where: { userId, createdAt: { gte: dayStart } },
  });
  if (jobsToday >= limits.maxJobsPerDay) {
    return NextResponse.json(
      {
        error: `Daily job limit reached (${limits.maxJobsPerDay}). Try again tomorrow or upgrade.`,
      },
      { status: 429 }
    );
  }

  // Concurrent in-flight
  const inFlight = await prisma.job.count({
    where: { userId, status: { in: [...ACTIVE_STATUSES] } },
  });
  if (inFlight >= limits.concurrentJobsLimit) {
    return NextResponse.json(
      {
        error: `You have ${inFlight} active jobs (limit: ${limits.concurrentJobsLimit}). Wait for one to finish.`,
      },
      { status: 429 }
    );
  }

  const job = await jobService.createJob({
    userId,
    sourceUrl: url || undefined,
    sourceKey: sourceKey || undefined,
    originalFilename: originalFilename || undefined,
    subtitles: subtitles !== false,
    subtitlePreset: subtitlePreset || "tiktok",
    sourceDurationSec: typeof sourceDurationSec === "number" ? sourceDurationSec : undefined,
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
