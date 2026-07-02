import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@clipclap/shared";
import { TelegramConnection } from "./telegram-connection";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { telegramId: true },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account settings
        </p>
      </div>

      {/* Profile */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Profile</h2>
        <div className="flex items-center gap-4 rounded-lg border border-border p-4">
          {session.user.image ? (
            <img
              src={session.user.image}
              alt=""
              className="h-12 w-12 rounded-full"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-lg font-bold">
              {session.user.name?.[0] || "U"}
            </div>
          )}
          <div>
            <p className="font-medium">{session.user.name}</p>
            <p className="text-sm text-muted-foreground">
              {session.user.email}
            </p>
          </div>
        </div>
      </div>

      {/* Telegram */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Telegram</h2>
        <TelegramConnection telegramId={user?.telegramId ?? null} />
      </div>
    </div>
  );
}
