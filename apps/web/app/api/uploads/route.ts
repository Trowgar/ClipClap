import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPresignedUploadUrl, prisma, getPlanLimits, canSubmitJob } from "@clipfast/shared";
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

  // Coarse gate at presign time: status + grace-date + already-over-quota.
  // Duration is unknown until the file is uploaded, so pass 0; exact minute
  // enforcement happens at job submit (api/jobs/route.ts) with the real duration.
  const submission = await canSubmitJob(session.user.id, 0);
  if (!submission.allowed) {
    return NextResponse.json({ error: submission.reason }, { status: 402 });
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
