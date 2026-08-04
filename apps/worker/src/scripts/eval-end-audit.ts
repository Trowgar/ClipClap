/**
 * Where did each clip's END come from - the critic, or snap pulling it back?
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-end-audit.ts <fixture>"
 *
 * "The engine ends clips before the payoff" (spec 2026-08-04 3.2) names a
 * symptom, not a layer. snapNodes HONOURS a late end from the critic and only
 * pulls one back past payoffMaxTailSec, so the same visible defect has two
 * possible causes with opposite repairs: a prompt that tells the critic to end
 * early, or a cap that undoes a good answer. This prints both numbers per clip
 * so the plan fixes the layer that is actually binding.
 *
 * Replay only - costs nothing and reproduces the recorded run exactly.
 */
import { loadFixture, runFixture } from "../__tests__/helpers/eval-fixture";

async function main() {
  const [fixtureName] = process.argv.slice(2);
  if (!fixtureName) {
    console.error("usage: eval-end-audit.ts <fixture>");
    process.exit(1);
  }

  const fixture = loadFixture(fixtureName);
  const result = await runFixture(fixture);

  const rows = result.highlights.map((h) => {
    const t = (h as unknown as { telemetry?: Record<string, unknown> }).telemetry;
    return { h, t };
  });

  console.log(`fixture: ${fixtureName}  clips: ${rows.length}`);
  console.log(
    "shipped_range".padEnd(20) +
      "dur".padStart(7) +
      "payoff".padStart(9) +
      "tail".padStart(7) +
      "  title"
  );
  for (const { h } of rows) {
    const payoff = (h as unknown as { payoffAt?: number }).payoffAt;
    const tail = typeof payoff === "number" ? h.end - payoff : NaN;
    console.log(
      `${h.start.toFixed(1)}-${h.end.toFixed(1)}`.padEnd(20) +
        `${(h.end - h.start).toFixed(1)}s`.padStart(7) +
        (typeof payoff === "number" ? payoff.toFixed(1) : "-").padStart(9) +
        (Number.isFinite(tail) ? `${tail.toFixed(1)}s` : "-").padStart(7) +
        `  ${h.title}`
    );
  }

  // The distribution is the finding: a tail clustered exactly at the cap means
  // snap is binding, a tail well under it means the critic chose to stop there
  // and no cap change can help.
  const tails = rows
    .map(({ h }) => {
      const payoff = (h as unknown as { payoffAt?: number }).payoffAt;
      return typeof payoff === "number" ? h.end - payoff : NaN;
    })
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (tails.length > 0) {
    const sum = tails.reduce((a, b) => a + b, 0);
    console.log(
      `\ntail after payoff: min ${tails[0].toFixed(1)}s  median ${tails[
        Math.floor(tails.length / 2)
      ].toFixed(1)}s  max ${tails[tails.length - 1].toFixed(1)}s  mean ${(
        sum / tails.length
      ).toFixed(1)}s`
    );
    console.log(`PAYOFF_MAX_TAIL_SEC is 4 - count at or above it: ${tails.filter((t) => t >= 3.9).length}/${tails.length}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
