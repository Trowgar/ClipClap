import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { FIXTURES_DIR, loadFixture, runFixture, toShape } from "./helpers/eval-fixture";
import { computeFingerprint } from "./helpers/eval-fingerprint";
import { loadAnalyzeConfig } from "../analyze-v2/config";

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

describe("eval fixtures", () => {
  it("finds the recorded fixtures on disk", () => {
    // guards the guard: a glob that silently matched nothing would make every
    // it.each below vanish and the suite would still report green
    expect(FIXTURES.length).toBeGreaterThanOrEqual(2);
    expect(FIXTURES).toContain("podcast-answer-arc");
    expect(FIXTURES).toContain("podcast-ecology");
  });

  it.each(FIXTURES)("%s was recorded on the current engine config", (name) => {
    const fixture = loadFixture(name);
    // Not just "no mismatch": an absent fingerprint only warns inside
    // assertFingerprintMatches, so a fixture that lost its meta.json would
    // replay green forever. Require the recording to actually carry one.
    expect(fixture.fingerprint).not.toBeNull();
    expect(fixture.fingerprint).toEqual(
      computeFingerprint({ ...loadAnalyzeConfig({}), engine: "recall-critic" })
    );
  });

  it.each(FIXTURES)("%s replays to its recorded snapshot", async (name) => {
    const fixture = loadFixture(name);
    expect(fixture.snapshot).not.toBeNull();
    const shape = toShape(await runFixture(fixture));
    expect(shape).toEqual(fixture.snapshot);
  });
});
