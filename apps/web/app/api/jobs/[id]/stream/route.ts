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
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const close = () => {
        if (stopped) return;
        stop();
        try {
          controller.close();
        } catch {
          // The client may have cancelled between the status read and close.
        }
      };

      const send = (data: Record<string, unknown>) => {
        if (stopped) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          stop();
        }
      };

      // Poll job status every 2 seconds
      interval = setInterval(async () => {
        if (stopped) return;
        try {
          const job = await prisma.job.findFirst({
            where: { id, userId },
            include: { clips: true },
          });
          if (stopped) return;

          if (!job) {
            send({ error: "Job not found" });
            close();
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
            close();
          }
        } catch {
          close();
        }
      }, 2000);
    },
    cancel() {
      stop();
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
