import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma, referralService } from "@clipfast/shared";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      referralCode: true,
      referralTermsAcceptedAt: true,
      payoutMethod: true,
      payoutDestination: true,
    },
  });

  const balance = await referralService.getReferralBalance(userId);
  const referrals = await prisma.user.findMany({
    where: { referredById: userId },
    select: { id: true, createdAt: true, plan: true, subscriptionStatus: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    code: user?.referralCode ?? null,
    termsAccepted: !!user?.referralTermsAcceptedAt,
    payoutMethod: user?.payoutMethod ?? null,
    payoutDestination: user?.payoutDestination ?? null,
    balance,
    referrals,
  });
}
