import { describe, it, expect } from "vitest";
import { BASE_VARIANT, parseVariantArgs as parseArgs } from "./helpers/eval-fixture";

/**
 * The parser decides what eval-topup records and what eval-bless blesses. Every
 * way it can be wrong ends in either a fixture silently skipped or work done
 * under the wrong model, and in eval-topup's case that is not visible until the
 * bill arrives - so it is pinned here, where the check is free.
 *
 * One home, one test: the off-by-one below was originally written twice, once
 * per script, which is exactly how it survived the first review.
 */
describe("parseVariantArgs", () => {
  it("defaults to the base variant and keeps every case when no flag is given", () => {
    expect(parseArgs(["podcast-ecology"])).toEqual({
      variant: BASE_VARIANT,
      cases: ["podcast-ecology"],
    });
  });

  it("does not drop the first case when there is no --variant flag", () => {
    // indexOf returns -1 with no flag; an `i !== flagAt + 1` filter that forgets
    // that would exclude index 0 and silently record nothing.
    const { cases } = parseArgs(["podcast-ecology", "podcast-answer-arc"]);
    expect(cases).toEqual(["podcast-ecology", "podcast-answer-arc"]);
  });

  it("reads the variant name that follows the flag", () => {
    expect(parseArgs(["--variant", "luna", "podcast-ecology"])).toEqual({
      variant: "luna",
      cases: ["podcast-ecology"],
    });
  });

  it("never treats the variant name as a case", () => {
    const { cases } = parseArgs(["--variant", "luna", "podcast-ecology"]);
    expect(cases).not.toContain("luna");
  });

  it("keeps every case when the flag comes first", () => {
    expect(parseArgs(["--variant", "luna", "a", "b", "c"])).toEqual({
      variant: "luna",
      cases: ["a", "b", "c"],
    });
  });

  it("keeps every case when the flag comes after the cases", () => {
    expect(parseArgs(["a", "b", "--variant", "luna"])).toEqual({
      variant: "luna",
      cases: ["a", "b"],
    });
  });

  it("leaves the variant undefined when --variant is the last token", () => {
    // main() turns this into the usage line; if it defaulted to base instead,
    // `--variant` with a typo'd trailing name would record under the wrong model.
    expect(parseArgs(["--variant"])).toEqual({ variant: undefined, cases: [] });
    expect(parseArgs(["podcast-ecology", "--variant"])).toEqual({
      variant: undefined,
      cases: ["podcast-ecology"],
    });
  });

  it("returns no cases at all when argv is empty", () => {
    expect(parseArgs([])).toEqual({ variant: BASE_VARIANT, cases: [] });
  });

  // Every case below used to be SILENT. The run proceeded against base, spent
  // nothing, printed "unchanged" or "complete already", and the operator
  // concluded the variant had been blessed or recorded.
  describe("rejects the ways a variant silently becomes base", () => {
    it("throws on the equals form, which indexOf does not match", () => {
      expect(() => parseArgs(["--variant=luna", "podcast-ecology"])).toThrow(
        /unknown option "--variant=luna"/
      );
    });

    it("names the separate-argument form in the message, since that is the fix", () => {
      expect(() => parseArgs(["--variant=luna"])).toThrow(/--variant=NAME" is not supported/);
    });

    it("throws on a misspelled flag instead of eating the name as a fixture", () => {
      // The real damage here is "luna" arriving in cases: the run would look for
      // a fixture called luna, not a variant.
      expect(() => parseArgs(["--varient", "luna", "podcast-ecology"])).toThrow(
        /unknown option "--varient"/
      );
    });

    it("throws on any other unknown option", () => {
      expect(() => parseArgs(["--dry-run", "podcast-ecology"])).toThrow(/unknown option/);
      expect(() => parseArgs(["-v", "podcast-ecology"])).toThrow(/unknown option "-v"/);
    });

    it("throws on a repeated --variant rather than picking one", () => {
      // indexOf would take "luna" and let "gpt5" through as a fixture name.
      expect(() => parseArgs(["--variant", "luna", "--variant", "gpt5"])).toThrow(
        /given more than once/
      );
    });

    it("still accepts the one option it knows", () => {
      expect(() => parseArgs(["--variant", "luna", "podcast-ecology"])).not.toThrow();
    });
  });
});
