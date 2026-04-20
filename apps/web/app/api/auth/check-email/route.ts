import { NextResponse } from "next/server";
import { prisma } from "@clipfast/shared";

export async function POST(req: Request) {
  const { email } = await req.json();

  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, password: true },
  });

  return NextResponse.json({
    exists: !!user,
    hasPassword: !!user?.password,
  });
}
