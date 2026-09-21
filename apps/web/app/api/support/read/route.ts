import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { markWebSupportRead } from "@clipclap/shared";

export async function POST(req: NextRequest) {
  const user = (await auth())?.user;
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const raw = await req.text();
  if (raw.length > 8192) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const messageIds = body.messageIds;
  if (!Array.isArray(messageIds) || messageIds.length > 100 ||
      messageIds.some(id => typeof id !== "string" || id.length < 1 || id.length > 64)) {
    return NextResponse.json({ error: "Invalid message IDs" }, { status: 400 });
  }
  await markWebSupportRead(user.id, [...new Set(messageIds as string[])]);
  return new NextResponse(null, { status: 204 });
}
