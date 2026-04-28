import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { topupService } from "@clipfast/shared";

const VALID_PACKS = ["SMALL", "LARGE"] as const;
type ValidPack = (typeof VALID_PACKS)[number];

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const pack = body.pack;

  if (!VALID_PACKS.includes(pack)) {
    return NextResponse.json(
      { error: "Invalid pack; must be SMALL or LARGE" },
      { status: 400 }
    );
  }

  const origin = req.nextUrl.origin;
  try {
    const url = await topupService.createTopupCheckoutSession(
      session.user.id,
      pack as ValidPack,
      `${origin}/dashboard?topup=success`,
      `${origin}/dashboard/plans?topup=cancelled`
    );
    return NextResponse.json({ url });
  } catch (e) {
    // Server-class: missing customer, missing env, Stripe API failure, etc.
    // Log internals, return a generic message so we don't leak infra details.
    console.error("topup/route.ts:", e);
    return NextResponse.json(
      { error: "Failed to create top-up checkout. Please try again later." },
      { status: 500 }
    );
  }
}
