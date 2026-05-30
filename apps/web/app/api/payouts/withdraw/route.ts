import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withdrawalService } from "@clipfast/shared";

export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { method, destination, amountUsd } = await req.json();
  const result = await withdrawalService.createWithdrawal(userId, { method, destination, amountUsd: Number(amountUsd) });
  if (result.status === "error") return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, requestId: result.requestId });
}
