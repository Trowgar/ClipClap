import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { jobService, userService, getPlanLimits } from "@clipfast/shared";
import { UploadZone } from "@/components/upload-zone";
import { JobList } from "@/components/job-list";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [jobs, usage] = await Promise.all([
    jobService.getUserJobs(session.user.id),
    userService.getUsage(session.user.id),
  ]);

  // getPlanLimits returns NONE_LIMITS (zeros) for plan="NONE", so the
  // upload zone renders disabled with a clear "subscribe first" banner.
  const limits = getPlanLimits(usage.plan, usage.billingCycle ?? "MONTHLY");

  const serializedJobs = JSON.parse(JSON.stringify(jobs));

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Drop a stream, podcast, or VOD. AI cuts vertical clips with subtitles.
        </p>
      </div>

      <UploadZone
        plan={usage.plan}
        minutesUsed={usage.minutesUsed}
        minutesLimit={usage.minutesLimit}
        topUpMinutesRemaining={usage.topUpMinutesRemaining}
        maxSourceDurationMinutes={limits.maxSourceDurationMinutes}
        maxFileSizeBytes={limits.maxFileSizeBytes}
        availableSubtitlePresets={limits.subtitlePresets}
      />

      <div>
        <h2 className="mb-4 text-lg font-semibold">Recent Jobs</h2>
        <JobList jobs={serializedJobs} />
      </div>
    </div>
  );
}
