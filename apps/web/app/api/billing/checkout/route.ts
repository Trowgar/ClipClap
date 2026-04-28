import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { billingService } from "@clipfast/shared";
import type { Plan, BillingCycle } from "@prisma/client";

const VALID_PLANS = ["STARTER", "PLUS", "MAX"] as const;
const VALID_CYCLES = ["WEEKLY", "MONTHLY"] as const;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const plan = body.plan as Exclude<Plan, "NONE">;
  const cycle = body.cycle as BillingCycle;

  if (!VALID_PLANS.includes(plan)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }
  if (!VALID_CYCLES.includes(cycle)) {
    return NextResponse.json({ error: "Invalid billing cycle" }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  try {
    const url = await billingService.createCheckoutSession(
      session.user.id,
      plan,
      cycle,
      `${origin}/dashboard?checkout=success`,
      `${origin}/dashboard/plans?checkout=cancelled`
    );
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create checkout" },
      { status: 400 }
    );
  }
}
