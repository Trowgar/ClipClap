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

  it("does not call a repeated model refusal temporary", () => {
    // The analysis model refused the same batch twice on the same prompt, and
    // every remaining attempt re-reads the cached transcript. So this copy may
    // promise no retry, and it may not tell the user to upload the same file
    // again - that would be a second Job row, and usage.service bills every job
    // that is not FAILED.
    const text = jobErrorText("ANALYSIS_REFUSED");
    expect(text).toContain("could not read part of this video");
    expect(text).toContain("minutes were not used");
    expect(text).toContain("different video");
    expect(text).not.toContain("retrying");
    expect(text).not.toContain("temporary");
    expect(text).not.toMatch(/upload it again|try again in a few minutes/i);
  });

  it("falls back to the generic message for unknown or missing codes", () => {
    const generic = jobErrorText(null);
    expect(generic).toContain("Something went wrong while processing this");
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

  it("the generic line asserts neither transience nor permanence", () => {
    // GENERIC is by definition the "we do not know whether this is transient"
    // bucket, and both answers are live at the moment it renders:
    //
    //  - permanent (undecodable codec, coverage floor, or the final attempt has
    //    already burned) -> "we are retrying, try again in a few minutes" is
    //    false and loops the user;
    //  - transient (attempt 1 of 3 - markJobFailed writes FAILED on EVERY
    //    attempt) -> "try uploading it again" is false too. The original heals
    //    on attempt 2, the re-upload is a second Job row, and usage.service
    //    bills both because it counts every job that is not FAILED.
    //
    // So the copy may assert neither, and it owes the user the one fact that
    // protects their minutes: do not re-send yet.
    const generic = jobErrorText(null);
    expect(generic).not.toContain("retrying");
    expect(generic).not.toContain("We are retrying");
    // no imperative to re-upload as the immediate next action
    expect(generic).not.toMatch(/Try uploading it again/);
    expect(generic).not.toMatch(/Try sending it again/);
    // the outcome is stated as unknown, not as either answer
    expect(generic).toMatch(/cannot tell yet/i);
    // and the double-charge risk of acting too early is named
    expect(generic).toMatch(/before uploading it again/i);
    expect(generic).toContain("twice");
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
