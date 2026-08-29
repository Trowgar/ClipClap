import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  VARIANT_OVERRIDE_KEYS,
  loadFixture,
  loadVariantDefs,
  runFixtureVariant,
  snapshotFileName,
  variantConfig,
  variantNames,
  warnUnrecordedVariants,
} from "./helpers/eval-fixture";
import {
  assertFingerprintMatches,
  computeFingerprint,
} from "./helpers/eval-fingerprint";
import { loadAnalyzeConfig } from "../analyze-v2/config";

/** Writes a throwaway variants.json so the whitelist can be exercised without
 *  touching the shared fixtures tree other test files read concurrently. */
const tempDirs: string[] = [];
function variantsDir(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-variants-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "variants.json"), JSON.stringify(contents));
  return dir;
}

const SYNTHETIC_FIXTURE = "synthetic";

/**
 * A throwaway fixtures tree: one fixture with a base recording, plus whatever
 * variants the caller declares and does NOT record.
 *
 * The real tree cannot express "declared but unrecorded" any more - every
 * declared variant is recorded in both fixtures - and it must not be edited to
 * make it: those files are paid recordings. The transcript and responses here
 * are never replayed, only parsed, so they can be empty.
 */
function syntheticFixture(opts: { declare: Record<string, unknown> }): string {
  const dir = variantsDir(opts.declare);
  const fixture = join(dir, SYNTHETIC_FIXTURE);
  mkdirSync(fixture);
  writeFileSync(join(fixture, "transcript.json"), JSON.stringify({ text: "", segments: [] }));
  writeFileSync(join(fixture, "responses.json"), JSON.stringify({}));
  writeFileSync(
    join(fixture, "snapshot.json"),
    JSON.stringify({ count: 0, tier: null, clips: [], dropReasons: {} })
  );
  writeFileSync(join(fixture, "meta.json"), JSON.stringify({ engine: { scanModel: "x" } }));
  return dir;
}

/** A variant that variants.json actually declares, whatever it is called. Tests
 *  that hardcode a name go stale the moment the plan moves to another model. */
function declaredVariant(): string {
  const declared = variantNames().filter((v) => v !== BASE_VARIANT);
  expect(declared.length).toBeGreaterThan(0);
  return declared[0];
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("variant definitions", () => {
  it("always offers the base variant first", () => {
    expect(variantNames()[0]).toBe(BASE_VARIANT);
  });

  it("reads declared variants from variants.json", () => {
    expect(loadVariantDefs().gpt51).toEqual({
      criticModel: "gpt-5.1",
      finalizerModel: "gpt-5.1",
    });
    expect(variantNames()).toContain("gpt51");
  });

  it("maps the base variant to snapshot.json and others to a suffixed file", () => {
    expect(snapshotFileName(BASE_VARIANT)).toBe("snapshot.json");
    expect(snapshotFileName("gpt51")).toBe("snapshot.gpt51.json");
  });

  it("builds the base config from the engine defaults, unchanged", () => {
    const base = variantConfig(BASE_VARIANT);
    const defaults = loadAnalyzeConfig({});
    expect(base.criticModel).toBe(defaults.criticModel);
    expect(base.finalizerModel).toBe(defaults.finalizerModel);
    expect(base.engine).toBe("recall-critic");
  });

  it("applies overrides on top of the defaults for a named variant", () => {
    const gpt51 = variantConfig("gpt51");
    const defaults = loadAnalyzeConfig({});
    expect(gpt51.criticModel).toBe("gpt-5.1");
    expect(gpt51.finalizerModel).toBe("gpt-5.1");
    // and it really is an override, not the default under a second name
    expect(gpt51.criticModel).not.toBe(defaults.criticModel);
    // everything not overridden must be identical, or the diff stops isolating
    // the model and starts mixing in a second changed knob
    expect(gpt51.scanModel).toBe(defaults.scanModel);
    expect(gpt51.reasoningEffort).toBe(defaults.reasoningEffort);
    expect(gpt51.criticBatchSize).toBe(defaults.criticBatchSize);
  });

  it("throws on an unknown variant rather than silently running the base", () => {
    expect(() => variantConfig("no-such-variant")).toThrow(/unknown variant/i);
  });

  it("refuses a knob outside the whitelist, not merely the ones a test names", () => {
    // scanWindowSec deliberately: it is NOT one of the knobs the assertions
    // above name, so only a whitelist rejects it. It changes the scan prompts,
    // which moves every request key and turns the diff into a mixed signal.
    const dir = variantsDir({
      wide: { criticModel: "gpt-5.6-luna", scanWindowSec: 300 },
    });
    expect(() => loadVariantDefs(dir)).toThrow(/scanWindowSec.*not allowed/s);
  });

  it("accepts every whitelisted knob, so the check is a whitelist and not a ban", () => {
    const whole = {
      criticModel: "a",
      finalizerModel: "b",
      criticModelFallback: "c",
      endExtensionEnabled: true,
      arcAuditEnabled: true,
      startExtensionEnabled: true,
      endExtensionHintsEnabled: true,
      longClipsEnabled: true,
      arcFinalizerNotesEnabled: true,
      arcDownrankEnabled: true,
    };
    // Driven off VARIANT_OVERRIDE_KEYS rather than a literal, because the way
    // this test rots is that a knob is admitted to the list and nobody adds it
    // here - and then "every whitelisted knob" is a claim about whichever
    // subset the last author happened to type.
    expect(Object.keys(whole).sort()).toEqual([...VARIANT_OVERRIDE_KEYS].sort());
    expect(loadVariantDefs(variantsDir({ whole })).whole).toEqual(whole);
  });

  /**
   * The end-extension variant is not just another declaration - it is the only
   * thing that makes `endExtensionEnabled` observable.
   *
   * The key was added to the fingerprint (helpers/eval-fingerprint.ts) to catch
   * a LIVE stage replaying against a DARK recording, on the argument that a
   * disabled stage makes no request so the request hash cannot notice it. But
   * the harness builds every config from an empty env, and until this variant
   * existed the whitelist refused the only knob that could set it - so no two
   * configs reachable from this harness could differ on the key, and the check
   * it was bought for could never fire. It was live in unit tests against a
   * synthetic config, and dead everywhere real.
   */
  it("makes the end-extension fingerprint key able to fire, which it could not before", () => {
    const dark = computeFingerprint(variantConfig(BASE_VARIANT));
    const live = computeFingerprint(variantConfig("end-extension"));
    expect(dark.endExtensionEnabled).toBe(false);
    expect(live.endExtensionEnabled).toBe(true);
    // Nothing else may move with it, or the diff stops being about the stage.
    expect({ ...live, endExtensionEnabled: false }).toEqual(dark);
    // The direction that matters: recorded with the stage on, replayed with it
    // off. This must THROW, not warn - a warn is what absence gets, and this is
    // a recording that positively describes a different engine.
    expect(() => assertFingerprintMatches("recorded-live", live, dark)).toThrow(
      /endExtensionEnabled/
    );
  });

  /** The arc-audit mirror of the test above, for the same reason: the
   *  fingerprint key was added on the argument that a disabled stage makes no
   *  request, so nothing in the request hash can notice it - and until the
   *  "arc-audit" variant declaration existed, no config this harness could
   *  build ever differed on the key, so the check it was bought for could not
   *  fire either. */
  it("makes the arc-audit fingerprint key able to fire, which it could not before", () => {
    const dark = computeFingerprint(variantConfig(BASE_VARIANT));
    const live = computeFingerprint(variantConfig("arc-audit"));
    expect(dark.arcAuditEnabled).toBe(false);
    expect(live.arcAuditEnabled).toBe(true);
    expect({ ...live, arcAuditEnabled: false }).toEqual(dark);
    expect(() => assertFingerprintMatches("recorded-live", live, dark)).toThrow(
      /arcAuditEnabled/
    );
  });

  /** The start-extension mirror of the two tests above. This stage makes no
   *  request of its own (start-extension.ts is pure and synchronous), so the
   *  fingerprint key exists for the shared-responses.json false-match reason
   *  documented in eval-fingerprint.ts, not the "off makes no request"
   *  argument the other two keys use - but the mechanism this test proves is
   *  identical: until the "start-extension" variant declaration existed, no
   *  config this harness could build ever differed on the key. The variant
   *  moves BOTH `arcAuditEnabled` and `startExtensionEnabled` together, since
   *  the stage no-ops without a detector feeding it - the same "a variant may
   *  move more than one whitelisted key" precedent gpt51 already set. */
  it("makes the start-extension fingerprint key able to fire, which it could not before", () => {
    const dark = computeFingerprint(variantConfig(BASE_VARIANT));
    const live = computeFingerprint(variantConfig("start-extension"));
    expect(dark.startExtensionEnabled).toBe(false);
    expect(live.startExtensionEnabled).toBe(true);
    expect(dark.arcAuditEnabled).toBe(false);
    expect(live.arcAuditEnabled).toBe(true);
    expect({ ...live, startExtensionEnabled: false, arcAuditEnabled: false }).toEqual(dark);
    expect(() => assertFingerprintMatches("recorded-live", live, dark)).toThrow(
      /startExtensionEnabled|arcAuditEnabled/
    );
  });

  /** The arc-exit-hints mirror of the three tests above (task 4). Same
   *  mechanism, and the same reason `endExtensionHintsEnabled` is a SEPARATE
   *  variant from "end-extension" rather than a third override on it: the
   *  self-motivated and hint-driven halves of end-extension are the thing
   *  under test being independently switchable, so a variant proving the
   *  fingerprint key fires has to set ONLY the hint switch (alongside
   *  arcAuditEnabled, its own dependency) and leave endExtensionEnabled dark. */
  it("makes the arc-exit-hints fingerprint key able to fire, which it could not before", () => {
    const dark = computeFingerprint(variantConfig(BASE_VARIANT));
    const live = computeFingerprint(variantConfig("arc-exit-hints"));
    expect(dark.endExtensionHintsEnabled).toBe(false);
    expect(live.endExtensionHintsEnabled).toBe(true);
    expect(dark.arcAuditEnabled).toBe(false);
    expect(live.arcAuditEnabled).toBe(true);
    // The self-motivated switch stays OFF on this variant - the separability
    // this task exists to prove, stated as a config fact rather than a comment.
    expect(live.endExtensionEnabled).toBe(false);
    expect({ ...live, endExtensionHintsEnabled: false, arcAuditEnabled: false }).toEqual(dark);
    expect(() => assertFingerprintMatches("recorded-live", live, dark)).toThrow(
      /endExtensionHintsEnabled|arcAuditEnabled/
    );
  });

  /** The long-clips mirror of the four tests above (task 5). Same mechanism:
   *  until the "long-clips" variant declaration existed, no config this
   *  harness could build ever differed on `longClipsEnabled`. Moves BOTH
   *  `arcAuditEnabled` and `longClipsEnabled` together, start-extension's own
   *  precedent - nothing can ever be blessed without a detector to feed it. */
  it("makes the long-clips fingerprint key able to fire, which it could not before", () => {
    const dark = computeFingerprint(variantConfig(BASE_VARIANT));
    const live = computeFingerprint(variantConfig("long-clips"));
    expect(dark.longClipsEnabled).toBe(false);
    expect(live.longClipsEnabled).toBe(true);
    expect(dark.arcAuditEnabled).toBe(false);
    expect(live.arcAuditEnabled).toBe(true);
    expect({ ...live, longClipsEnabled: false, arcAuditEnabled: false }).toEqual(dark);
    expect(() => assertFingerprintMatches("recorded-live", live, dark)).toThrow(
      /longClipsEnabled|arcAuditEnabled/
    );
  });

  /** The arc-finalizer-notes mirror of the five tests above (task 6). Same
   *  mechanism: until the "arc-finalizer-notes" variant declaration existed,
   *  no config this harness could build ever differed on
   *  `arcFinalizerNotesEnabled`. Moves BOTH `arcAuditEnabled` and
   *  `arcFinalizerNotesEnabled` together, every *Enabled variant's own
   *  precedent - a note can never render without a detector to flag the clip
   *  it renders for. */
  it("makes the arc-finalizer-notes fingerprint key able to fire, which it could not before", () => {
    const dark = computeFingerprint(variantConfig(BASE_VARIANT));
    const live = computeFingerprint(variantConfig("arc-finalizer-notes"));
    expect(dark.arcFinalizerNotesEnabled).toBe(false);
    expect(live.arcFinalizerNotesEnabled).toBe(true);
    expect(dark.arcAuditEnabled).toBe(false);
    expect(live.arcAuditEnabled).toBe(true);
    expect({ ...live, arcFinalizerNotesEnabled: false, arcAuditEnabled: false }).toEqual(dark);
    expect(() => assertFingerprintMatches("recorded-live", live, dark)).toThrow(
      /arcFinalizerNotesEnabled|arcAuditEnabled/
    );
  });

  /** The arc-downrank mirror of the six tests above (task 7). Same mechanism:
   *  until the "arc-downrank" variant declaration existed, no config this
   *  harness could build ever differed on `arcDownrankEnabled`. Moves BOTH
   *  `arcAuditEnabled` and `arcDownrankEnabled` together, every *Enabled
   *  variant's own precedent - nothing can ever be flagged, so nothing can
   *  ever be downranked, without a detector to feed it. */
  it("makes the arc-downrank fingerprint key able to fire, which it could not before", () => {
    const dark = computeFingerprint(variantConfig(BASE_VARIANT));
    const live = computeFingerprint(variantConfig("arc-downrank"));
    expect(dark.arcDownrankEnabled).toBe(false);
    expect(live.arcDownrankEnabled).toBe(true);
    expect(dark.arcAuditEnabled).toBe(false);
    expect(live.arcAuditEnabled).toBe(true);
    expect({ ...live, arcDownrankEnabled: false, arcAuditEnabled: false }).toEqual(dark);
    expect(() => assertFingerprintMatches("recorded-live", live, dark)).toThrow(
      /arcDownrankEnabled|arcAuditEnabled/
    );
  });
});

describe("post-boundary hook gate fingerprint", () => {
  it("separates every gate mode without relying on an LLM prompt change", () => {
    const off = computeFingerprint(loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "off" }));
    const observe = computeFingerprint(loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "observe" }));
    const shadow = computeFingerprint(
      loadAnalyzeConfig({
        POST_BOUNDARY_HOOK_GATE: "shadow",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
        POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "2",
      })
    );
    const enforce = computeFingerprint(
      loadAnalyzeConfig({
        POST_BOUNDARY_HOOK_GATE: "enforce",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
        POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "2",
      })
    );

    expect(off.postBoundaryHookGateMode).toBe("off");
    expect(off.postBoundaryHookMaxDelaySec).toBeUndefined();
    expect(off.postBoundaryHookMaxPreHookGapSec).toBeUndefined();
    expect(observe.postBoundaryHookGateMode).toBe("observe");
    expect(observe.postBoundaryHookMaxDelaySec).toBeUndefined();
    expect(observe.postBoundaryHookMaxPreHookGapSec).toBeUndefined();

    for (const fingerprint of [observe, shadow, enforce]) {
      expect(() => assertFingerprintMatches("recorded-off", off, fingerprint)).toThrow(
        /postBoundaryHookGateMode/
      );
    }

    // These configurations only differ in output policy. Every pre-existing
    // fingerprint key is unchanged, so this check cannot pass because a model
    // request or prompt happened to change as well.
    expect({
      ...shadow,
      postBoundaryHookGateMode: "off",
      postBoundaryHookMaxDelaySec: undefined,
      postBoundaryHookMaxPreHookGapSec: undefined,
    }).toEqual(off);
  });

  it("separates either thresholded gate limit without an LLM prompt change", () => {
    const baseline = computeFingerprint(
      loadAnalyzeConfig({
        POST_BOUNDARY_HOOK_GATE: "shadow",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
        POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "2",
      })
    );
    const delayChanged = computeFingerprint(
      loadAnalyzeConfig({
        POST_BOUNDARY_HOOK_GATE: "shadow",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "3",
        POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "2",
      })
    );
    const gapChanged = computeFingerprint(
      loadAnalyzeConfig({
        POST_BOUNDARY_HOOK_GATE: "shadow",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
        POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "4",
      })
    );

    expect({ ...delayChanged, postBoundaryHookMaxDelaySec: 1 }).toEqual(baseline);
    expect({ ...gapChanged, postBoundaryHookMaxPreHookGapSec: 2 }).toEqual(baseline);
    expect(() => assertFingerprintMatches("recorded-baseline", baseline, delayChanged)).toThrow(
      /postBoundaryHookMaxDelaySec/
    );
    expect(() => assertFingerprintMatches("recorded-baseline", baseline, gapChanged)).toThrow(
      /postBoundaryHookMaxPreHookGapSec/
    );
  });
});

describe("fixture variant surface", () => {
  it("exposes the base snapshot and fingerprint under the base variant name", () => {
    const fixture = loadFixture("podcast-ecology");
    expect(fixture.snapshots[BASE_VARIANT]).toEqual(fixture.snapshot);
    expect(fixture.fingerprints[BASE_VARIANT]).toEqual(fixture.fingerprint);
  });

  it("reports a declared but unrecorded variant as absent, not as empty", () => {
    // Deliberately NOT the shared fixtures tree: every variant declared there is
    // recorded now, so the absent branch is unreachable through it and an
    // assertion against a real name would only re-prove the recorded branch.
    const dir = syntheticFixture({ declare: { ghost: { criticModel: "m" } } });
    const fixture = loadFixture(SYNTHETIC_FIXTURE, dir);
    expect(fixture.snapshots.ghost).toBeNull();
    expect(fixture.fingerprints.ghost).toBeNull();
    // and the loader really did read this directory, so the nulls above are
    // absence rather than a failure to find anything at all
    expect(fixture.snapshots[BASE_VARIANT]).not.toBeNull();
    expect(fixture.fingerprints[BASE_VARIANT]).not.toBeNull();
  });

  it("refuses to replay a variant that carries no fingerprint", async () => {
    // The base path only WARNS here, a concession for fixtures older than the
    // fingerprint mechanism. A variant cannot be older than it, and an
    // un-fingerprinted variant is not comparable to anything, so it must throw.
    //
    // The fingerprint is forced onto the loaded object rather than read from
    // disk: every declared variant is recorded now, and this guard must keep
    // being tested after that is true.
    const variant = declaredVariant();
    const fixture = loadFixture("podcast-ecology");
    const unfingerprinted = {
      ...fixture,
      fingerprints: { ...fixture.fingerprints, [variant]: null },
    };
    await expect(runFixtureVariant(unfingerprinted, variant)).rejects.toThrow(
      /no recorded fingerprint in meta\.json/
    );
  });

  it("still only warns when the BASE fingerprint is missing", async () => {
    // guards the guard above: the throw must not have swallowed the legacy
    // concession, or every pre-fingerprint fixture would red at once
    const fixture = loadFixture("podcast-ecology");
    const warnings: string[] = [];
    const sink = vi.spyOn(console, "warn").mockImplementation((m: string) => {
      warnings.push(m);
    });
    try {
      await runFixtureVariant(
        { ...fixture, fingerprints: { ...fixture.fingerprints, [BASE_VARIANT]: null } },
        BASE_VARIANT
      );
    } finally {
      sink.mockRestore();
    }
    expect(warnings.join("\n")).toMatch(/has no meta\.json engine fingerprint/);
  });
});

describe("unrecorded variant announcement", () => {
  it("names every declared variant that has no recording, without failing", () => {
    // Fixture names that exist nowhere on disk, so no declared variant can have
    // a recording for them. Driving it with the REAL fixture names would make
    // this test say "gpt51 is unrecorded", which is false - it is recorded in
    // both, and any declared variant becomes recorded the moment anybody tops it
    // up.
    //
    // One warning per DECLARATION, asserted over every declaration rather than
    // the first: the announcement is per (variant, fixture) pair, and a version
    // of this test that read warnings[0] passed while a second declared variant
    // went unannounced - which is the exact silence the announcement exists to
    // break.
    const declared = variantNames().filter((v) => v !== BASE_VARIANT);
    const warnings: string[] = [];
    warnUnrecordedVariants(["ghost-fixture-a", "ghost-fixture-b"], (m) => warnings.push(m));
    expect(warnings).toHaveLength(declared.length);
    for (const variant of declared) {
      const line = warnings.find((w) => w.includes(`variant "${variant}" is declared`));
      expect(line, `no announcement for declared variant "${variant}"`).toBeDefined();
      expect(line).toContain("ghost-fixture-a");
      expect(line).toContain("ghost-fixture-b");
      expect(line).toMatch(/NOT being tested/);
    }
  });

  it("says nothing when a declared variant is recorded everywhere", () => {
    const warnings: string[] = [];
    // no fixtures means no missing pairs - the announcement is per pair, not
    // per declaration, so it must not fire on an empty set
    warnUnrecordedVariants([], (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it("announces exactly the (variant, fixture) pairs that lack a recording on disk", () => {
    // The other half of the contract: no announcement for a pair that exists.
    // A previous version of this test hardcoded which variant was unrecorded
    // ("start-extension is the one...") and went red the moment the operator
    // recorded it - it asserted the repository's transient state, not the
    // mechanism. The expectation is now derived from the same disk state the
    // announcer reads: for each declared variant, a fixture is missing when
    // its snapshot.<variant>.json does not exist. Whatever that set is, the
    // announcement must name exactly it - including announcing nothing when
    // everything is recorded, which is the steady state after every topup.
    const fixtures = ["podcast-ecology", "podcast-answer-arc"];
    const missingByVariant = new Map<string, string[]>();
    for (const variant of Object.keys(loadVariantDefs())) {
      const missing = fixtures.filter(
        (f) => !existsSync(join(FIXTURES_DIR, f, snapshotFileName(variant)))
      );
      if (missing.length > 0) missingByVariant.set(variant, missing);
    }
    const warnings: string[] = [];
    warnUnrecordedVariants(fixtures, (m) => warnings.push(m));
    expect(warnings).toHaveLength(missingByVariant.size);
    for (const [variant, missing] of missingByVariant) {
      const line = warnings.find((w) => w.includes(`variant "${variant}" is declared`));
      expect(line).toBeDefined();
      for (const f of missing) expect(line).toContain(f);
    }
  });
});
