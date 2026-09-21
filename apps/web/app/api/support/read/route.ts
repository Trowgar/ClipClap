import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { markWebSupportRead } from "@clipclap/shared";

export async function POST() {
  const user = (await auth())?.user;
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await markWebSupportRead(user.id);
  return new NextResponse(null, { status: 204 });
}
