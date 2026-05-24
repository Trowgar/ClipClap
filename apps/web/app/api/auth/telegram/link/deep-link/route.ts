import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createBrowserInitiatedLink } from "@clipfast/shared";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  if (!botUsername) {
    return NextResponse.json(
      { error: "Telegram bot is not configured" },
      { status: 503 }
    );
  }

  const { code, expiresAt } = await createBrowserInitiatedLink({
    userId: session.user.id,
  });

  const url = `https://t.me/${botUsername}?start=link_${code}`;
  return NextResponse.json({ url, code, expiresAt });
}
