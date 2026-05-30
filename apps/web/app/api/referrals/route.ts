import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma, referralService } from "@clipfast/shared";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true, referralTermsAcceptedAt: true },
  });

  const stats = await referralService.getReferralStats(userId);
  const referrals = await prisma.user.findMany({
    where: { referredById: userId },
    select: { id: true, createdAt: true, plan: true, subscriptionStatus: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    code: user?.referralCode ?? null,
    termsAccepted: !!user?.referralTermsAcceptedAt,
    pendingUsd: stats.pendingUsd,
    earnedUsd: stats.earnedUsd,
    referrals,
  });
}
