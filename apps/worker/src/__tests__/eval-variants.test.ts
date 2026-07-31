import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  BASE_VARIANT,
  loadFixture,
  loadVariantDefs,
  runFixtureVariant,
  snapshotFileName,
  variantConfig,
  variantNames,
  warnUnrecordedVariants,
} from "./helpers/eval-fixture";
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
 * The real tree cannot express "declared but unrecorded" any more - luna is
 * recorded in both fixtures - and it must not be edited to make it: those files
 * are paid recordings. The transcript and responses here are never replayed,
 * only parsed, so they can be empty.
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
    expect(loadVariantDefs().luna).toEqual({
      criticModel: "gpt-5.6-luna",
      finalizerModel: "gpt-5.6-luna",
    });
    expect(variantNames()).toContain("luna");
  });

  it("maps the base variant to snapshot.json and others to a suffixed file", () => {
    expect(snapshotFileName(BASE_VARIANT)).toBe("snapshot.json");
    expect(snapshotFileName("luna")).toBe("snapshot.luna.json");
  });

  it("builds the base config from the engine defaults, unchanged", () => {
    const base = variantConfig(BASE_VARIANT);
    const defaults = loadAnalyzeConfig({});
    expect(base.criticModel).toBe(defaults.criticModel);
    expect(base.finalizerModel).toBe(defaults.finalizerModel);
    expect(base.engine).toBe("recall-critic");
  });

  it("applies overrides on top of the defaults for a named variant", () => {
    const luna = variantConfig("luna");
    const defaults = loadAnalyzeConfig({});
    expect(luna.criticModel).toBe("gpt-5.6-luna");
    expect(luna.finalizerModel).toBe("gpt-5.6-luna");
    // everything not overridden must be identical, or the diff stops isolating
    // the model and starts mixing in a second changed knob
    expect(luna.scanModel).toBe(defaults.scanModel);
    expect(luna.reasoningEffort).toBe(defaults.reasoningEffort);
    expect(luna.criticBatchSize).toBe(defaults.criticBatchSize);
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
    const dir = variantsDir({
      whole: {
        criticModel: "a",
        finalizerModel: "b",
        criticModelFallback: "c",
      },
    });
    expect(loadVariantDefs(dir).whole).toEqual({
      criticModel: "a",
      finalizerModel: "b",
      criticModelFallback: "c",
    });
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
    // disk: luna is recorded now, and this guard must keep being tested after
    // every declared variant has a recording.
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
    // this test say "luna is unrecorded", which was true when it was written and
    // is false the moment anybody records luna.
    const variant = declaredVariant();
    const warnings: string[] = [];
    warnUnrecordedVariants(["ghost-fixture-a", "ghost-fixture-b"], (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`variant "${variant}" is declared`);
    expect(warnings[0]).toContain("ghost-fixture-a");
    expect(warnings[0]).toContain("ghost-fixture-b");
    expect(warnings[0]).toMatch(/NOT being tested/);
  });

  it("says nothing when a declared variant is recorded everywhere", () => {
    const warnings: string[] = [];
    // no fixtures means no missing pairs - the announcement is per pair, not
    // per declaration, so it must not fire on an empty set
    warnUnrecordedVariants([], (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it("stays silent for the fixtures that ARE fully recorded", () => {
    // the other half of the contract, and the half that only became testable
    // once luna was recorded: no announcement for a pair that exists
    const warnings: string[] = [];
    warnUnrecordedVariants(["podcast-ecology", "podcast-answer-arc"], (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});
