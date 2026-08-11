import { describe, expect, it, vi } from "vitest";
import {
  assertFingerprintMatches,
  compareFingerprints,
  computeFingerprint,
  type EngineFingerprint,
} from "./helpers/eval-fingerprint";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { arcAuditMaxOutputTokens } from "../analyze-v2/arc-audit";
import { criticMaxOutputTokens } from "../analyze-v2/critic";
import { extensionMaxOutputTokens } from "../analyze-v2/end-extension";
import { finalizerMaxOutputTokens } from "../analyze-v2/finalize";

/** Fixture-free: everything here works off a synthetic config. */
const baseCfg = { ...loadAnalyzeConfig({}), engine: "recall-critic" as const };

describe("computeFingerprint", () => {
  it("captures the models, reasoning effort, batch size and all three LLM budgets", () => {
    expect(computeFingerprint(baseCfg)).toEqual({
      scanModel: baseCfg.scanModel,
      criticModel: baseCfg.criticModel,
      criticModelFallback: baseCfg.criticModelFallback,
      reasoningEffort: baseCfg.reasoningEffort,
      criticBatchSize: baseCfg.criticBatchSize,
      criticMaxOutputTokensBase: criticMaxOutputTokens(0),
      criticMaxOutputTokensPerCandidate: criticMaxOutputTokens(1) - criticMaxOutputTokens(0),
      finalizerEnabled: baseCfg.finalizerEnabled,
      finalizerModel: baseCfg.finalizerModel,
      finalizerMaxOutputTokensBase: finalizerMaxOutputTokens(0),
      finalizerMaxOutputTokensPerClip: finalizerMaxOutputTokens(1) - finalizerMaxOutputTokens(0),
      endExtensionEnabled: baseCfg.endExtensionEnabled,
      endExtensionWindowSec: baseCfg.endExtensionWindowSec,
      endExtensionMaxOutputTokensBase: extensionMaxOutputTokens(0),
      endExtensionMaxOutputTokensPerClip:
        extensionMaxOutputTokens(1) - extensionMaxOutputTokens(0),
      arcAuditEnabled: baseCfg.arcAuditEnabled,
      arcAuditBatchSize: baseCfg.arcAuditBatchSize,
      arcAuditMaxOutputTokensBase: arcAuditMaxOutputTokens(0),
      arcAuditMaxOutputTokensPerClip: arcAuditMaxOutputTokens(1) - arcAuditMaxOutputTokens(0),
      startExtensionEnabled: baseCfg.startExtensionEnabled,
      endExtensionHintsEnabled: baseCfg.endExtensionHintsEnabled,
      longClipsEnabled: baseCfg.longClipsEnabled,
      longClipMaxSec: baseCfg.longClipMaxSec,
    });
  });

  it("records the extension stage as DARK on the default config", () => {
    // Every fixture in the repo was recorded like this, and it is what makes the
    // key worth having: the recordings assert "no clip was extended", so a
    // replay under a live stage is a different engine and has to say so.
    expect(computeFingerprint(baseCfg).endExtensionEnabled).toBe(false);
  });

  it("records the arc-audit stage as DARK on the default config", () => {
    // Same argument, same shape: every fixture in the repo predates this
    // stage entirely, so a live replay against one of them is a different
    // engine and the fingerprint has to say so.
    expect(computeFingerprint(baseCfg).arcAuditEnabled).toBe(false);
  });

  it("records the start-extension stage as DARK on the default config", () => {
    // Same argument again, even though this stage makes no request of its own
    // - see eval-fingerprint.ts's doc comment for why the key is here anyway
    // (the shared-responses.json false-match risk).
    expect(computeFingerprint(baseCfg).startExtensionEnabled).toBe(false);
  });

  it("records the end-extension hint switch as DARK on the default config", () => {
    // Every fixture in the repo predates task 4 entirely, same argument as
    // endExtensionEnabled and arcAuditEnabled above.
    expect(computeFingerprint(baseCfg).endExtensionHintsEnabled).toBe(false);
  });

  it("records the long-clips policy as DARK on the default config", () => {
    // Every fixture in the repo predates task 5 entirely, same argument as
    // endExtensionEnabled/arcAuditEnabled/endExtensionHintsEnabled above.
    expect(computeFingerprint(baseCfg).longClipsEnabled).toBe(false);
  });
});

describe("assertFingerprintMatches", () => {
  const current = computeFingerprint(baseCfg);

  it("passes when the recorded config is identical", () => {
    const warn = vi.fn();
    expect(() =>
      assertFingerprintMatches("case", { ...current }, current, warn)
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails naming the critic model when it changed", () => {
    const recorded: EngineFingerprint = { ...current, criticModel: "gpt-5.1" };
    const changed = computeFingerprint({ ...baseCfg, criticModel: "gpt-6-turbo" });
    let error: Error | undefined;
    try {
      assertFingerprintMatches("case", recorded, changed, vi.fn());
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain("criticModel");
    expect(error?.message).toContain("gpt-5.1");
    expect(error?.message).toContain("gpt-6-turbo");
    expect(error?.message).toContain("eval-record.ts");
    // only the knob that moved is named
    expect(error?.message).not.toContain("scanModel");
  });

  it("fails when a critic token constant changed", () => {
    // simulates CRITIC_TOKENS_PER_CANDIDATE 400 -> 800 (the bug the harness missed)
    const recorded: EngineFingerprint = { ...current, criticMaxOutputTokensPerCandidate: 400 };
    let error: Error | undefined;
    try {
      assertFingerprintMatches("case", recorded, current, vi.fn());
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain("criticMaxOutputTokensPerCandidate");
    expect(error?.message).toContain("400");
    expect(error?.message).toContain(String(current.criticMaxOutputTokensPerCandidate));
  });

  it("fails when the finalizer was switched off, which makes NO request at all", () => {
    // The nastiest case in this file: a disabled finalizer does not produce an
    // unrecorded request, it produces no request, so replay-client sees nothing
    // wrong and the suite ships a different, unjudged set while staying green.
    const changed = computeFingerprint({ ...baseCfg, finalizerEnabled: false });
    expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
      /finalizerEnabled/
    );
  });

  it("fails when the finalizer output budget changed", () => {
    // finalize.ts marks these numbers ESTIMATED, NOT MEASURED - they are meant to
    // move, and when they do the recordings no longer describe what the judge was
    // allowed to answer.
    const recorded: EngineFingerprint = { ...current, finalizerMaxOutputTokensPerClip: 400 };
    expect(() => assertFingerprintMatches("case", recorded, current, vi.fn())).toThrow(
      /finalizerMaxOutputTokensPerClip/
    );
  });

  it("fails when the end-extension stage was switched on, which every fixture predates", () => {
    // The same shape as the finalizer case above and the one that will actually
    // happen: the stage ships dark, so a live replay against a dark recording
    // moves clip ends while every recorded response still fits its request. The
    // snapshot would move and nothing would say whether the stage or the
    // recording explains it.
    const changed = computeFingerprint({ ...baseCfg, endExtensionEnabled: true });
    expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
      /endExtensionEnabled/
    );
  });

  it("fails when the extension window changed, which the hash can miss entirely", () => {
    // Narrowing it far enough leaves no clip with anywhere to go, and a stage
    // with nothing to ask makes no request at all - so this is not covered by
    // "the prompt text changed, the request key changed".
    const changed = computeFingerprint({ ...baseCfg, endExtensionWindowSec: 40 });
    expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
      /endExtensionWindowSec/
    );
  });

  it("fails when the arc-audit stage was switched on, which every fixture predates", () => {
    // The same shape as endExtensionEnabled above: the stage ships dark, so a
    // live replay against a dark recording produces flags and telemetry that
    // simply were not measured against - the recorded responses.json has no
    // arc_audit request in it at all.
    const changed = computeFingerprint({ ...baseCfg, arcAuditEnabled: true });
    expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
      /arcAuditEnabled/
    );
  });

  it("fails when the start-extension stage was switched on, even though it makes no request itself", () => {
    // The case that motivates this key even though the stage never touches the
    // network: a fixture recorded with the narrower, un-widened clip set would
    // replay against the WIDER prompt this stage produces downstream without
    // ever failing "unrecorded request" - responses.json is a shared pool
    // across every variant of a fixture, so the base run's own answer for the
    // narrow set is sitting right there. This is the false MATCH the whole
    // fingerprint file exists to kill, arriving through the one stage that
    // cannot be caught by watching the request hash at all.
    const changed = computeFingerprint({ ...baseCfg, startExtensionEnabled: true });
    expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
      /startExtensionEnabled/
    );
  });

  it("fails when the end-extension hint switch was turned on, which every fixture predates", () => {
    // Same shape as endExtensionEnabled and arcAuditEnabled: task 4 ships dark,
    // so a live replay against a dark recording could add hinted clips to the
    // offered set and the snapshot would move with nothing saying whether the
    // hints worked or the recording simply predates them.
    const changed = computeFingerprint({ ...baseCfg, endExtensionHintsEnabled: true });
    expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
      /endExtensionHintsEnabled/
    );
  });

  it("fails when the extension output budget changed", () => {
    // end-extension.ts marks both constants ESTIMATED, NOT MEASURED and asks for
    // a re-measure from the first real run. Replay serves a recorded answer in
    // full whatever the cap says, so nothing else can notice a cap that would
    // truncate in production - and this stage has no truncation retry, so that
    // costs the whole stage for the job.
    // The drifted values are DERIVED from the current ones rather than written
    // as literals: a literal would red this test the day someone re-measures the
    // constants, which is the cry-wolf failure the fingerprint file is careful
    // to avoid. The numbers themselves are pinned where pinning them means
    // something - in each fixture's meta.json, once the stage has been recorded.
    const perClip: EngineFingerprint = {
      ...current,
      endExtensionMaxOutputTokensPerClip: current.endExtensionMaxOutputTokensPerClip + 50,
    };
    expect(() => assertFingerprintMatches("case", perClip, current, vi.fn())).toThrow(
      /endExtensionMaxOutputTokensPerClip/
    );
    const base: EngineFingerprint = {
      ...current,
      endExtensionMaxOutputTokensBase: current.endExtensionMaxOutputTokensBase + 300,
    };
    expect(() => assertFingerprintMatches("case", base, current, vi.fn())).toThrow(
      /endExtensionMaxOutputTokensBase/
    );
  });

  it("fails when the fallback model changed even though it never reaches the request hash", () => {
    const changed = computeFingerprint({ ...baseCfg, criticModelFallback: "gpt-4o-mini" });
    expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
      /criticModelFallback/
    );
  });

  it("fails when reasoning effort changed", () => {
    const changed = computeFingerprint({ ...baseCfg, reasoningEffort: "high" });
    expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
      /reasoningEffort/
    );
  });

  it("passes when a config knob outside the fingerprint changed", () => {
    // scoring/gating knobs change what the engine DOES with answers, not what it
    // asks - those belong in the snapshot diff, not in a re-record demand
    const changed = computeFingerprint({
      ...baseCfg,
      scoreThreshold: 0.9,
      softCap: 3,
      scanWindowSec: 300,
      maxConcurrency: 1,
      gapSentence: 1.5,
      // headroom changes how many clips reach the finalizer prompt, so the
      // request hash already fails loudly on it - fingerprinting it too would
      // demand a paid re-record for a knob replay cannot miss
      finalizerHeadroom: 9,
      // sceneGapSec is the closest call in that file and is deliberately out: it
      // is a measured property of the SOURCE, not a choice about what the model
      // may do, and moving it is a re-measurement argued from transcripts
      sceneGapSec: 9,
      // startExtensionWindowSec bounds a GATE inside arc-audit.ts, not what the
      // arc-audit model is shown or asked - the mirror-image reasoning of why
      // endExtensionWindowSec IS in the fingerprint (that one bounds what the
      // model may choose from).
      startExtensionWindowSec: 999,
    });
    const warn = vi.fn();
    expect(() => assertFingerprintMatches("case", { ...current }, changed, warn)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("lists every mismatching knob at once", () => {
    const changed = computeFingerprint({
      ...baseCfg,
      criticModel: "gpt-6",
      reasoningEffort: "medium",
    });
    let error: Error | undefined;
    try {
      assertFingerprintMatches("case", { ...current }, changed, vi.fn());
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain("criticModel");
    expect(error?.message).toContain("reasoningEffort");
  });

  it("fails on a RENAMED knob rather than warning about half of it", () => {
    // THE case the `stale` array exists for, and the one that produces nothing
    // to look at without it. Rename criticBatchSize to criticBatchCount: the new
    // name is merely unrecorded, so it warns; the old name is invisible to
    // `mismatches`, which iterates the CURRENT keys only. Between the two, a
    // recording made under the old knob would replay green against a config that
    // sets the renamed one differently - the false MATCH, arriving through the
    // one door nothing was watching.
    const renamed = { ...current } as unknown as Record<string, unknown>;
    delete renamed.criticBatchSize;
    renamed.criticBatchCount = current.criticBatchSize;
    const warn = vi.fn();
    let error: Error | undefined;
    try {
      assertFingerprintMatches(
        "case",
        { ...current },
        renamed as unknown as EngineFingerprint,
        warn
      );
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toContain("criticBatchSize");
    expect(error?.message).toContain("no such knob today");
    expect(error?.message).toContain("eval-record.ts");
    // and the other half is reported as what it is: unverified, not wrong
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("criticBatchCount");
  });

  it("fails when the recording names a knob that was deleted outright", () => {
    // Same verdict as the rename for the same reason: a recorded value nobody
    // can evaluate is provenance that cannot be checked, and only a re-record
    // fixes it. Deliberately NOT the `unrecorded` warn path - that one is about
    // a value the recording never had, which asserts nothing either way.
    const recorded = { ...current } as unknown as Record<string, unknown>;
    recorded.criticTemperature = 0.7;
    expect(() =>
      assertFingerprintMatches("case", recorded as Partial<EngineFingerprint>, current, vi.fn())
    ).toThrow(/criticTemperature/);
  });

  it("warns instead of failing when the fixture has no fingerprint at all", () => {
    const warn = vi.fn();
    expect(() => assertFingerprintMatches("legacy-case", null, current, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("legacy-case");
    expect(warn.mock.calls[0][0]).toContain("no meta.json");
  });

  it("warns for a knob the recording predates but still fails on one that moved", () => {
    const partial: Partial<EngineFingerprint> = { ...current };
    delete partial.criticMaxOutputTokensPerCandidate;
    const warn = vi.fn();
    expect(() => assertFingerprintMatches("old-case", partial, current, warn)).not.toThrow();
    expect(warn.mock.calls[0][0]).toContain("criticMaxOutputTokensPerCandidate");

    partial.criticModel = "gpt-4o";
    expect(() => assertFingerprintMatches("old-case", partial, current, vi.fn())).toThrow(
      /criticModel/
    );
  });
});

describe("compareFingerprints", () => {
  it("separates value mismatches, knobs the recording never had, and knobs it outlived", () => {
    const current = computeFingerprint(baseCfg);
    const recorded: Partial<EngineFingerprint> = { ...current, scanModel: "gpt-4.1-mini" };
    delete recorded.criticBatchSize;
    // A knob this fingerprint has never heard of - what a recording made before
    // a rename or a deletion carries.
    (recorded as Record<string, unknown>).criticTemperature = 0.7;
    expect(compareFingerprints(recorded, current)).toEqual({
      mismatches: [`scanModel: recorded "gpt-4.1-mini", current ${JSON.stringify(current.scanModel)}`],
      unrecorded: ["criticBatchSize"],
      stale: ["criticTemperature"],
    });
  });
});
