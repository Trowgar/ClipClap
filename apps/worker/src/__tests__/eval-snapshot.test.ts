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
import { compareFingerprints, computeFingerprint } from "./helpers/eval-fingerprint";

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

  /**
   * KNOB BY KNOB, not object by object, and the difference is what happens when
   * a knob is ADDED to the fingerprint.
   *
   * Every other consumer of this file - assertFingerprintMatches, which the
   * replay below runs through, and eval-bless - reads `mismatches` and treats a
   * key the recording predates as UNKNOWN rather than stale. That is the whole
   * documented policy: the failure worth reddening a suite for is a false MATCH,
   * and absence asserts nothing. A `toEqual` here quietly opted out of it, so
   * adding a knob turned every existing fixture red and made "add the key now,
   * re-record later" - the sequence the finalizer knobs actually shipped in
   * (dee5687) - impossible without paying for four recordings first.
   *
   * What is NOT relaxed: any knob the recording DOES carry must still match
   * exactly, and a knob it carries that the fingerprint no longer knows about is
   * still a failure - a recording naming a deleted knob is stale provenance, not
   * unknown provenance.
   */
  it.each(CASES)("%s[%s] was recorded on the config that variant describes", (name, variant) => {
    const fixture = loadFixture(name);
    const recorded = fixture.fingerprints[variant];
    expect(recorded).not.toBeNull();
    const current = computeFingerprint(variantConfig(variant));
    expect(compareFingerprints(recorded!, current).mismatches).toEqual([]);
    expect(Object.keys(recorded!).filter((key) => !(key in current))).toEqual([]);
  });

  it.each(CASES)("%s[%s] replays to its recorded snapshot", async (name, variant) => {
    const fixture = loadFixture(name);
    expect(fixture.snapshots[variant]).not.toBeNull();
    const shape = toShape(await runFixtureVariant(fixture, variant));
    expect(shape).toEqual(fixture.snapshots[variant]);
  });
});
