import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { referralService } from "@clipfast/shared";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { method, destination } = await req.json();
  const result = await referralService.setPayoutDestination(session.user.id, method, destination);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
