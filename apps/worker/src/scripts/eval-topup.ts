/**
 * Tops up an eval fixture with ONLY the LLM calls the current engine makes that
 * the recording does not already hold.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-topup.ts [case-name ...]"
 *
 * WHY THIS EXISTS, next to eval-record.ts
 * --------------------------------------
 * A deterministic change UPSTREAM of an LLM call changes what that call is
 * asked, so its requestKey moves and replay dies on "unrecorded request". The
 * teaser filter is the first such change: dropping a candidate before the critic
 * re-partitions `candidates.slice(i, i+6)`, so batches downstream of the drop
 * are all new prompts.
 *
 * eval-record.ts is the wrong instrument for that. It re-runs EVERYTHING,
 * including the scanner at temperature 0.4, so the fixture comes back with a
 * different candidate set and the snapshot diff no longer isolates the change
 * under review - it mixes it with fresh sampling noise. The diff IS the review
 * artefact (see eval-bless.ts), so destroying it to fix a key mismatch trades
 * away the only evidence a human reads.
 *
 * This script instead replays every response already on disk and calls the real
 * API only for keys that are genuinely absent. Existing recordings are
 * IMMUTABLE: an already-present key is never re-requested and never rewritten,
 * so the untouched parts of the run stay bit-identical and the resulting
 * snapshot diff shows exactly one thing - the effect of the change.
 *
 * It does NOT write snapshot.json. Blessing stays with eval-bless.ts, where the
 * diff gets printed before anything is overwritten. It does not touch the BASE
 * fingerprint in meta.json either: that fingerprint describes what the model is
 * asked and how it may answer, and topping up does not move it - if it HAS
 * moved, the run below refuses, because then the old responses really are stale
 * and a full re-record is the honest fix.
 *
 * VARIANTS
 * --------
 * `--variant NAME` records under a variant's config (see eval-fixture.ts) rather
 * than the engine default. That is the same job: the scanner's request keys do
 * not move, so its answers are replayed byte for byte and only the critic and
 * finalizer keys - which carry the model name in their hash - are genuinely
 * absent and get bought. That is precisely why the diff between two variants is
 * a statement about the judge and nothing else.
 *
 * A variant run DOES write meta.json, under `variants[NAME].engine`: the base
 * fingerprint says nothing about a variant, and runFixtureVariant refuses to
 * replay a variant that has none.
 *
 * Costs real API calls, but only for the delta. Run it deliberately.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { requestKey } from "../__tests__/helpers/replay-client";
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  variantConfig,
} from "../__tests__/helpers/eval-fixture";
import { compareFingerprints, computeFingerprint } from "../__tests__/helpers/eval-fingerprint";

const OUTCOME_KEYS = new Set(["refusal", "truncated"]);

export const USAGE = "usage: eval-topup.ts [--variant NAME] <case-name> [case-name ...]";

/**
 * Splits argv into a variant name and the case names.
 *
 * Exported because it is fiddly enough to be worth a test that costs nothing:
 * it drops every `-`-prefixed token AND the token that follows `--variant`, and
 * getting either half wrong silently drops a fixture or feeds the variant name
 * in as a case - both of which only surface as a live, paid API call.
 *
 * `variant` is undefined when `--variant` is the last token, which the caller
 * must treat as a usage error rather than as the base variant.
 */
export function parseArgs(argv: string[]): { variant: string | undefined; cases: string[] } {
  const flagAt = argv.indexOf("--variant");
  const variant = flagAt === -1 ? BASE_VARIANT : argv[flagAt + 1];
  const cases = argv.filter(
    (a, i) => !a.startsWith("-") && (flagAt === -1 || i !== flagAt + 1)
  );
  return { variant, cases };
}

async function main() {
  const { variant, cases } = parseArgs(process.argv.slice(2));
  if (cases.length === 0 || !variant) {
    console.error(USAGE);
    process.exit(1);
  }

  // Throws on an unknown variant, which is the right moment to find out - before
  // any paid call has been made.
  const cfg = variantConfig(variant);
  const current = computeFingerprint(cfg);
  console.log(
    `variant: ${variant} (critic=${cfg.criticModel}, finalizer=${cfg.finalizerModel})`
  );
  const real = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  for (const name of cases) {
    const fixture = loadFixture(name);
    // Compare against THIS variant's recording, not the base one. A mismatch
    // against the base is expected and is the whole point; a mismatch against
    // the variant's own previous recording means that recording is stale.
    const recorded = fixture.fingerprints[variant] ?? null;
    if (recorded) {
      const { mismatches } = compareFingerprints(recorded, current);
      if (mismatches.length > 0) {
        console.log(`${name}: REFUSED - recorded under a different engine config`);
        for (const m of mismatches) console.log(`    - ${m}`);
        console.log("    Topping up would mix answers from two configs. Re-record instead.");
        process.exitCode = 1;
        continue;
      }
    }

    const existing: Record<string, string> = { ...fixture.responses };
    const added: Record<string, string> = {};
    const client = {
      chat: {
        completions: {
          create: async (body: {
            model: string;
            messages: Array<{ role: string; content: string }>;
          }) => {
            const key = requestKey({
              model: body.model,
              system: body.messages.find((m) => m.role === "system")?.content ?? "",
              user: body.messages.find((m) => m.role === "user")?.content ?? "",
            });
            const recorded = existing[key];
            if (recorded !== undefined) {
              // Serve from disk, byte for byte, exactly as replay-client would.
              const outcome = readOutcome(recorded);
              return {
                choices: [
                  {
                    message: {
                      content: outcome ? null : recorded,
                      refusal: outcome === "refusal" ? "recorded refusal" : null,
                    },
                    finish_reason: outcome === "truncated" ? "length" : "stop",
                  },
                ],
                usage: { prompt_tokens: 0, completion_tokens: 0 },
              };
            }
            const response = await real.chat.completions.create(body as never);
            const completion = response as {
              choices: Array<{
                message: { content: string | null; refusal?: string | null };
                finish_reason?: string;
              }>;
            };
            const choice = completion.choices[0];
            const content = choice?.message?.content;
            let value: string;
            if (choice?.message?.refusal) value = JSON.stringify({ __outcome: "refusal" });
            else if (choice?.finish_reason === "length" || !content)
              value = JSON.stringify({ __outcome: "truncated" });
            else value = content;
            existing[key] = value;
            added[key] = value;
            console.log(`  + recorded ${key} (${body.model}, ${value.length} chars)`);
            return response;
          },
        },
      },
    } as unknown as OpenAI;

    const result = await analyzeHighlightsV2(fixture.transcript, { client, cfg });
    const count = Object.keys(added).length;
    if (count === 0) {
      console.log(`${name}: complete already - nothing to record`);
      continue;
    }
    const path = join(FIXTURES_DIR, name, "responses.json");
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
    writeFileSync(path, `${JSON.stringify({ ...onDisk, ...added }, null, 2)}\n`, "utf-8");
    console.log(
      `${name}: +${count} response(s) -> ${path} (${Object.keys(onDisk).length + count} total), ` +
        `${result.highlights.length} clips`
    );
    // A non-base variant needs its own provenance in meta.json, or the snapshot
    // test cannot tell "recorded under this config" from "never recorded" - and
    // runFixtureVariant refuses to replay a variant with no fingerprint at all.
    // Only on the path that actually recorded something: the early `continue`
    // above means a no-op run never rewrites meta.json.
    if (variant !== BASE_VARIANT) {
      const metaPath = join(FIXTURES_DIR, name, "meta.json");
      // Tolerate a fixture with no meta.json: the responses are already written
      // by this point, and crashing here would strand paid recordings without
      // the provenance that makes them replayable.
      const meta = (
        existsSync(metaPath)
          ? JSON.parse(readFileSync(metaPath, "utf-8"))
          : {}
      ) as { variants?: Record<string, unknown> };
      meta.variants = {
        ...(meta.variants ?? {}),
        [variant]: { recordedAt: new Date().toISOString(), engine: current },
      };
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
      console.log(`  wrote variant fingerprint to ${metaPath}`);
    }
    console.log("  Now run eval-bless.ts and READ THE DIFF before committing.");
  }
  process.exit(process.exitCode ?? 0);
}

function readOutcome(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { __outcome?: unknown };
    if (typeof parsed?.__outcome === "string" && OUTCOME_KEYS.has(parsed.__outcome)) {
      return parsed.__outcome;
    }
  } catch {
    /* a normal content payload */
  }
  return null;
}

// Only when run as a script. parseArgs above is imported by a test, and an
// unguarded main() would run on that import - parsing vitest's own argv and
// then making real, paid API calls from inside the test suite.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main();
}
