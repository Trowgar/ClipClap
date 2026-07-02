import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Inlined from @clipclap/shared config/referral.ts.
// We cannot import from the @clipclap/shared barrel here because it re-exports
// ./lib (which includes prisma.ts) and the Edge runtime is not compatible with
// Prisma's Node.js bindings. REFERRAL_COOKIE_NAME and REFERRAL_CONFIG are plain
// constants so we inline them to keep middleware Edge-safe.
const REFERRAL_COOKIE_NAME = "cc_ref";
const ATTRIBUTION_WINDOW_DAYS = 30; // REFERRAL_CONFIG.attributionWindowDays

export function middleware(req: NextRequest) {
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

export const config = {
  matcher: ["/", "/dashboard/:path*"],
};
