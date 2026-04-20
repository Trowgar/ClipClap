import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { billingService, userService } from "@clipfast/shared";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [subscription, usage] = await Promise.all([
    billingService.getSubscription(session.user.id),
    userService.getUsage(session.user.id),
  ]);

  return NextResponse.json({ ...subscription, usage });
}
