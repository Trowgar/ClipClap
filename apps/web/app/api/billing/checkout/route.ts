import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { billingService } from "@clipfast/shared";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const plan = body.plan as "STARTER" | "PRO";

  if (!["STARTER", "PRO"].includes(plan)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const url = await billingService.createCheckoutSession(
    session.user.id,
    plan,
    `${origin}/dashboard?checkout=success`,
    `${origin}/dashboard/plans?checkout=cancelled`
  );

  return NextResponse.json({ url });
}
