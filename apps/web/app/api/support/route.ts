import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  SupportRateLimitError,
  countUnreadWebSupport,
  listWebSupportMessages,
  submitWebSupportMessage,
} from "@clipclap/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DASHBOARD_PATH = /^\/dashboard(?:\/|$)/;

export async function GET() {
  const user = (await auth())?.user;
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [messages, unread] = await Promise.all([
    listWebSupportMessages(user.id), countUnreadWebSupport(user.id),
  ]);
  return NextResponse.json({ messages, unread });
}

export async function POST(req: NextRequest) {
  const user = (await auth())?.user;
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const raw = await req.text();
  if (raw.length > 8192) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId : "";
  const contextPath = body.contextPath === undefined ? undefined : body.contextPath;
  if (!text || text.length > 4000 || !UUID.test(clientMessageId) ||
      (contextPath !== undefined && (typeof contextPath !== "string" || !DASHBOARD_PATH.test(contextPath)))) {
    return NextResponse.json({ error: "Invalid support message" }, { status: 400 });
  }
  try {
    const message = await submitWebSupportMessage({
      userId: user.id, text, clientMessageId,
      contextPath: contextPath as string | undefined,
    });
    return NextResponse.json({ message });
  } catch (error) {
    if (error instanceof SupportRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    console.error("Web support send failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not send your message. Please try again." }, { status: 500 });
  }
}
