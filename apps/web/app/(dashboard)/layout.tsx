import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { userService } from "@clipfast/shared";
import { Sidebar } from "@/components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await userService.getUsage(session.user.id);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        user={{
          name: session.user.name ?? null,
          email: session.user.email ?? null,
          avatarUrl: session.user.image ?? null,
        }}
        usage={{
          minutesUsed: usage.minutesUsed,
          minutesLimit: usage.minutesLimit,
          topUpRemaining: usage.topUpMinutesRemaining,
          plan: usage.plan,
        }}
      />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
