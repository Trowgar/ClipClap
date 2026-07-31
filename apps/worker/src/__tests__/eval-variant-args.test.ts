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

  it("excludes any hyphen-prefixed token from the case list", () => {
    expect(parseArgs(["--dry-run", "-v", "podcast-ecology"]).cases).toEqual([
      "podcast-ecology",
    ]);
  });

  it("returns no cases at all when argv is empty", () => {
    expect(parseArgs([])).toEqual({ variant: BASE_VARIANT, cases: [] });
  });
});
