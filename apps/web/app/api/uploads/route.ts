import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPresignedUploadUrl, prisma, getPlanLimits } from "@clipfast/shared";
import { randomUUID } from "crypto";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { filename, contentType, fileSizeBytes } = body;

  if (!filename || !contentType) {
    return NextResponse.json(
      { error: "filename and contentType are required" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
  });

  if (user.plan === "NONE") {
    return NextResponse.json(
      { error: "Active subscription required to upload" },
      { status: 402 }
    );
  }
  if (user.subscriptionStatus === "DUNNING") {
    return NextResponse.json(
      { error: "Payment failed; update your payment method" },
      { status: 402 }
    );
  }
  if (
    user.subscriptionStatus === "CANCELED_GRACE" ||
    user.subscriptionStatus === "CANCELED"
  ) {
    return NextResponse.json(
      { error: "Subscription canceled; resubscribe to upload" },
      { status: 402 }
    );
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");

  if (
    typeof fileSizeBytes === "number" &&
    fileSizeBytes > 0 &&
    fileSizeBytes > limits.maxFileSizeBytes
  ) {
    const maxGb = (limits.maxFileSizeBytes / (1024 * 1024 * 1024)).toFixed(1);
    return NextResponse.json(
      { error: `File too large; max ${maxGb} GB` },
      { status: 413 }
    );
  }

  const ext = filename.split(".").pop() || "mp4";
  const key = `uploads/${session.user.id}/${randomUUID()}.${ext}`;
  const uploadUrl = await getPresignedUploadUrl(key, contentType);

  return NextResponse.json({ uploadUrl, key });
}
