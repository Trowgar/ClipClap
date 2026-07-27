import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

// Inlined from @clipclap/shared config/referral.ts.
// We cannot import from the @clipclap/shared barrel here because it re-exports
// ./lib (which includes prisma.ts) and the Edge runtime is not compatible with
// Prisma's Node.js bindings. REFERRAL_COOKIE_NAME and REFERRAL_CONFIG are plain
// constants so we inline them to keep middleware Edge-safe.
const REFERRAL_COOKIE_NAME = "cc_ref";
const ATTRIBUTION_WINDOW_DAYS = 30; // REFERRAL_CONFIG.attributionWindowDays

/**
 * Hands the visit to /api/_track, which runs on Node and can reach Prisma.
 *
 * Wrapped in event.waitUntil because a bare un-awaited fetch may be killed
 * along with the response, silently losing visits.
 */
function trackVisit(req: NextRequest, event: NextFetchEvent): void {
  const secret = process.env.TRACK_SECRET;
  if (!secret) return;

  // The owner's own analytics visits must not pollute the numbers he reads.
  if (req.nextUrl.pathname.startsWith("/admin")) return;

  const ip =
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip) return;

  // NEVER derive this from req.url: the host nginx forwards the client-supplied
  // Host header, so an attacker could set it and have us POST the secret to
  // their server.
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  if (!origin) return;

  event.waitUntil(
    fetch(new URL("/api/_track", origin), {
      method: "POST",
      headers: { "content-type": "application/json", "x-track-secret": secret },
      body: JSON.stringify({
        ip,
        userAgent: req.headers.get("user-agent") ?? "",
        path: req.nextUrl.pathname,
        referrer: req.headers.get("referer") ?? "",
      }),
    }).catch(() => undefined)
  );
}

export function middleware(req: NextRequest, event: NextFetchEvent) {
  trackVisit(req, event);

  const ref = req.nextUrl.searchParams.get("ref");

  // Auth guard only for /dashboard.
  if (req.nextUrl.pathname.startsWith("/dashboard")) {
    const sessionCookie =
      req.cookies.get("authjs.session-token") ||
      req.cookies.get("__Secure-authjs.session-token") ||
      req.cookies.get("next-auth.session-token") ||
      req.cookies.get("__Secure-next-auth.session-token");
    if (!sessionCookie) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    return NextResponse.next();
  }

  // Last-touch attribution: set/overwrite the ref cookie on any page hit with ?ref=.
  const res = NextResponse.next();
  if (ref) {
    res.cookies.set(REFERRAL_COOKIE_NAME, ref, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60,
      path: "/",
    });
  }
  return res;
}

// Every page, but never /api (the track route would record itself in a loop),
// _next internals, or files with an extension.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
