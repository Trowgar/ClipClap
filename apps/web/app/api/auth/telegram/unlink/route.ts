import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma, TELEGRAM_AUTH_PROVIDER } from "@clipfast/shared";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await prisma.$transaction([
    prisma.account.deleteMany({
      where: { userId: session.user.id, provider: TELEGRAM_AUTH_PROVIDER },
    }),
    prisma.user.update({
      where: { id: session.user.id },
      data: { telegramId: null, telegramLocale: null },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
