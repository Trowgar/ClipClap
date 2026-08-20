import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  isFeedbackReason,
  isFeedbackVerdict,
  recordClipFeedback,
} from "@clipclap/shared";

/** Deliberately NOT gated on isClipFeedbackEnabled("web").
 *
 *  The flag suppresses drawing the controls; the endpoint keeps accepting so a
 *  page loaded before the switch was thrown does not error under the user's
 *  hands. The bot behaves the same way, for a stronger reason there - keyboards
 *  already sitting in people's chats cannot be recalled - and both surfaces
 *  share one contract so nobody has to remember which is which. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    verdict?: unknown;
    reason?: unknown;
    note?: unknown;
  };

  // Unknown codes are dropped rather than rejected: the vocabulary can grow
  // and an older tab must not be able to write a value the service does not
  // understand. An entirely empty body IS an error though - that is a bug in
  // the caller, not a no-op write.
  const verdict =
    typeof body.verdict === "string" && isFeedbackVerdict(body.verdict)
      ? body.verdict
      : undefined;
  const reason =
    typeof body.reason === "string" && isFeedbackReason(body.reason)
      ? body.reason
      : undefined;
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 2000) : undefined;

  if (verdict === undefined && reason === undefined && note === undefined) {
    return NextResponse.json({ error: "EMPTY_FEEDBACK" }, { status: 400 });
  }

  // Ownership is checked on the clip row inside the service: `id` comes from
  // the URL and is forgeable.
  const result = await recordClipFeedback({
    clipId: id,
    userId: session.user.id,
    surface: "web",
    verdict,
    reason,
    note,
  });

  if (!result.ok) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, verdict: result.verdict, reason: result.reason });
}
