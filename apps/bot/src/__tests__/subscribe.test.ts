import { describe, expect, it } from "vitest";
import { parseSubCallback } from "../handlers";

describe("parseSubCallback", () => {
  it("parses supported plan/cycle pairs", () => {
    expect(parseSubCallback("sub:STARTER:WEEKLY")).toEqual({ plan: "STARTER", cycle: "WEEKLY" });
    expect(parseSubCallback("sub:MAX:MONTHLY")).toEqual({ plan: "MAX", cycle: "MONTHLY" });
  });
  it("rejects unsupported combos and junk", () => {
    expect(parseSubCallback("sub:PLUS:WEEKLY")).toBeNull();
    expect(parseSubCallback("sub:MAX:WEEKLY")).toBeNull();
    expect(parseSubCallback("sub:BOGUS:MONTHLY")).toBeNull();
    expect(parseSubCallback("lang_en")).toBeNull();
    expect(parseSubCallback(undefined)).toBeNull();
  });
});
