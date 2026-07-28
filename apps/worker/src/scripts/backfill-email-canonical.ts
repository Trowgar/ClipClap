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

  // Already-filled rows are read FIRST, and the unfilled ones after. Nothing
  // else writes emailCanonical today, but registration will once signup-side
  // canonicalization lands - and in the other order a row filled between the
  // two queries is read as unfilled here and then collides with its own new
  // value, which reports a correctly-filled account as a collision.
  const taken = new Set<string>();
  const existing = await prisma.user.findMany({
    where: { emailCanonical: { not: null } },
    select: { emailCanonical: true },
  });
  for (const row of existing) {
    if (row.emailCanonical) taken.add(row.emailCanonical);
  }

  const users = await prisma.user.findMany({
    where: { email: { not: null }, emailCanonical: null },
    select: { id: true, email: true },
    // id breaks the tie: createdAt is timestamp(3), so two accounts made in the
    // same millisecond would otherwise pick a different winner on each run.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  let filled = 0;
  const collisions: string[] = [];
  const unparseable: string[] = [];

  for (const user of users) {
    const canonical = canonicalizeEmail(user.email!);
    if (!canonical) {
      // Named, not silently skipped. In a backfill whose whole job is
      // establishing identity, the addresses that have no identity are exactly
      // the ones a human has to look at - and a bare "filled 35 of 36" gives
      // them no id, no address and no reason.
      unparseable.push(`${user.id} (${user.email})`);
      continue;
    }
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
    // Claim the value in the dry run too, or both halves of a collision inside
    // this batch pass the check above and the preview overstates the result -
    // promising two fills where --apply delivers one.
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
  if (unparseable.length > 0) {
    console.log(
      `[backfill-email-canonical] left null, address does not canonicalize:\n  ${unparseable.join("\n  ")}`
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
