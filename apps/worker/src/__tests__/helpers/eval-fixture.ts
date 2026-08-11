import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { TranscriptionResult } from "@clipclap/shared";
import { analyzeHighlightsV2 } from "../../analyze-v2";
import { loadAnalyzeConfig, type AnalyzeConfig } from "../../analyze-v2/config";
import type { V2Result } from "../../analyze-v2/types";
import { createReplayClient } from "./replay-client";
import {
  assertFingerprintMatches,
  computeFingerprint,
  type EngineFingerprint,
} from "./eval-fingerprint";

export const FIXTURES_DIR = join(__dirname, "..", "fixtures", "eval");

/** The variant that IS the current engine default. Its snapshot is snapshot.json. */
export const BASE_VARIANT = "base";

/**
 * Which config knobs a variant is allowed to move.
 *
 * Deliberately narrow, and narrow along a particular line: a variant may change
 * WHO answers, or WHICH stages run, and never what an existing stage is asked.
 * Widening it to windowing or batching would rewrite the scanner and critic
 * prompts, move every request key, and turn the diff back into the mixed signal
 * this whole mechanism exists to avoid.
 *
 * `endExtensionEnabled` is the second kind, admitted 2026-08-04 because without
 * it the end-extension stage could not be measured at all. Every config in this
 * harness is built from `loadAnalyzeConfig({})` - an explicitly EMPTY env, so
 * that a stray variable in an operator's shell can never change what a replay
 * means - which left `END_EXTENSION=on` with no door into a fixture run. The
 * stage shipped dark, all four fixtures replayed green with it dark, and nothing
 * in the repo could make it run. `docker compose exec -e END_EXTENSION=on` reads
 * as though it would and does not.
 *
 * It preserves comparability, which is the property this list actually protects.
 * Turning the stage on ADDS a prompt; it does not edit one. Every scanner and
 * critic request key stays byte-identical, so the candidates and the verdicts
 * arriving at selection are the ones base judged, and anything that differs
 * downstream is the stage and nothing else.
 *
 * The finalizer's keys DO move, because its prompt renders the clips it is
 * handed and those clips are now wider. That is the measurement arriving rather
 * than a leak: an extension the finalizer never saw would be an extension
 * nothing judged, and the finalizer holds the veto. It is also why topping this
 * variant up buys more than the single call the stage itself makes.
 *
 * `endExtensionWindowSec` is deliberately NOT here, and it is the one addition
 * that would look natural next to the boolean. It is a tuning door: the question
 * the variant exists to answer is whether ends move toward the scout consensus
 * at the window the stage was documented with, and an answer obtained by moving
 * the window is not an answer to it.
 *
 * `arcAuditEnabled`, added 2026-08-10 for the same reason `endExtensionEnabled`
 * was: without a door into it, no config this harness can build would ever
 * differ on the key, so the fingerprint check built to catch a live stage
 * replaying against a dark recording could never fire (see
 * eval-variants.test.ts, "makes the arc-audit fingerprint key able to fire").
 * `startExtensionWindowSec` and `arcAuditBatchSize` are deliberately NOT here -
 * the same tuning-door refusal as `endExtensionWindowSec` above.
 *
 * `startExtensionEnabled` (task 3), same door for the same reason:
 * extendClipStarts makes no request of its own, so without a variant that can
 * set it, no config this harness builds could ever differ on the key and the
 * fingerprint entry it needs (eval-fingerprint.ts) could never fire either.
 * The "start-extension" variant sets it ALONGSIDE `arcAuditEnabled` - the
 * stage no-ops without a detector to feed it - which is also why a variant is
 * allowed to move more than one whitelisted key at once (gpt51 already does,
 * for `criticModel` and `finalizerModel` together).
 *
 * `endExtensionHintsEnabled` (task 4), same door, same reason as
 * `endExtensionEnabled` originally: without it, no config this harness builds
 * could ever set the hint-driven half of end-extension, so no fixture could
 * ever be recorded or replayed with it live. The "arc-exit-hints" variant sets
 * it ALONGSIDE `arcAuditEnabled` (the stage no-ops on the hint side without a
 * detector to feed it, start-extension's own precedent) and deliberately
 * WITHOUT `endExtensionEnabled` - the two end-extension switches are the thing
 * under test being separable, so a variant that turned both on at once would
 * prove nothing about whether the hint-driven path stands on its own.
 *
 * `longClipsEnabled` (task 5), the same door for the same reason as every
 * *Enabled key above: without it, no config this harness builds could ever
 * differ on the key, so a "long-clips" recording could never exist and the
 * fingerprint entry built to catch a live long-clip run replaying against a
 * dark recording could never fire. The "long-clips" variant sets it ALONGSIDE
 * `arcAuditEnabled`, start-extension's own precedent - nothing can ever be
 * blessed without a detector to bless it, so the flag alone would only ever
 * exercise the unconditional-compression fallback, not the policy this task
 * is actually about. `longClipMaxSec` is NOT here - a tuning door, the same
 * refusal as `startExtensionWindowSec`/`endExtensionWindowSec`.
 */
export type VariantOverrides = Partial<
  Pick<
    AnalyzeConfig,
    | "criticModel"
    | "finalizerModel"
    | "criticModelFallback"
    | "endExtensionEnabled"
    | "arcAuditEnabled"
    | "startExtensionEnabled"
    | "endExtensionHintsEnabled"
    | "longClipsEnabled"
  >
>;

/** The only knobs a variant may move. See VariantOverrides for where the line is. */
export const VARIANT_OVERRIDE_KEYS = [
  "criticModel",
  "finalizerModel",
  "criticModelFallback",
  "endExtensionEnabled",
  "arcAuditEnabled",
  "startExtensionEnabled",
  "endExtensionHintsEnabled",
  "longClipsEnabled",
] as const satisfies ReadonlyArray<keyof VariantOverrides>;

/**
 * Reads variants.json and REJECTS any knob outside the whitelist.
 *
 * The type above is erased at runtime, so without this check the narrowness is
 * only ever as good as whichever knobs a test happened to name - and the knobs
 * most worth blocking (scanWindowSec, criticMaxCandidates, criticBatchSize) are
 * exactly the ones nobody thinks to assert on. Refusing to load is the
 * conservative move: the alternative failure is a variant that quietly changes
 * what the model is asked and still presents as a working model comparison.
 *
 * `dir` exists so a test can validate a throwaway variants.json without writing
 * to the shared fixtures tree that every other test file reads concurrently.
 */
export function loadVariantDefs(dir: string = FIXTURES_DIR): Record<string, VariantOverrides> {
  const path = join(dir, "variants.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
    string,
    Record<string, unknown>
  >;
  const allowed: readonly string[] = VARIANT_OVERRIDE_KEYS;
  for (const [name, overrides] of Object.entries(parsed)) {
    for (const key of Object.keys(overrides)) {
      if (!allowed.includes(key)) {
        throw new Error(
          `variant "${name}" in ${path} overrides "${key}", which is not allowed. A variant may ` +
            `only change WHO answers or WHICH stages run ` +
            `(${VARIANT_OVERRIDE_KEYS.join(", ")}), never what an existing stage is asked - ` +
            `anything else rewrites the prompts, moves every request key, and makes the diff ` +
            `between variants mix the change under review with a second changed knob, while ` +
            `still looking like a clean comparison.`
        );
      }
    }
  }
  return parsed as Record<string, VariantOverrides>;
}

/** Base first, then declared variants in a stable order. */
export function variantNames(dir: string = FIXTURES_DIR): string[] {
  return [BASE_VARIANT, ...Object.keys(loadVariantDefs(dir)).sort()];
}

export function snapshotFileName(variant: string): string {
  return variant === BASE_VARIANT ? "snapshot.json" : `snapshot.${variant}.json`;
}

/** Every option these scripts accept. Anything else `-`-prefixed is rejected. */
const KNOWN_FLAGS = new Set(["--variant"]);

/**
 * Splits a script's argv into a variant name and the fixture names.
 *
 * Lives here, not in either script, because eval-topup and eval-bless need the
 * SAME parse and the first draft of this code carried an off-by-one that only
 * existed twice because the code did.
 *
 * EVERY failure mode here is silent by default, which is why it throws so
 * readily. An unparsed flag does not stop the run, it changes which variant the
 * run is about, and both scripts then report success:
 *
 *   --variant=luna   `indexOf("--variant")` does not match it, so the whole token
 *                    would be discarded as an option and the run would proceed as
 *                    BASE. eval-bless replays base, diffs base, prints
 *                    "unchanged"; eval-topup finds every base key on disk and
 *                    prints "complete already". Nothing errors, nothing is spent,
 *                    and the operator concludes luna was recorded or blessed.
 *   --varient luna   a typo'd flag would be discarded the same way, and "luna"
 *                    would arrive as a FIXTURE name.
 *
 * So unknown options are a hard error, and the equals-form gets named in the
 * message because it is the standard spelling everywhere else and the one an
 * operator will reach for.
 *
 * `variant` is undefined when `--variant` is the last token. Callers must treat
 * that as a usage error rather than falling back to base, or a truncated command
 * line would quietly record or bless the wrong thing.
 */
export function parseVariantArgs(argv: string[]): {
  variant: string | undefined;
  cases: string[];
} {
  // A repeat is ambiguous and both readings are wrong: indexOf takes the first
  // name, and the second one is not even an option token, so it would arrive as
  // a fixture name. One run records under one config and writes one snapshot
  // file, so there is no honest interpretation of two - refuse rather than pick.
  if (argv.filter((a) => a === "--variant").length > 1) {
    throw new Error(
      `"--variant" given more than once. A run records under exactly one config ` +
        `and writes exactly one snapshot file, so there is no meaning to pick from - ` +
        `run the script once per variant.`
    );
  }

  const flagAt = argv.indexOf("--variant");
  // indexOf returns -1 when absent, so `flagAt + 1` is 0 - the guard below stops
  // that from excluding the FIRST case name on every flagless invocation.
  const variant = flagAt === -1 ? BASE_VARIANT : argv[flagAt + 1];
  const cases: string[] = [];
  for (const [i, a] of argv.entries()) {
    if (flagAt !== -1 && i === flagAt + 1) continue;
    if (a.startsWith("-")) {
      if (!KNOWN_FLAGS.has(a)) {
        throw new Error(
          `unknown option "${a}". Did you mean "--variant NAME"? ` +
            `Note the name is a SEPARATE argument - "--variant=NAME" is not supported ` +
            `and would silently run against the base variant.`
        );
      }
      continue;
    }
    cases.push(a);
  }
  return { variant, cases };
}

/** Effective engine config for a variant: the env-blind defaults plus overrides. */
export function variantConfig(variant: string): AnalyzeConfig {
  const base: AnalyzeConfig = {
    ...loadAnalyzeConfig({}),
    engine: "recall-critic",
  };
  if (variant === BASE_VARIANT) return base;
  const defs = loadVariantDefs();
  const overrides = defs[variant];
  if (!overrides) {
    throw new Error(
      `unknown variant "${variant}" - declare it in ${join(FIXTURES_DIR, "variants.json")}`
    );
  }
  return { ...base, ...overrides };
}

export interface EvalShape {
  count: number;
  tier: string | null;
  clips: Array<{ range: string; score: number; title: string }>;
  dropReasons: Record<string, number>;
  /**
   * Copy the critic grounded outside its own range. Not a drop - the clip ships
   * with regrounded copy - but recorded here anyway, because this is a direct
   * reading of how well the critic prompt keeps its own bookkeeping, and the one
   * time it moved sharply (ca8dfec, 2 -> 9) the snapshot diff is what showed it.
   * Absent, not `{}`, when nothing drifted: a block that appears in every file
   * is a block readers stop seeing.
   */
  outOfRange?: Record<string, number>;
  noClipsReason?: string;
}

/** Stable, human-readable reduction of an engine run. Ranges are rounded to
 *  0.1s: below that, floating-point noise would make the snapshot flaky. */
export function toShape(result: V2Result): EvalShape {
  const t = result.telemetry as Record<string, unknown>;
  const shape: EvalShape = {
    count: result.highlights.length,
    tier: (t.tier as string) ?? null,
    clips: result.highlights.map((h) => ({
      range: `${h.start.toFixed(1)}-${h.end.toFixed(1)}`,
      // Highlight.score is optional on the shared type; V2 always sets it, and a
      // regression that stopped setting it shows up as a 0 in the snapshot diff.
      score: h.score ?? 0,
      title: h.title,
    })),
    dropReasons: (t.gateDropReasons as Record<string, number>) ?? {},
  };
  const outOfRange = (t.evidenceOutOfRange as Record<string, number>) ?? {};
  if (Object.keys(outOfRange).length > 0) shape.outOfRange = outOfRange;
  if (result.noClipsReason) shape.noClipsReason = result.noClipsReason;
  return shape;
}

export interface Fixture {
  name: string;
  transcript: TranscriptionResult;
  responses: Record<string, string>;
  snapshot: EvalShape | null;
  /** Engine config the responses were recorded under; null for pre-fingerprint fixtures. */
  fingerprint: Partial<EngineFingerprint> | null;
  /** Snapshots by variant name; base lives under BASE_VARIANT. */
  snapshots: Record<string, EvalShape | null>;
  /** Recorded fingerprints by variant name. */
  fingerprints: Record<string, Partial<EngineFingerprint> | null>;
}

/**
 * `fixturesDir` exists for the same reason loadVariantDefs takes one: the
 * absent-recording branch cannot be exercised against the shared tree once every
 * declared variant IS recorded, and a test that can only assert the present
 * branch quietly stops guarding the absent one.
 */
export function loadFixture(name: string, fixturesDir: string = FIXTURES_DIR): Fixture {
  const dir = join(fixturesDir, name);
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf-8"));
  const readIfPresent = (file: string) =>
    existsSync(join(dir, file)) ? read(file) : null;

  const meta = readIfPresent("meta.json") as
    | {
        engine?: Partial<EngineFingerprint>;
        variants?: Record<string, { engine?: Partial<EngineFingerprint> }>;
      }
    | null;

  const snapshots: Record<string, EvalShape | null> = {};
  const fingerprints: Record<string, Partial<EngineFingerprint> | null> = {};
  for (const variant of variantNames(fixturesDir)) {
    snapshots[variant] = readIfPresent(snapshotFileName(variant));
    fingerprints[variant] =
      variant === BASE_VARIANT
        ? (meta?.engine ?? null)
        : (meta?.variants?.[variant]?.engine ?? null);
  }

  return {
    name,
    transcript: read("transcript.json"),
    responses: read("responses.json"),
    // Kept as aliases so every existing caller keeps working unchanged.
    snapshot: snapshots[BASE_VARIANT],
    fingerprint: fingerprints[BASE_VARIANT],
    snapshots,
    fingerprints,
  };
}

/**
 * Runs the real engine against recorded LLM responses. Every deterministic
 * layer executes for real; nothing touches the network.
 *
 * A missing recording MUST fail loudly here. callJsonSchema catches the stub's
 * throw, retries, and returns {ok:false}; scanner.ts then treats the dead
 * window as a recall loss rather than an error - so without this check a stale
 * fixture would silently produce degraded output instead of a red test.
 */
export async function runFixture(
  fixture: Fixture,
  extraResponses: Record<string, string> = {}
): Promise<V2Result> {
  return runFixtureVariant(fixture, BASE_VARIANT, extraResponses);
}

/**
 * Replays a fixture under a named variant. The base variant IS the plain replay,
 * so runFixture is this function with the base name - there is no second path.
 *
 * The scanner's request keys are identical across variants, so its recorded
 * answers are reused byte for byte and the candidate set entering the critic is
 * the same one the base run judged. Only the critic and finalizer keys differ,
 * because the model is part of the request hash. That is what makes the diff
 * between two variants a statement about the judge and nothing else.
 */
export async function runFixtureVariant(
  fixture: Fixture,
  variant: string,
  extraResponses: Record<string, string> = {}
): Promise<V2Result> {
  const cfg = variantConfig(variant);
  const isBase = variant === BASE_VARIANT;
  // Base keeps the bare fixture name in its messages; only a variant run is
  // worth the "[name]" qualifier, and only a variant run is topped up.
  const label = isBase ? fixture.name : `${fixture.name}[${variant}]`;
  const recorded = fixture.fingerprints[variant] ?? null;
  // assertFingerprintMatches WARNS on an absent fingerprint, a concession for
  // fixtures recorded before fingerprinting existed. A variant cannot be one of
  // those - it postdates the mechanism - and comparability is the only property
  // it has, so an unfingerprinted variant replay is not merely unverified, it is
  // worthless. Refuse it here and leave the base concession intact.
  if (!isBase && recorded === null) {
    throw new Error(
      `fixture "${fixture.name}" variant "${variant}" has no recorded fingerprint in meta.json. ` +
        `A variant exists only to be compared against another, so an unfingerprinted one cannot be ` +
        `known to be comparable. Re-record it with eval-topup.ts --variant ${variant}.`
    );
  }
  assertFingerprintMatches(label, recorded, computeFingerprint(cfg));
  const client = createReplayClient({ ...fixture.responses, ...extraResponses });
  const result = await analyzeHighlightsV2(fixture.transcript, {
    client,
    cfg,
    retryDelayMs: 1,
  });
  if (client.missing.length > 0) {
    // keys repeat because callJsonSchema retries before giving up (the stub's
    // throw carries no status, so it lands in the retryable bucket)
    const unique = [...new Set(client.missing)];
    // The remediation differs by path: base is produced by eval-record.ts, a
    // variant is topped up onto an existing recording.
    throw new Error(
      isBase
        ? `fixture "${fixture.name}" is stale: ${unique.length} unrecorded request(s) ` +
          `[${unique.join(", ")}]. Re-record with eval-record.ts, or check whether a prompt changed.`
        : `fixture "${fixture.name}" variant "${variant}" is stale: ${unique.length} ` +
          `unrecorded request(s) [${unique.join(", ")}]. Record them with:\n` +
          `  docker compose exec worker-analyze sh -c "cd /app/apps/worker && ` +
          `npx tsx src/scripts/eval-topup.ts --variant ${variant} ${fixture.name}"`
    );
  }
  return result;
}

/**
 * Announces (fixture, variant) pairs that are declared but never recorded.
 *
 * Declaring a variant is how a recording gets STARTED, so reddening the suite
 * for one would make adding a candidate model a broken-build event. But silence
 * is worse than it looks: the pair is simply absent from the case list, so the
 * suite goes green while proving nothing about the declared model. Same shape as
 * assertFingerprintMatches' "cannot verify" path - announce, do not fail - and
 * the same injectable sink, so the announcement itself is testable.
 */
export function warnUnrecordedVariants(
  fixtures: string[],
  warn: (message: string) => void = console.warn
): void {
  for (const variant of variantNames()) {
    if (variant === BASE_VARIANT) continue;
    const missing = fixtures.filter(
      (name) => !existsSync(join(FIXTURES_DIR, name, snapshotFileName(variant)))
    );
    if (missing.length > 0) {
      warn(
        `[eval] variant "${variant}" is declared in variants.json but has no recording for: ` +
          `${missing.join(", ")}. Those pairs are NOT being tested. ` +
          `Record with eval-topup.ts --variant ${variant}.`
      );
    }
  }
}
