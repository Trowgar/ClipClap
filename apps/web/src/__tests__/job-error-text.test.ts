import { describe, expect, it } from "vitest";
import { parseJobErrorCode, tagJobError } from "@clipclap/shared";
import { jobErrorText } from "../../lib/job-error-text";

describe("web job failure copy", () => {
  it("explains a technical analysis failure", () => {
    const text = jobErrorText("ANALYSIS_UNAVAILABLE");
    expect(text).toContain("could not analyze this video right now");
    expect(text).toContain("retrying it automatically");
    expect(text).toContain("minutes were not used");
  });

  it("asks for a different file on unsupported input, without promising a retry", () => {
    const text = jobErrorText("UNSUPPORTED_INPUT");
    expect(text).toContain("no video track");
    expect(text).not.toContain("retrying");
  });

  it("falls back to the generic message for unknown or missing codes", () => {
    const generic = jobErrorText(null);
    expect(generic).toContain("Something went wrong while processing this video");
    expect(jobErrorText(undefined)).toBe(generic);
    // a code from a newer worker this build does not know
    expect(
      jobErrorText("SOMETHING_NEW" as unknown as null)
    ).toBe(generic);
  });

  it("never renders the raw engine message", () => {
    const raw =
      "critic produced 0 usable verdicts for 12 candidates (omitted 12, refused 0) - nothing was judged";
    // what the DB actually holds for a tagged failure
    const stored = tagJobError("ANALYSIS_UNAVAILABLE", raw);
    const text = jobErrorText(parseJobErrorCode(stored));
    expect(text).not.toContain(raw);
    expect(text).not.toContain("critic");
    expect(text).not.toContain("ANALYSIS_UNAVAILABLE");

    // an untagged legacy failure degrades to the generic copy, not the prose
    expect(jobErrorText(parseJobErrorCode(raw))).toBe(jobErrorText(null));
  });
});
