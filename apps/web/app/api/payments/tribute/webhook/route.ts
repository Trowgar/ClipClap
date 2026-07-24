import { NextRequest, NextResponse } from "next/server";
import {
  TRIBUTE_SIGNATURE_HEADER,
  processTributeEvent,
  verifyTributeSignature,
  type TributeShopWebhookEnvelope,
} from "@clipclap/shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const apiKey = process.env.TRIBUTE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Tribute is not configured" }, { status: 503 });
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

  let envelope: TributeShopWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Tribute's "Send test request" button posts a minimal signed ping, not a real
  // event: {"test_event":"test_event"}. Acknowledge it with 200 so the dashboard
  // shows success; real events (which carry a string `name`) fall through below.
  const maybeTest = envelope as unknown as { test_event?: unknown; name?: unknown };
  if (maybeTest.test_event !== undefined && typeof maybeTest.name !== "string") {
    console.log("[tribute-webhook] test ping acknowledged");
    return NextResponse.json({ ok: true, test: true }, { status: 200 });
  }

  if (
    !envelope ||
    typeof envelope.name !== "string" ||
    typeof envelope.payload !== "object" ||
    envelope.payload === null ||
    typeof envelope.payload.uuid !== "string"
  ) {
    console.warn("[tribute-webhook] malformed envelope", { raw: rawBody.slice(0, 400) });
    return NextResponse.json({ error: "Malformed envelope" }, { status: 400 });
  }

  console.log("[tribute-webhook] parsed", {
    name: envelope.name,
    uuid: envelope.payload.uuid,
    memberExpiresAt: envelope.payload.memberExpiresAt,
  });

  try {
    const outcome = await processTributeEvent(envelope);
    console.log("[tribute-webhook] outcome", outcome);
    // An unknown order is a mapping problem: return 5xx so Tribute retries
    // (the inbox row is FAILED and reprocessable once the order exists).
    const retryable = outcome.status === "unknown_order";
    return NextResponse.json({ ok: !retryable, outcome }, { status: retryable ? 500 : 200 });
  } catch (error) {
    console.error("[tribute-webhook] processing failed:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
