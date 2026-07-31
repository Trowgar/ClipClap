import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  runFixtureVariant,
  snapshotFileName,
  toShape,
  variantConfig,
  variantNames,
  warnUnrecordedVariants,
} from "./helpers/eval-fixture";
import { computeFingerprint } from "./helpers/eval-fingerprint";

/**
 * The eval fixtures are the only end-to-end proof this engine has: real
 * transcripts, real recorded LLM answers, every deterministic layer running for
 * real. Until this file existed they were exercised only by a tsx one-liner
 * pasted out of a markdown plan, which meant the fingerprint written by
 * eval-fixture.ts guarded nothing on the automated path - a knob change could
 * invalidate every recording and CI would stay green, which is the exact
 * "a green run is a lie" failure the fingerprint was built to kill.
 *
 * runFixture asserts the fingerprint before replaying, so a drifted knob reds
 * here with the re-record instructions.
 */
const FIXTURES = readdirSync(FIXTURES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(FIXTURES_DIR, e.name, "snapshot.json")))
  .map((e) => e.name)
  .sort();

/** Every (fixture, variant) pair that has actually been recorded. A declared
 *  but unrecorded variant is skipped rather than failed: declaring it is how a
 *  recording gets started, and reddening the suite for that would make adding a
 *  candidate model a broken-build event. Skipped is not the same as unnoticed
 *  though - the warning below names every pair this list silently drops. */
const CASES: Array<[string, string]> = FIXTURES.flatMap((name) =>
  variantNames()
    .filter((variant) => existsSync(join(FIXTURES_DIR, name, snapshotFileName(variant))))
    .map((variant) => [name, variant] as [string, string])
);

warnUnrecordedVariants(FIXTURES);

describe("eval fixtures", () => {
  it("finds the recorded fixtures on disk", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(2);
    expect(FIXTURES).toContain("podcast-answer-arc");
    expect(FIXTURES).toContain("podcast-ecology");
  });

  it("finds at least the base variant of every fixture", () => {
    // guards the guard: an empty CASES list would make every it.each below
    // vanish while the suite still reported green
    expect(CASES.length).toBeGreaterThanOrEqual(FIXTURES.length);
    for (const name of FIXTURES) {
      expect(CASES).toContainEqual([name, BASE_VARIANT]);
    }
  });

  it.each(CASES)("%s[%s] was recorded on the config that variant describes", (name, variant) => {
    const fixture = loadFixture(name);
    expect(fixture.fingerprints[variant]).not.toBeNull();
    expect(fixture.fingerprints[variant]).toEqual(computeFingerprint(variantConfig(variant)));
  });

  it.each(CASES)("%s[%s] replays to its recorded snapshot", async (name, variant) => {
    const fixture = loadFixture(name);
    expect(fixture.snapshots[variant]).not.toBeNull();
    const shape = toShape(await runFixtureVariant(fixture, variant));
    expect(shape).toEqual(fixture.snapshots[variant]);
  });
});
