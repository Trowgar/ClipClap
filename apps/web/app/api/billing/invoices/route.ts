import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { billingService } from "@clipfast/shared";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cursor = req.nextUrl.searchParams.get("after") ?? undefined;

  try {
    const page = await billingService.listInvoices(session.user.id, { cursor });
    return NextResponse.json(page);
  } catch (e) {
    console.error("billing/invoices/route.ts:", e);
    return NextResponse.json(
      { error: "Failed to load invoices. Please try again later." },
      { status: 500 }
    );
  }
}
