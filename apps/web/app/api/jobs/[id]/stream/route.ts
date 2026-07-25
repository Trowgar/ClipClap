import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { parseJobErrorCode, prisma } from "@clipclap/shared";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      // Poll job status every 2 seconds
      const interval = setInterval(async () => {
        try {
          const job = await prisma.job.findFirst({
            where: { id, userId },
            include: { clips: true },
          });

          if (!job) {
            send({ error: "Job not found" });
            clearInterval(interval);
            controller.close();
            return;
          }

          // Only the code crosses the wire: Job.error is engineer prose the UI
          // must never render (and the browser has no business holding it).
          send({
            status: job.status,
            errorCode: parseJobErrorCode(job.error),
            clipCount: job.clips.length,
          });

          if (job.status === "DONE" || job.status === "FAILED") {
            clearInterval(interval);
            controller.close();
          }
        } catch {
          clearInterval(interval);
          controller.close();
        }
      }, 2000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
