import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { projectService, userService, getPlanLimits } from "@clipclap/shared";
import { UploadZone } from "@/components/upload-zone";
import { RecentProjects } from "@/components/project-list";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [recentProjects, usage] = await Promise.all([
    projectService.getRecentProjects(session.user.id),
    userService.getUsage(session.user.id),
  ]);

  // NONE now carries the free allowance rather than zeros, so the upload zone
  // renders enabled for a new account with the free caps applied.
  const limits = getPlanLimits(usage.plan, usage.billingCycle ?? "MONTHLY");

  const serializedProjects = JSON.parse(JSON.stringify(recentProjects.projects));

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Drop a stream, podcast, or VOD. AI cuts vertical clips with subtitles.
        </p>
      </div>

      <UploadZone
        minutesUsed={usage.minutesUsed}
        minutesLimit={usage.minutesLimit}
        topUpMinutesRemaining={usage.topUpMinutesRemaining}
        maxSourceDurationMinutes={limits.maxSourceDurationMinutes}
        maxFileSizeBytes={limits.maxFileSizeBytes}
      />

      <RecentProjects
        projects={serializedProjects}
        hasMore={recentProjects.hasMore}
      />
    </div>
  );
}
