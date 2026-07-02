import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { referralService } from "@clipclap/shared";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const code = await referralService.acceptReferralTerms(session.user.id);
  return NextResponse.json({ code });
}
