import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma, recordConversionEvent } from "@clipclap/shared";

const EVENTS = new Set(["offer_shown", "offer_clicked", "upload_blocked", "file_fallback_clicked", "plans_viewed", "checkout_clicked"]);
const FIELDS = new Set(["durationSec", "remainingSec", "plan", "cycle", "pack", "code", "placement"]);

export async function POST(req: NextRequest) {
  const user = (await auth())?.user;
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(process.env.NEXTAUTH_URL || req.url).origin) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const text = await req.text();
  if (text.length > 2048) return NextResponse.json({ error: "Too large" }, { status: 413 });
  let body;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || !EVENTS.has(body.event) || typeof body.eventId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(body.eventId)) {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }
  const detail: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(body.detail ?? {})) {
    if (!FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86400) detail[key] = value;
    if (typeof value === "string" && value.length <= 64) detail[key] = value;
  }
  try {
    // ponytail: DB count is enough at this traffic; use a shared rate limiter if volume grows.
    const count = await prisma.conversionEvent.count({ where: {
      surface: "web", subjectId: user.id, createdAt: { gte: new Date(Date.now() - 60000) },
    } });
    if (count >= 60) return new NextResponse(null, { status: 429 });
    await recordConversionEvent("web", user.id, body.event, detail, `browser:${user.id}:${body.eventId}`);
  } catch { /* Analytics never blocks the product. */ }
  return new NextResponse(null, { status: 204 });
}
