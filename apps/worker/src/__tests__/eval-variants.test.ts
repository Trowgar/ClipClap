import { mkdtempSync, rmSync, writeFileSync } from "fs";
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

  it("reports a variant that has not been recorded yet as absent, not as empty", () => {
    const fixture = loadFixture("podcast-ecology");
    // luna is declared but not yet recorded at this point in the plan
    expect(fixture.snapshots.luna ?? null).toBeNull();
    expect(fixture.fingerprints.luna ?? null).toBeNull();
  });

  it("refuses to replay a variant that carries no fingerprint", async () => {
    // The base path only WARNS here, a concession for fixtures older than the
    // fingerprint mechanism. A variant cannot be older than it, and an
    // un-fingerprinted variant is not comparable to anything, so it must throw.
    const fixture = loadFixture("podcast-ecology");
    expect(fixture.fingerprints.luna ?? null).toBeNull();
    await expect(runFixtureVariant(fixture, "luna")).rejects.toThrow(
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
    const warnings: string[] = [];
    warnUnrecordedVariants(["podcast-ecology", "podcast-answer-arc"], (m) => warnings.push(m));
    // luna is declared in variants.json and recorded nowhere yet
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/variant "luna" is declared/);
    expect(warnings[0]).toContain("podcast-ecology");
    expect(warnings[0]).toContain("podcast-answer-arc");
    expect(warnings[0]).toMatch(/NOT being tested/);
  });

  it("says nothing when a declared variant is recorded everywhere", () => {
    const warnings: string[] = [];
    // no fixtures means no missing pairs - the announcement is per pair, not
    // per declaration, so it must not fire on an empty set
    warnUnrecordedVariants([], (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});
