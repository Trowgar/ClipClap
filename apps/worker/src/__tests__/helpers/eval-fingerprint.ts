import type { AnalyzeConfig } from "../../analyze-v2/config";
import { criticMaxOutputTokens } from "../../analyze-v2/critic";
import { finalizerMaxOutputTokens } from "../../analyze-v2/finalize";

/**
 * Engine-config fingerprint stored next to every eval fixture (meta.json).
 *
 * WHY THIS EXISTS
 * ---------------
 * replay-client's requestKey hashes model + system + user only. That is the
 * right identity for a *prompt*, but it is NOT the identity of the *run*: knobs
 * that change what the model is allowed to do while answering (output cap,
 * reasoning effort) leave the key untouched. When the critic output budget was
 * resized, both fixtures kept serving responses captured under the old,
 * starved budget and the harness stayed green - it certified an already-fixed
 * bug as correct. A fingerprint turns that silent pass into a loud failure
 * without putting the cap into the hash (which would force a paid re-record on
 * every budget tweak, since the hash is per-request).
 *
 * WHAT IS IN IT - the knobs that decide what the LLM is asked and how it may
 * answer:
 *   scanModel / criticModel      which model answers. Both are inside the
 *                                requestKey too, but a mismatch there surfaces
 *                                as a cryptic "unrecorded request <hex>"; here
 *                                it names the knob.
 *   criticModelFallback          NOT reliably in the hash: it only appears in a
 *                                recording if the fallback path actually fired.
 *                                Change it after a clean recording and nothing
 *                                anywhere notices.
 *   reasoningEffort              invisible to the hash and the dominant term in
 *                                critic token usage - raising it re-creates the
 *                                truncation cascade the budget exists to
 *                                prevent (see critic.ts).
 *   criticBatchSize              decides how candidates are grouped into
 *                                prompts, so it changes both the prompt text
 *                                and the token demand of every critic call.
 *   criticMaxOutputTokens*       the exact bug above. Derived from the function
 *                                rather than from the raw constants so that a
 *                                change to the FORMULA is caught as well as a
 *                                change to either constant.
 *   finalizerEnabled             the worst of the lot, and the reason the
 *                                finalizer knobs were added here the moment the
 *                                stage was wired in. Turning the finalizer OFF
 *                                does not produce an unrecorded request - it
 *                                produces NO request - so replay stays green
 *                                while shipping a different, un-judged set.
 *                                That is a false MATCH, exactly what this file
 *                                exists to kill.
 *   finalizerModel               same argument as criticModel: it is inside the
 *                                requestKey, but a mismatch surfaces there as
 *                                an opaque hex, and here as the knob's name.
 *   finalizerMaxOutputTokens*    same argument as the critic budget, only worse:
 *                                this call cannot split a batch, so starvation
 *                                costs the whole stage rather than one batch,
 *                                and the numbers behind the formula are marked
 *                                ESTIMATED in finalize.ts - i.e. they are
 *                                expected to move once measured.
 *
 * finalizerHeadroom is deliberately NOT here: it changes how many clips reach
 * the prompt, so it changes the prompt text and the requestKey already fails
 * loudly on its own - the same reason the windowing knobs are out.
 *
 * WHAT IS DELIBERATELY OUT:
 *   - Scoring/gating/snapping knobs (scoreThreshold, softCap, gap*, hardMinSec,
 *     ...). They change what the engine does WITH the answers, never what it
 *     asks. A change there must show up as a snapshot diff - that is the
 *     harness working. Fingerprinting them would demand a paid re-record for
 *     every threshold tweak, i.e. cry wolf.
 *   - Windowing/candidate caps (scanWindowSec, criticMaxCandidates, ...). They
 *     do change prompt text, but that already changes the requestKey, so a
 *     stale fixture fails loudly on its own. Adding them buys nothing and adds
 *     re-record pressure.
 *   - CRITIC_CONCURRENCY / maxConcurrency: scheduling only. Same requests, same
 *     caps, same answers - replay does not even observe it.
 */
export interface EngineFingerprint {
  scanModel: string;
  criticModel: string;
  criticModelFallback: string;
  reasoningEffort: string;
  criticBatchSize: number;
  /** criticMaxOutputTokens(0) - the flat part of the critic output budget. */
  criticMaxOutputTokensBase: number;
  /** Marginal cap per extra candidate in a critic batch. */
  criticMaxOutputTokensPerCandidate: number;
  /** Whether the FINALIZE LLM pass ran at all. Off makes no request, so the
   *  request hash cannot notice it. */
  finalizerEnabled: boolean;
  finalizerModel: string;
  /** finalizerMaxOutputTokens(0) - the flat part of the finalizer budget. */
  finalizerMaxOutputTokensBase: number;
  /** Marginal cap per extra clip in the single finalizer call. */
  finalizerMaxOutputTokensPerClip: number;
}

export function computeFingerprint(cfg: AnalyzeConfig): EngineFingerprint {
  const base = criticMaxOutputTokens(0);
  const finalizerBase = finalizerMaxOutputTokens(0);
  return {
    scanModel: cfg.scanModel,
    criticModel: cfg.criticModel,
    criticModelFallback: cfg.criticModelFallback,
    reasoningEffort: cfg.reasoningEffort,
    criticBatchSize: cfg.criticBatchSize,
    criticMaxOutputTokensBase: base,
    criticMaxOutputTokensPerCandidate: criticMaxOutputTokens(1) - base,
    finalizerEnabled: cfg.finalizerEnabled,
    finalizerModel: cfg.finalizerModel,
    finalizerMaxOutputTokensBase: finalizerBase,
    finalizerMaxOutputTokensPerClip: finalizerMaxOutputTokens(1) - finalizerBase,
  };
}

export interface FingerprintComparison {
  /** Knobs recorded with a different value than the current config has. */
  mismatches: string[];
  /** Knobs the recording predates - unknown, not proven stale. */
  unrecorded: string[];
}

export function compareFingerprints(
  recorded: Partial<EngineFingerprint>,
  current: EngineFingerprint
): FingerprintComparison {
  const mismatches: string[] = [];
  const unrecorded: string[] = [];
  for (const key of Object.keys(current) as Array<keyof EngineFingerprint>) {
    if (!(key in recorded) || recorded[key] === undefined) {
      unrecorded.push(key);
      continue;
    }
    if (recorded[key] !== current[key]) {
      mismatches.push(
        `${key}: recorded ${JSON.stringify(recorded[key])}, current ${JSON.stringify(current[key])}`
      );
    }
  }
  return { mismatches, unrecorded };
}

/**
 * Throws when the recording was made under a materially different engine
 * config; warns when provenance is simply unknown.
 *
 * A missing meta.json (or a key added to the fingerprint after the recording)
 * WARNS instead of failing. The failure this whole mechanism exists to kill is
 * a false MATCH - the harness asserting "same config" when it was not. Absence
 * of a fingerprint asserts nothing, and hard-failing on it would red the suite
 * for every fixture that predates this file and would make adding a knob a
 * paid-re-record event for all existing fixtures. eval-record.ts always writes
 * meta.json now, so the warn path shrinks to zero on the next recording of any
 * fixture - and both fixtures in the repo carry one today.
 */
export function assertFingerprintMatches(
  fixtureName: string,
  recorded: Partial<EngineFingerprint> | null,
  current: EngineFingerprint,
  warn: (message: string) => void = console.warn
): void {
  if (recorded === null) {
    warn(
      `[eval] fixture "${fixtureName}" has no meta.json engine fingerprint - ` +
        `cannot verify it was recorded on the current config. Re-record it with eval-record.ts to fix.`
    );
    return;
  }
  const { mismatches, unrecorded } = compareFingerprints(recorded, current);
  if (unrecorded.length > 0) {
    warn(
      `[eval] fixture "${fixtureName}" fingerprint predates ${unrecorded.length} knob(s) ` +
        `[${unrecorded.join(", ")}] - those are unverified. Re-record to fix.`
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      `fixture "${fixtureName}" was recorded under a DIFFERENT engine config, so its responses no ` +
        `longer describe what the current engine would ask or be allowed to answer:\n` +
        mismatches.map((m) => `  - ${m}`).join("\n") +
        `\nA green run here would be a lie. Either revert the knob(s) above, or re-record the ` +
        `fixture:\n  docker compose exec worker-analyze sh -c "cd /app/apps/worker && ` +
        `npx tsx src/scripts/eval-record.ts <jobId> ${fixtureName}"`
    );
  }
}
