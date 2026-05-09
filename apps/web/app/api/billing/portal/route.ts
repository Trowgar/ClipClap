import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma, billingService } from "@clipfast/shared";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
  });
  if (!user.stripeCustomerId) {
    return NextResponse.json(
      { error: "No Stripe customer; subscribe to a plan first" },
      { status: 400 }
    );
  }

  const stripe = billingService.getStripe();
  const origin = process.env.NEXTAUTH_URL ?? req.nextUrl.origin;
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${origin}/dashboard/settings`,
    });
    return NextResponse.json({ url: portal.url });
  } catch (e) {
    console.error("billing/portal/route.ts:", e);
    return NextResponse.json(
      { error: "Failed to open Customer Portal. Please try again later." },
      { status: 500 }
    );
  }
}
