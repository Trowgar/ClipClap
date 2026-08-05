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
 * A variant run DOES write meta.json, under `variants[NAME].engine`, and writes
 * it whether or not anything was recorded: the base fingerprint says nothing
 * about a variant, runFixtureVariant refuses to replay a variant that has none,
 * and a variant CAN legitimately need no new calls (see the unconditional-write
 * comment in main). The write is idempotent, so gating it only ever loses.
 *
 * Costs real API calls, but only for the delta. Run it deliberately.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { analyzeHighlightsV2 } from "../analyze-v2";
import type { V2Result } from "../analyze-v2/types";
import { requestKey } from "../__tests__/helpers/replay-client";
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  parseVariantArgs,
  variantConfig,
} from "../__tests__/helpers/eval-fixture";
import { compareFingerprints, computeFingerprint } from "../__tests__/helpers/eval-fingerprint";

const OUTCOME_KEYS = new Set(["refusal", "truncated"]);

async function main() {
  const { variant, cases } = parseVariantArgs(process.argv.slice(2));
  if (cases.length === 0 || !variant) {
    console.error("usage: eval-topup.ts [--variant NAME] <case-name> [case-name ...]");
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
      // `stale` counts too, and it is the half a rename shows up in: the old
      // knob's recorded value stops being checkable while the new name only
      // warns, so reading `mismatches` alone would top up onto a recording
      // nobody can prove matches (helpers/eval-fingerprint.ts).
      const { mismatches, stale } = compareFingerprints(recorded, current);
      if (mismatches.length > 0 || stale.length > 0) {
        console.log(`${name}: REFUSED - recorded under a different engine config`);
        for (const m of mismatches) console.log(`    - ${m}`);
        for (const key of stale) console.log(`    - ${key}: recorded, but no longer a knob`);
        console.log("    Topping up would mix answers from two configs. Re-record instead.");
        process.exitCode = 1;
        continue;
      }
    }

    const existing: Record<string, string> = { ...fixture.responses };
    const added: Record<string, string> = {};
    // Degradation counters. callJsonSchema swallows API failures and returns
    // {ok:false}: the scanner turns that into a dead window, the critic and the
    // finalizer both retry on the FALLBACK model, and the run then reports
    // success. Nothing downstream can tell a short recording from a complete
    // one, so the observations have to be made here, at the only point that
    // sees every request - see the DEGRADED block after the run.
    let apiErrors = 0;
    let nonContent = 0;
    const modelsCalled = new Set<string>();
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
            modelsCalled.add(body.model);
            let response;
            try {
              response = await real.chat.completions.create(body as never);
            } catch (err) {
              // Counted, then re-thrown unchanged: callJsonSchema owns the retry
              // policy and must keep seeing exactly what the API did.
              apiErrors += 1;
              throw err;
            }
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
            if (value !== content) nonContent += 1;
            existing[key] = value;
            added[key] = value;
            console.log(`  + recorded ${key} (${body.model}, ${value.length} chars)`);
            return response;
          },
        },
      },
    } as unknown as OpenAI;

    const responsesPath = join(FIXTURES_DIR, name, "responses.json");
    const metaPath = join(FIXTURES_DIR, name, "meta.json");

    let result: V2Result | undefined;
    try {
      result = await analyzeHighlightsV2(fixture.transcript, { client, cfg });
    } catch (err) {
      process.exitCode = 1;
      console.log(`${name}: ERROR - ${(err as Error).message}`);
    } finally {
      // EVERYTHING PAID FOR IS PERSISTED HERE, on the way out, crash or not.
      // The recordings accumulate in memory during the run, so without this a
      // failure at 80% would write nothing at all - a total loss, not a partial
      // one - and the next attempt would pay for the same 80% again.
      //
      // meta.json goes FIRST, deliberately. The two writes cannot be made
      // atomic, so the question is only which half-written state to prefer:
      //   fingerprint, no responses -> next replay finds unrecorded requests,
      //                                reports the fixture stale, and topping up
      //                                repairs it. Recoverable.
      //   responses, no fingerprint -> runFixtureVariant refuses the variant
      //                                outright, and a re-run of THIS script
      //                                finds every key present. Was a permanent
      //                                dead end before the unconditional write
      //                                below, and is still the worse order.
      if (variant !== BASE_VARIANT) writeVariantFingerprint(metaPath, variant, current);
      if (Object.keys(added).length > 0) flushResponses(responsesPath, added);
    }
    if (!result) continue;

    // A non-base variant's fingerprint is written UNCONDITIONALLY above, not
    // only when something was recorded. Two reachable states have a complete set
    // of responses and no fingerprint, and in both of them "record nothing" was
    // the old answer, which left the fixture unreplayable forever while this
    // script insisted it was complete:
    //   - an interrupted earlier run that got the responses out but died before
    //     the provenance (the very window the write order above narrows);
    //   - a control or duplicate variant, e.g. one declaring the default
    //     criticModel to prove the harness is deterministic. Its request keys
    //     are identical to base, so every key is already on disk and there is
    //     nothing to buy - but it still needs provenance to be replayable.
    // The write is idempotent and costs nothing, so there is no reason to gate it.
    const count = Object.keys(added).length;
    if (count === 0) {
      // "complete already" is only true if it is also replayable. Saying it of a
      // fixture that was missing its provenance would describe a repair as a
      // no-op.
      console.log(
        variant === BASE_VARIANT || recorded
          ? `${name}: complete already - nothing to record`
          : `${name}: no new calls needed, but variant "${variant}" had no fingerprint - ` +
              `wrote one. The responses were complete yet unreplayable; they are replayable now.`
      );
      reportDegradation(name, result, { apiErrors, nonContent, modelsCalled, cfg });
      continue;
    }
    const total = Object.keys(existing).length;
    console.log(
      `${name}: +${count} response(s) -> ${responsesPath} (${total} total), ` +
        `${result.highlights.length} clips`
    );
    if (variant !== BASE_VARIANT) console.log(`  wrote variant fingerprint to ${metaPath}`);
    // What this run cost, and it is exact rather than an estimate: a key served
    // from disk is billed 0/0 by the stub above, so every token here belongs to
    // a call that was really made. Printed because the script's own header says
    // it spends money and, until 2026-08-04, it was the one fact it would not
    // say - the first end-extension recording had to be costed afterwards from
    // prompt sizes, and could only ever be bounded.
    for (const [model, u] of Object.entries(result.usage.byModel)) {
      if (u.inputTokens === 0 && u.outputTokens === 0) continue;
      console.log(
        `  billed ${model}: ${u.inputTokens} in, ${u.outputTokens} out ` +
          `(${u.requests} request(s), of which ${count} were new)`
      );
    }
    reportDegradation(name, result, { apiErrors, nonContent, modelsCalled, cfg });
    // Naming the variant matters: someone who just paid to record luna and then
    // copies a bare "eval-bless.ts" blesses BASE, and the diff they read is not
    // the one they bought.
    console.log(
      `  Now run eval-bless.ts${variant === BASE_VARIANT ? "" : ` --variant ${variant}`} ` +
        `and READ THE DIFF before committing.`
    );
  }
  process.exit(process.exitCode ?? 0);
}

/** Merges the run's new responses into whatever is on disk. Never rewrites a key. */
function flushResponses(path: string, added: Record<string, string>): void {
  const onDisk = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  writeFileSync(path, `${JSON.stringify({ ...onDisk, ...added }, null, 2)}\n`, "utf-8");
}

/**
 * Records which config a variant's responses were produced under.
 *
 * Tolerates a missing meta.json: this runs on the crash path too, and throwing
 * here would strand paid recordings without the provenance that makes them
 * replayable - the exact failure the ordering above exists to prevent.
 */
function writeVariantFingerprint(
  metaPath: string,
  variant: string,
  engine: unknown
): void {
  const meta = (
    existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : {}
  ) as { variants?: Record<string, unknown> };
  meta.variants = {
    ...(meta.variants ?? {}),
    [variant]: { recordedAt: new Date().toISOString(), engine },
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

/**
 * Says so when a run that reported success was actually short.
 *
 * A hard API error inside callJsonSchema never reaches this script as a throw:
 * the scanner books it as a dead window, and BOTH the critic and the finalizer
 * silently retry on cfg.criticModelFallback. So a rate-limited Luna run can
 * finish, print "+N response(s)", and have recorded gpt-5-mini's opinions under
 * luna's name - which is the one thing a model comparison must never contain.
 *
 * Everything below is observed, not inferred: three counters from the request
 * stub this script already owns, and two fields the engine already publishes.
 */
function reportDegradation(
  name: string,
  result: V2Result,
  seen: {
    apiErrors: number;
    nonContent: number;
    modelsCalled: Set<string>;
    cfg: { scanModel: string; criticModel: string; finalizerModel: string };
  }
): void {
  const t = result.telemetry as Record<string, unknown>;
  const expected = new Set([seen.cfg.scanModel, seen.cfg.criticModel, seen.cfg.finalizerModel]);
  const offVariant = [...seen.modelsCalled].filter((m) => !expected.has(m));
  const windowsFailed = Number(t.windowsFailed ?? 0);
  const reasons: string[] = [];
  if (offVariant.length > 0) {
    reasons.push(
      `answers were recorded from ${offVariant.join(", ")}, which this variant does not ` +
        `declare - the engine fell back mid-run, so part of this recording is NOT the ` +
        `model under test`
    );
  }
  if (t.fallbackModelUsed === true) reasons.push("critic reported fallbackModelUsed");
  if (seen.apiErrors > 0) reasons.push(`${seen.apiErrors} API call(s) threw`);
  if (seen.nonContent > 0) {
    reasons.push(`${seen.nonContent} newly recorded response(s) were refusals/truncations`);
  }
  if (reasons.length === 0) return;
  console.log(`  DEGRADED - this recording is not a clean one:`);
  for (const r of reasons) console.log(`    - ${r}`);
  // Context, never a trigger. A recorded refusal replays as a failed window
  // forever, so windowsFailed mixes this run's losses with the recording's own
  // history - it would cry degradation over a fixture that is faithfully
  // replaying exactly what it was always meant to.
  if (windowsFailed > 0) {
    console.log(
      `    (context: ${windowsFailed}/${Number(t.windowsTotal ?? 0)} scanner window(s) came ` +
        `back unusable, which includes any the recording already held)`
    );
  }
  console.log(
    `    Re-run to top up what is missing. Do NOT bless or compare this fixture until a ` +
      `run comes back without this block.`
  );
  process.exitCode = 1;
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

// Only when run as a script. This file spends money, so any future import of it
// - a test reaching for a helper, a script reusing a piece - must not be able to
// start a recording run by accident. typeof-guarded because tsx loads this as
// CJS while vitest transforms it to ESM, where bare require/module would throw.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  // An argv mistake now throws (see parseVariantArgs), and a raw unhandled
  // rejection is a poor way to tell an operator they nearly recorded the wrong
  // variant. Exit code stays non-zero.
  main().catch((err: unknown) => {
    console.error(`eval-topup: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
