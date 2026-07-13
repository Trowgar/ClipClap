import { NextRequest, NextResponse } from "next/server";
import {
  TRIBUTE_SIGNATURE_HEADER,
  loadTributeProductIndexFromEnv,
  processTributeEvent,
  verifyTributeSignature,
  type TributeWebhookEnvelope,
} from "@clipclap/shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const apiKey = process.env.TRIBUTE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Tribute is not configured" },
      { status: 503 }
    );
  }

  const rawBody = await req.text();
  const signature = req.headers.get(TRIBUTE_SIGNATURE_HEADER);

  console.log("[tribute-webhook] received", {
    bodyBytes: rawBody.length,
    signaturePresent: Boolean(signature),
  });

  if (!verifyTributeSignature(rawBody, signature, apiKey)) {
    console.warn("[tribute-webhook] signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let envelope: TributeWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !envelope ||
    typeof envelope.name !== "string" ||
    typeof envelope.payload !== "object" ||
    envelope.payload === null
  ) {
    console.warn("[tribute-webhook] malformed envelope", { raw: rawBody.slice(0, 400) });
    return NextResponse.json(
      { error: "Malformed envelope" },
      { status: 400 }
    );
  }

  console.log("[tribute-webhook] parsed", {
    name: envelope.name,
    subscription_id: envelope.payload?.subscription_id,
    period_id: envelope.payload?.period_id,
    telegram_user_id: envelope.payload?.telegram_user_id,
    expires_at: envelope.payload?.expires_at,
  });

  const index = loadTributeProductIndexFromEnv(process.env);

  try {
    const outcome = await processTributeEvent(envelope, index);
    console.log("[tribute-webhook] outcome", outcome);
    // Unmapped events are a config problem, not a client error: return 5xx so
    // Tribute retries (the inbox row is FAILED and reprocessable after a fix).
    const retryable = outcome.status === "unmapped_subscription";
    return NextResponse.json({ ok: !retryable, outcome }, { status: retryable ? 500 : 200 });
  } catch (error) {
    console.error("[tribute-webhook] processing failed:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
