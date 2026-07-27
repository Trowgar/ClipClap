import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  jobService,
  prisma,
  getPlanLimits,
  canSubmitJob,
  recordFunnelEvent,
  uploadRejectedEvent,
  FUNNEL_EVENTS,
} from "@clipclap/shared";

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
  const { url, sourceKey, originalFilename, subtitles, sourceDurationSec } = body;

  if (!url && !sourceKey) {
    return NextResponse.json(
      { error: "Provide a video URL or upload a file first" },
      { status: 400 }
    );
  }

  await recordFunnelEvent("web", userId, FUNNEL_EVENTS.VIDEO_SUBMITTED);

  const durationMinutes =
    typeof sourceDurationSec === "number" && sourceDurationSec > 0
      ? Math.ceil(sourceDurationSec / 60)
      : 0;

  // All limit checks are independent reads - run them in one round trip
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const [user, submission, jobsToday, inFlight] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    canSubmitJob(userId, durationMinutes),
    prisma.job.count({ where: { userId, createdAt: { gte: dayStart } } }),
    prisma.job.count({
      where: { userId, status: { in: [...ACTIVE_STATUSES] } },
    }),
  ]);

  // No flat refusal for NONE any more: a never-subscribed account has a free
  // allowance, and canSubmitJob is the single place that decides whether this
  // particular submission fits inside it.
  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");

  if (durationMinutes > limits.maxSourceDurationMinutes) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("TOO_LONG"));
    return NextResponse.json(
      {
        error: `Source exceeds max duration (${limits.maxSourceDurationMinutes} min). Trim before uploading.`,
      },
      { status: 400 }
    );
  }

  if (!submission.allowed) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent(submission.code));
    return NextResponse.json({ error: submission.reason }, { status: 402 });
  }

  if (jobsToday >= limits.maxJobsPerDay) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("DAILY_LIMIT"));
    return NextResponse.json(
      {
        error: `Daily job limit reached (${limits.maxJobsPerDay}). Try again tomorrow or upgrade.`,
      },
      { status: 429 }
    );
  }
  if (inFlight >= limits.concurrentJobsLimit) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("CONCURRENT"));
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
