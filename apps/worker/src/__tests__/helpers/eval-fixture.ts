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
}

export function loadFixture(name: string): Fixture {
  const dir = join(FIXTURES_DIR, name);
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf-8"));
  const snapshotPath = join(dir, "snapshot.json");
  const metaPath = join(dir, "meta.json");
  return {
    name,
    transcript: read("transcript.json"),
    responses: read("responses.json"),
    snapshot: existsSync(snapshotPath) ? read("snapshot.json") : null,
    fingerprint: existsSync(metaPath) ? read("meta.json").engine ?? null : null,
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
