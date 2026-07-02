import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { walletService, withdrawalService, referralService } from "@clipclap/shared";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [balance, bySource, active, history, referralStats] = await Promise.all([
    walletService.getWalletBalance(userId),
    walletService.getEarningsBySource(userId),
    withdrawalService.getActiveWithdrawal(userId),
    withdrawalService.getWithdrawalHistory(userId),
    referralService.getReferralStats(userId),
  ]);

  return NextResponse.json({ balance, bySource, clearingUsd: referralStats.pendingUsd, active, history });
}
