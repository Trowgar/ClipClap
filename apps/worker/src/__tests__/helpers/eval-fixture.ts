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
 * Deliberately narrow. A variant exists to answer "does a different judge decide
 * differently on the SAME candidates" - so it may change who answers, and
 * nothing about what is asked. Widening this to windowing or batching would
 * change the prompts, change every request key, and turn the diff back into the
 * mixed signal this whole mechanism exists to avoid.
 */
export type VariantOverrides = Partial<
  Pick<AnalyzeConfig, "criticModel" | "finalizerModel" | "criticModelFallback">
>;

export function loadVariantDefs(): Record<string, VariantOverrides> {
  const path = join(FIXTURES_DIR, "variants.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, VariantOverrides>;
}

/** Base first, then declared variants in a stable order. */
export function variantNames(): string[] {
  return [BASE_VARIANT, ...Object.keys(loadVariantDefs()).sort()];
}

export function snapshotFileName(variant: string): string {
  return variant === BASE_VARIANT ? "snapshot.json" : `snapshot.${variant}.json`;
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

export function loadFixture(name: string): Fixture {
  const dir = join(FIXTURES_DIR, name);
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
  for (const variant of variantNames()) {
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
  overrides: Partial<AnalyzeConfig> = {},
  extraResponses: Record<string, string> = {}
): Promise<V2Result> {
  const cfg: AnalyzeConfig = {
    ...loadAnalyzeConfig({}),
    engine: "recall-critic",
    ...overrides,
  };
  // Compared against the EFFECTIVE config: an override of a fingerprinted knob
  // invalidates the recording exactly as an edit to the default would.
  assertFingerprintMatches(fixture.name, fixture.fingerprint, computeFingerprint(cfg));
  const client = createReplayClient({ ...fixture.responses, ...extraResponses });
  const result = await analyzeHighlightsV2(fixture.transcript, {
    client,
    cfg,
    retryDelayMs: 1,
  });
  if (client.missing.length > 0) {
    // keys repeat because callJsonSchema retries once before giving up
    const unique = [...new Set(client.missing)];
    throw new Error(
      `fixture "${fixture.name}" is stale: ${unique.length} unrecorded request(s) [${unique.join(", ")}]. ` +
        `Re-record with eval-record.ts, or check whether a prompt changed.`
    );
  }
  return result;
}

/**
 * Replays a fixture under a named variant.
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
  assertFingerprintMatches(
    `${fixture.name}[${variant}]`,
    fixture.fingerprints[variant] ?? null,
    computeFingerprint(cfg)
  );
  const client = createReplayClient({ ...fixture.responses, ...extraResponses });
  const result = await analyzeHighlightsV2(fixture.transcript, {
    client,
    cfg,
    retryDelayMs: 1,
  });
  if (client.missing.length > 0) {
    const unique = [...new Set(client.missing)];
    throw new Error(
      `fixture "${fixture.name}" variant "${variant}" is stale: ${unique.length} ` +
        `unrecorded request(s) [${unique.join(", ")}]. Record them with:\n` +
        `  docker compose exec worker-analyze sh -c "cd /app/apps/worker && ` +
        `npx tsx src/scripts/eval-topup.ts --variant ${variant} ${fixture.name}"`
    );
  }
  return result;
}
