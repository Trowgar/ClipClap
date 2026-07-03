import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { userService } from "@clipclap/shared";
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
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <MobileHeader user={user} usage={usageProps} />
      <Sidebar user={user} usage={usageProps} />
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
    </div>
  );
}
