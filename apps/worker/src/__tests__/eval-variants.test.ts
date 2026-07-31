import { describe, expect, it } from "vitest";
import {
  BASE_VARIANT,
  loadFixture,
  loadVariantDefs,
  snapshotFileName,
  variantConfig,
  variantNames,
} from "./helpers/eval-fixture";
import { loadAnalyzeConfig } from "../analyze-v2/config";

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
});
