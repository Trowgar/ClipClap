import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  prisma,
  projectService,
  userService,
  canSubmitJob,
  getFreeTrialStatus,
  getPlanLimits,
  recordFunnelEvent,
  FUNNEL_EVENTS,
} from "@clipclap/shared";
import { UploadZone } from "@/components/upload-zone";
import { RecentProjects } from "@/components/project-list";
import { FreeExhaustedPanel, FreePausedPanel } from "@/components/free-state";
import { VerifyEmailPanel } from "@/components/verify-email-panel";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // canSubmitJob with a duration of 0 is the same call the submit path makes,
  // asked one step earlier. Reproducing its conditions here - "is the plan
  // NONE, is the account anchored, is there a balance, is the budget open" -
  // would give this page a second opinion that drifts from the gate the moment
  // either is edited, which is exactly the failure being fixed: the old page
  // held an opinion ("NONE now carries the free allowance") that the gate had
  // stopped sharing in July. Zero is honest here - no file has been picked yet
  // - and the gate handles it: the FREE_EXHAUSTED clause deliberately does not
  // depend on its caller having measured anything.
  const [recentProjects, usage, gate, trial, mailState] = await Promise.all([
    projectService.getRecentProjects(userId),
    userService.getUsage(userId),
    canSubmitJob(userId, 0),
    getFreeTrialStatus(userId),
    // Read for exactly one panel, and read here rather than inside it because
    // the panel is a client component. Null means "no record of a link going
    // out" - a failed send, or an account older than the column - and the panel
    // says so instead of asserting a send nobody can see.
    prisma.user.findUnique({
      where: { id: userId },
      select: { verificationSentAt: true },
    }),
  ]);

  // After the page's own data is resolved, never before: this is telemetry and
  // must not sit in front of what the user came for. recordFunnelEvent never
  // throws, so a failing write cannot break the dashboard.
  await recordFunnelEvent("web", userId, FUNNEL_EVENTS.APP_OPENED);

  const limits = getPlanLimits(usage.plan, usage.billingCycle ?? "MONTHLY");
  const serializedProjects = JSON.parse(JSON.stringify(recentProjects.projects));

  // Floored, so the number here is the number the refusal would quote. Someone
  // with 40 seconds left has 0 usable minutes, and rounding that up to 1 would
  // re-enable the button the gate is about to refuse.
  const freeAllowance = {
    remainingMinutes: Math.floor(trial.remainingSeconds / 60),
    lifetimeMinutes: Math.round(trial.lifetimeSeconds / 60),
  };

  // Only the free codes are handled. A paid account that is blocked for
  // LIFECYCLE or QUOTA keeps the upload zone it has always had - fixing those
  // surfaces is a different job, and silently changing what a paying customer
  // sees is not something to slip into this one.
  const blockCode = gate.allowed ? null : gate.code;

  // `usage.plan === "NONE"` is safe as the free test only because the gate has
  // already run: getSubscriptionState is never `live` for plan NONE, so an
  // allowed submission on plan NONE can only have come through checkFreeTrial.
  const onFreePlan = usage.plan === "NONE";

  // The three free refusals replace the upload zone with a panel, so the empty
  // projects list must not tell the reader to upload "above".
  const showsUploadZone =
    blockCode !== "FREE_NOT_ANCHORED" &&
    blockCode !== "FREE_EXHAUSTED" &&
    blockCode !== "FREE_BUDGET_CLOSED";

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Drop a stream, podcast, or VOD. AI cuts vertical clips with subtitles.
        </p>
      </div>

      {blockCode === "FREE_NOT_ANCHORED" ? (
        <VerifyEmailPanel
          email={session.user.email ?? null}
          lifetimeMinutes={freeAllowance.lifetimeMinutes}
          verificationSentAt={mailState?.verificationSentAt ?? null}
        />
      ) : blockCode === "FREE_EXHAUSTED" ? (
        <FreeExhaustedPanel
          remainingMinutes={freeAllowance.remainingMinutes}
          lifetimeMinutes={freeAllowance.lifetimeMinutes}
        />
      ) : blockCode === "FREE_BUDGET_CLOSED" ? (
        <FreePausedPanel
          remainingMinutes={freeAllowance.remainingMinutes}
          lifetimeMinutes={freeAllowance.lifetimeMinutes}
        />
      ) : (
        <UploadZone
          minutesUsed={usage.minutesUsed}
          minutesLimit={usage.minutesLimit}
          topUpMinutesRemaining={usage.topUpMinutesRemaining}
          maxSourceDurationMinutes={limits.maxSourceDurationMinutes}
          maxFileSizeBytes={limits.maxFileSizeBytes}
          freeAllowance={onFreePlan ? freeAllowance : null}
        />
      )}

      <RecentProjects
        projects={serializedProjects}
        hasMore={recentProjects.hasMore}
        canUpload={showsUploadZone}
      />
    </div>
  );
}
