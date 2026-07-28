/**
 * Fills User.emailCanonical for accounts that predate the column.
 *
 * Collision-safe on purpose: prod had zero collisions across all 36 addresses
 * on 2026-07-28, but this runs against whatever the database looks like at
 * deploy time. The oldest account keeps the canonical form; later duplicates
 * are left null rather than failing the run, so a collision becomes a row to
 * look at instead of a broken deploy.
 *
 * Idempotent: rows that already have a value are not re-read, so re-running
 * after fixing a collision by hand only fills what is still null.
 *
 * Usage (inside the worker container, after `npm run build -w @clipclap/shared`
 * and `prisma generate` - the worker resolves @clipclap/shared to dist, and
 * emailCanonical does not exist on the client until it is regenerated):
 *   docker compose exec -T worker-finalize sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/backfill-email-canonical.ts"
 *   docker compose exec -T worker-finalize sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/backfill-email-canonical.ts --apply"
 */
import { canonicalizeEmail, prisma } from "@clipclap/shared";

async function main() {
  const apply = process.argv.includes("--apply");

  const users = await prisma.user.findMany({
    where: { email: { not: null }, emailCanonical: null },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  });

  const taken = new Set<string>();
  const existing = await prisma.user.findMany({
    where: { emailCanonical: { not: null } },
    select: { emailCanonical: true },
  });
  for (const row of existing) {
    if (row.emailCanonical) taken.add(row.emailCanonical);
  }

  let filled = 0;
  const collisions: string[] = [];

  for (const user of users) {
    const canonical = canonicalizeEmail(user.email!);
    if (!canonical) continue;
    if (taken.has(canonical)) {
      collisions.push(`${user.id} (${user.email}) -> ${canonical}`);
      continue;
    }
    if (apply) {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailCanonical: canonical },
      });
    }
    // Claim the value in the dry run too, or a genuine collision inside this
    // batch reads as fillable and the preview understates the real result.
    taken.add(canonical);
    filled++;
  }

  console.log(
    `[backfill-email-canonical] ${apply ? "filled" : "would fill"} ${filled} of ${users.length}`
  );
  if (collisions.length > 0) {
    console.log(
      `[backfill-email-canonical] left null for collisions:\n  ${collisions.join("\n  ")}`
    );
  }
  if (!apply) {
    console.log("[backfill-email-canonical] dry run - pass --apply to persist");
  }
}

// Disconnect before exiting rather than in a .finally after process.exit,
// which never runs. The explicit exit stays because importing @clipclap/shared
// can leave queue handles open and hang the process.
main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
