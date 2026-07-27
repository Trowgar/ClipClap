import { NextRequest, NextResponse } from "next/server";
import {
  isAdminTelegramId,
  signAdminCookie,
  verifyTelegramInitData,
} from "@clipclap/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const { initData } = (await req.json().catch(() => ({}))) as {
    initData?: string;
  };

  const result = verifyTelegramInitData(
    initData ?? "",
    process.env.TELEGRAM_BOT_TOKEN
  );
  // One shape of failure for every reason - a bad signature, a stale
  // auth_date and a valid signature from a non-admin all look identical.
  if (
    !result.ok ||
    !isAdminTelegramId(result.telegramId, process.env.REFERRAL_ADMIN_TELEGRAM_IDS)
  ) {
    return new NextResponse(null, { status: 204 });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return new NextResponse(null, { status: 204 });

  const res = NextResponse.json({ ok: true });
  res.cookies.set("cc_admin", signAdminCookie(result.telegramId, secret, TTL_MS), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/admin",
    maxAge: TTL_MS / 1000,
  });
  return res;
}
