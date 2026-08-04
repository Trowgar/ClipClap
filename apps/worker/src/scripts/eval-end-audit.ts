/**
 * Where did each clip's END come from - the critic, or snap pulling it back?
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-end-audit.ts [--variant NAME] <fixture>"
 *
 * `--variant NAME` audits a variant's recording instead of the engine default,
 * which is the only way to see the end-extension stage at all: the harness builds
 * every config from an empty env (eval-fixture.ts), so END_EXTENSION in the
 * environment cannot reach a replay and the stage is dark under base by
 * construction. Base stays the default here so the pre-change baseline is still
 * one word away.
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
import {
  BASE_VARIANT,
  loadFixture,
  parseVariantArgs,
  runFixtureVariant,
} from "../__tests__/helpers/eval-fixture";

async function main() {
  // parseVariantArgs, not a hand-rolled argv read: it is the same parse
  // eval-topup and eval-bless use, and it hard-errors on "--variant=NAME" and on
  // a typo'd flag rather than silently auditing base under a variant's name.
  const { variant, cases } = parseVariantArgs(process.argv.slice(2));
  const [fixtureName] = cases;
  if (!fixtureName || !variant) {
    console.error("usage: eval-end-audit.ts [--variant NAME] <fixture>");
    process.exit(1);
  }

  const fixture = loadFixture(fixtureName);
  const result = await runFixtureVariant(fixture, variant);

  const rows = result.highlights.map((h) => {
    const t = (h as unknown as { telemetry?: Record<string, unknown> }).telemetry;
    return { h, t };
  });

  console.log(
    `fixture: ${fixtureName}${variant === BASE_VARIANT ? "" : `[${variant}]`}  ` +
      `clips: ${rows.length}`
  );
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

  // The tail distribution says WHERE the ends landed; this says why. Without it
  // "the end did not move" and "the end was never offered anywhere to move to"
  // read identically off the table above, and they argue for opposite repairs -
  // a prompt edit against a window widening. `skipped` separates a stage that
  // declined from a stage that never ran, and `refusedBy` names which gate a
  // model's proposal died on.
  const ext = (result.telemetry as Record<string, unknown>).endExtension;
  if (ext) console.log(`\nend-extension telemetry: ${JSON.stringify(ext)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
