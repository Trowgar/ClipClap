/**
 * Replay a stored Tribute webhook event to activate a subscription that a bug
 * dropped, and compensate the user for lost access.
 *
 * Idempotent and non-destructive: it never deletes the stored inbox row, and a
 * second run is a no-op once the user already holds the expected subscription.
 *
 * Usage (inside a worker container, which has tsx + the TRIBUTE_/TELEGRAM_ env):
 *   docker compose exec -w /app/apps/worker worker-render \
 *     npx tsx src/scripts/replay-tribute-event.ts --event-hash=<hash> --dry-run
 *   docker compose exec -w /app/apps/worker worker-render \
 *     npx tsx src/scripts/replay-tribute-event.ts --event-hash=<hash> --apply
 */
import {
  prisma,
  dispatchTributeEvent,
  loadTributeProductIndexFromEnv,
  resolveProductBinding,
  type TributeWebhookEnvelope,
} from "@clipclap/shared";

const COMPENSATION_DAYS = 7;
const DAY_MS = 86_400_000;

function getFlag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const eventHash = getFlag("event-hash");
  const apply = hasFlag("apply");
  const dryRun = hasFlag("dry-run") || !apply;
  if (!eventHash) throw new Error("Missing --event-hash=<hash>");

  const row = await prisma.tributeWebhookEvent.findUnique({ where: { eventHash } });
  if (!row) throw new Error(`No stored event with eventHash=${eventHash}`);

  const envelope = row.payload as unknown as TributeWebhookEnvelope;
  const payload = envelope.payload;
  const telegramId = String(payload.telegram_user_id);
  const index = loadTributeProductIndexFromEnv(process.env);
  const resolved = resolveProductBinding(payload, index);

  const before = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, plan: true, subscriptionStatus: true, currentPeriodEnd: true, tributeSubscriptionId: true },
  });

  const incomingExpiresAt = new Date(payload.expires_at);
  console.log("[replay] event", { eventHash, name: envelope.name, status: row.status, telegramId, subscriptionId: payload.subscription_id });
  console.log("[replay] resolved binding", resolved ?? "UNMAPPED");
  console.log("[replay] user before", before ?? "NO USER ROW");

  if (!resolved) throw new Error("Cannot replay: product binding did not resolve. Fix env config first.");

  // Idempotency guard: already has an equal-or-newer active subscription.
  if (
    before?.subscriptionStatus === "ACTIVE" &&
    before.plan !== "NONE" &&
    before.currentPeriodEnd &&
    before.currentPeriodEnd >= incomingExpiresAt
  ) {
    console.log("Event already applied and user already has the expected subscription. No action taken.");
    return;
  }

  // Refuse to clobber a DIFFERENT active subscription the user may have acquired.
  if (
    before?.subscriptionStatus === "ACTIVE" &&
    before.tributeSubscriptionId &&
    String(before.tributeSubscriptionId) !== String(payload.subscription_id)
  ) {
    console.log(
      `[replay] user already has a different active Tribute subscription (${before.tributeSubscriptionId}); refusing to overwrite. No action taken.`
    );
    return;
  }

  const activationInstant = new Date();
  const compensatedEnd = new Date(activationInstant.getTime() + COMPENSATION_DAYS * DAY_MS);
  console.log("[replay] would set currentPeriodEnd (compensation)", compensatedEnd.toISOString());

  if (dryRun) {
    console.log("[replay] DRY RUN - no writes performed. Re-run with --apply to execute.");
    return;
  }

  // Activate via the real handler path, but with a compensated expires_at so the
  // user's currentPeriodEnd AND the activation notification both reflect the
  // 7-day extension (not the original, shorter payload expiry).
  const compensatedEnvelope: TributeWebhookEnvelope = {
    ...envelope,
    payload: { ...payload, expires_at: compensatedEnd.toISOString() },
  };
  const outcome = await dispatchTributeEvent(compensatedEnvelope, index);
  console.log("[replay] dispatch outcome", outcome);
  if (outcome.status !== "applied") {
    console.log("[replay] activation not performed (non-applied outcome); no compensation written.");
    return;
  }

  await prisma.tributeWebhookEvent.update({
    where: { eventHash },
    data: { status: "APPLIED", outcome: "applied_with_compensation", processedAt: new Date() },
  });

  const after = await prisma.user.findUnique({
    where: { telegramId },
    select: { plan: true, billingCycle: true, subscriptionStatus: true, currentPeriodEnd: true, tributeSubscriptionId: true },
  });
  console.log("[replay] user after", after);
  console.log("[replay] done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[replay] failed:", err);
    process.exit(1);
  });
