import { describe, expect, it } from "vitest";
import { JOB_ERROR_CODES, parseJobErrorCode, tagJobError } from "../job-error";

describe("job error codes", () => {
  it("keeps the raw diagnostics behind the tag", () => {
    const raw = "scanner failed on all 4 windows (4/4 windows) - models unavailable";
    const tagged = tagJobError("ANALYSIS_UNAVAILABLE", raw);
    expect(tagged).toBe(`[ANALYSIS_UNAVAILABLE] ${raw}`);
    expect(tagged).toContain(raw);
  });

  it("round-trips every code it knows", () => {
    for (const code of JOB_ERROR_CODES) {
      expect(parseJobErrorCode(tagJobError(code, "detail"))).toBe(code);
    }
  });

  it("returns null for anything it does not recognize", () => {
    // untagged engine prose - the shape every pre-existing FAILED row has
    expect(parseJobErrorCode("critic failed for batch [c7,c28]: error")).toBeNull();
    // a code from a future worker this UI does not know yet
    expect(parseJobErrorCode("[SOMETHING_NEW] whatever")).toBeNull();
    // not a tag at the start
    expect(parseJobErrorCode("failed: [ANALYSIS_UNAVAILABLE] later")).toBeNull();
    expect(parseJobErrorCode("")).toBeNull();
    expect(parseJobErrorCode(null)).toBeNull();
    expect(parseJobErrorCode(undefined)).toBeNull();
  });
});
