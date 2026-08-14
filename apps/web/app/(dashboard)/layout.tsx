import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { userService, getFreeTrialStatus } from "@clipclap/shared";
import { Sidebar } from "@/components/sidebar";
import { MobileHeader } from "@/components/mobile-header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await userService.getUsage(session.user.id);

  // The free allowance is lifetime, not per-period (FREE_TIER in plans.ts), so
  // the sidebar can only show a bar for it by asking the free_usage ledger.
  // Fetched here and not in getUsage: every other consumer of the summary is a
  // paid-plan surface that would pay the extra query for nothing.
  const freeTrial =
    usage.plan === "NONE" ? await getFreeTrialStatus(session.user.id) : null;

  const user = {
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    avatarUrl: session.user.image ?? null,
  };
  const usageProps = {
    minutesUsed: usage.minutesUsed,
    minutesLimit: usage.minutesLimit,
    topUpRemaining: usage.topUpMinutesRemaining,
    plan: usage.plan,
    freeTrial: freeTrial
      ? {
          usedMinutes: Math.min(
            Math.floor(freeTrial.lifetimeSeconds / 60),
            Math.floor(
              (freeTrial.lifetimeSeconds - freeTrial.remainingSeconds) / 60
            )
          ),
          limitMinutes: Math.floor(freeTrial.lifetimeSeconds / 60),
        }
      : null,
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <MobileHeader user={user} usage={usageProps} />
      <Sidebar user={user} usage={usageProps} />
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
    </div>
  );
}
