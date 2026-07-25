import { describe, expect, it } from "vitest";
import { JOB_ERROR_CODES, parseJobErrorCode, tagJobError } from "@clipclap/shared";
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

  it("asks the user to check the link when the source could not be fetched", () => {
    const text = jobErrorText("SOURCE_UNAVAILABLE");
    expect(text).toContain("could not download the video from that link");
    expect(text).not.toContain("retrying");
    // A non-zero yt-dlp exit cannot tell a private video from a stale extractor
    // or a rate limit, so the copy may not assert a cause - it hedges ("may
    // be") and leads with the remedy that works for every one of them.
    expect(text).toContain("may be");
    expect(text).toContain("upload the file directly");
  });

  it("the generic line promises no automatic retry", () => {
    // GENERIC also covers permanent failures (yt-dlp, undecodable codec,
    // transcript coverage floor) and the state after the final attempt, where
    // "we are retrying, try again in a few minutes" is simply false.
    const generic = jobErrorText(null);
    expect(generic).not.toContain("retrying");
    expect(generic).not.toContain("few minutes");
    expect(generic).toContain("minutes were not used");
  });

  it("has copy for every code the worker can emit", () => {
    for (const code of JOB_ERROR_CODES) {
      expect(jobErrorText(code)).not.toBe(jobErrorText(null));
    }
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
