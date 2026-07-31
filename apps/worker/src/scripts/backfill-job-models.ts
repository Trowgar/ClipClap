/**
 * One-off backfill of Job.criticModel / Job.transcriptionModel.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/backfill-job-models.ts [--apply]"
 *
 * Without --apply it prints what it would do and changes nothing.
 *
 * The critic model is derivable for these rows only because the engine changed
 * at the same time the model did: analyzeEngine RECALL_CRITIC rows ran gpt-5.1,
 * everything earlier ran the legacy single-pass analyzer on gpt-4o-mini. That
 * coincidence is why this script can exist, and the new column is why the next
 * model change will not need one.
 *
 * Rows that already carry a model are left alone: this is a backfill, not a
 * rewrite, and a later run must never overwrite something finalize wrote.
 *
 * BACKFILLED IS NOT THE SAME AS REPRICEABLE, and the difference is six rows
 * versus ten. Measured after this ran: the six RECALL_CRITIC rows recompute
 * from their stored token counts to within 5e-4 of the stored dollar figure -
 * three-decimal rounding, nothing more - so those are genuinely repriceable.
 * The four older rows are not, and the missing model was never what stopped
 * them: they carry ZERO analysis tokens, and their stored analysis dollars came
 * from the fabricated sourceMinutes * 0.00005 fallback that has since been
 * deleted from cost-telemetry.ts. No backfill recovers a count that was never
 * recorded. Do not read "backfilled 10 rows" as "10 rows can be repriced".
 */
import { prisma } from "@clipclap/shared";

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.job.findMany({
    where: { criticModel: null, estimatedTotalCostUsd: { not: null } },
    select: { id: true, analyzeEngine: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (rows.length === 0) {
    console.log("nothing to backfill");
    return;
  }

  let updated = 0;
  for (const row of rows) {
    const critic = row.analyzeEngine === "RECALL_CRITIC" ? "gpt-5.1" : "gpt-4o-mini";
    console.log(
      `${row.id}  ${row.createdAt.toISOString().slice(0, 10)}  ` +
        `engine=${row.analyzeEngine ?? "null"}  -> critic=${critic}, asr=whisper-1`
    );
    if (apply) {
      await prisma.job.update({
        where: { id: row.id },
        data: { criticModel: critic, transcriptionModel: "whisper-1" },
      });
      updated++;
    }
  }

  console.log(
    apply
      ? `backfilled ${updated} row(s)`
      : `${rows.length} row(s) would be backfilled - re-run with --apply`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
