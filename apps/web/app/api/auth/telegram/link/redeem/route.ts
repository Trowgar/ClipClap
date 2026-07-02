import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { redeemLinkFromBrowser } from "@clipclap/shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const rawCode = typeof body?.code === "string" ? body.code : "";
  const code = rawCode.trim().toUpperCase();

  if (!/^[A-Z2-9]{6}$/.test(code)) {
    return NextResponse.json(
      { status: "invalid_code" satisfies "invalid_code" },
      { status: 400 }
    );
  }

  const result = await redeemLinkFromBrowser({
    code,
    userId: session.user.id,
  });

  const httpStatus =
    result.status === "linked" || result.status === "already_linked" ? 200 : 400;

  return NextResponse.json(result, { status: httpStatus });
}
