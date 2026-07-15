// One-off cutover compensation: the single live channel-model subscriber
// (@Maxkornilo, telegram_user_id 332548055, Starter Weekly) keeps access
// through a manually extended period after the hard cutover. Run once.
// The worker container WORKDIR is /app/apps/worker, so invoke via:
//   docker compose exec -T worker-finalize sh -c "cd /app/apps/worker && npx tsx src/scripts/compensate-maxkornilo.ts --apply"
import { prisma } from "@clipclap/shared";

const TELEGRAM_ID = "332548055";
const EXTEND_DAYS = 7;

async function main() {
  const apply = process.argv.includes("--apply");
  const user = await prisma.user.findUnique({ where: { telegramId: TELEGRAM_ID } });
  if (!user) throw new Error(`user telegramId=${TELEGRAM_ID} not found`);

  const base = user.currentPeriodEnd && user.currentPeriodEnd > new Date() ? user.currentPeriodEnd : new Date();
  const newEnd = new Date(base.getTime() + EXTEND_DAYS * 86_400_000);

  console.log(`[compensate] user=${user.id} plan=${user.plan} status=${user.subscriptionStatus}`);
  console.log(`[compensate] currentPeriodEnd ${user.currentPeriodEnd?.toISOString() ?? "null"} -> ${newEnd.toISOString()}`);

  if (!apply) {
    console.log("[compensate] dry run - pass --apply to persist");
    return;
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { plan: "STARTER", billingCycle: "WEEKLY", subscriptionStatus: "ACTIVE", currentPeriodEnd: newEnd, graceEndsAt: null, dunningSince: null },
  });
  console.log("[compensate] applied");
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
