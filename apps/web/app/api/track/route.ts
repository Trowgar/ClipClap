import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { normalizeTrackedPath, recordSiteVisit } from "@clipclap/shared";

// Prisma and the GeoIP reader both need Node APIs, which the Edge runtime does
// not have - this is exactly why the middleware hands off to this route rather
// than writing the visit itself.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Constant-time secret compare, matching the care taken in mini-app.service. */
function secretsMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = process.env.TRACK_SECRET;
  // Without the shared secret this is a public endpoint that writes rows:
  // anyone could inflate the numbers. Answer 204 either way so the endpoint
  // does not confirm whether a guess was right.
  if (!secret || !secretsMatch(req.headers.get("x-track-secret"), secret)) {
    return new NextResponse(null, { status: 204 });
  }

  let body: {
    ip?: string;
    userAgent?: string;
    path?: string;
    referrer?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  if (!body.ip || !body.path) return new NextResponse(null, { status: 204 });

  // Collapse onto the routes the site actually has: the unique key includes the
  // path, so an attacker walking distinct URLs would otherwise create unlimited
  // rows per day. The slice is the belt to that braces - a pathname beyond the
  // btree limit fails the insert silently.
  const path = normalizeTrackedPath(body.path).slice(0, 200);

  await recordSiteVisit({
    ip: body.ip,
    userAgent: body.userAgent,
    path,
    referrer: body.referrer,
    secret,
    selfHost: process.env.NEXT_PUBLIC_APP_HOST ?? "clipclap.io",
  });

  return new NextResponse(null, { status: 204 });
}
