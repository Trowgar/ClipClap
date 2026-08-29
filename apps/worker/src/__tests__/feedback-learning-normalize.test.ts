import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { normalizeFeedback } from "../feedback-learning/normalize";
import type { FeedbackProjection, JobProjection } from "../feedback-learning/types";

const updatedAt = new Date("2026-08-28T12:00:00.123Z");

function feedback(overrides: Partial<FeedbackProjection> = {}): FeedbackProjection {
  return {
    id: "feedback-1",
    clipId: "clip-1",
    jobId: "job-1",
    userId: "user-1",
    verdict: "AS_IS",
    note: null,
    snapshot: {
      title: "  A useful clip  ",
      startTime: 12.3,
      endTime: 45.6,
      score: 0.82,
      transcript: " Private transcript slice ",
      language: " RU ",
      clipKind: " Insight ",
    },
    evidenceKey: "feedback/clip-1.mp4",
    updatedAt,
    ...overrides,
  };
}

function job(overrides: Partial<JobProjection> = {}): JobProjection {
  return {
    id: "job-1",
    transcriptJson: { segments: [] },
    transcriptPartial: false,
    ...overrides,
  };
}

function valid(
  result: ReturnType<typeof normalizeFeedback>
): Extract<ReturnType<typeof normalizeFeedback>, { status: "valid" }> {
  expect(result.status).toBe("valid");
  if (result.status !== "valid") throw new Error("expected valid normalization");
  return result;
}

describe("normalizeFeedback", () => {
  it("produces the exact fixed pre-selection record and stable candidate identity", () => {
    const row = feedback({ note: "curator note" });
    const result = valid(normalizeFeedback(row, job()));
    const snapshotCanonical = canonicalJson(row.snapshot);
    const snapshotSha256 = sha256(snapshotCanonical);

    expect(Object.keys(result.record)).toEqual([
      "feedbackId",
      "clipId",
      "jobId",
      "userId",
      "verdict",
      "note",
      "evidenceKey",
      "updatedAt",
      "snapshotCanonical",
      "snapshotSha256",
      "jobProjectionId",
      "jobPresent",
      "transcriptPresent",
      "segmentsIsArray",
      "transcriptPartial",
      "language",
      "clipKind",
      "tier",
      "warnings",
      "review",
    ]);
    expect(result.record).toEqual({
      feedbackId: "feedback-1",
      clipId: "clip-1",
      jobId: "job-1",
      userId: "user-1",
      verdict: "AS_IS",
      note: "curator note",
      evidenceKey: "feedback/clip-1.mp4",
      updatedAt: "2026-08-28T12:00:00.123Z",
      snapshotCanonical,
      snapshotSha256,
      jobProjectionId: "job-1",
      jobPresent: true,
      transcriptPresent: true,
      segmentsIsArray: true,
      transcriptPartial: false,
      language: "ru",
      clipKind: "insight",
      tier: "replay-ready",
      warnings: [],
      review: {
        title: "  A useful clip  ",
        startTime: 12.3,
        endTime: 45.6,
        score: 0.82,
        transcript: " Private transcript slice ",
        note: "curator note",
        evidenceKey: "feedback/clip-1.mp4",
      },
    });
    expect(Object.keys(result.record.review)).toEqual([
      "title",
      "startTime",
      "endTime",
      "score",
      "transcript",
      "note",
      "evidenceKey",
    ]);
    expect(result.candidateVersion).toBe(
      sha256(`feedback-1\n${updatedAt.toISOString()}\n${snapshotSha256}`)
    );
  });

  it("uses unknown for absent language and clip kind and never falls back to locale", () => {
    const result = valid(
      normalizeFeedback(
        feedback({
          snapshot: {
            title: "Title",
            startTime: 1,
            endTime: 2,
            score: 0,
            transcript: "words",
            locale: "FR",
            language: "  ",
            clipKind: null,
          },
        }),
        job()
      )
    );

    expect(result.record.language).toBe("unknown");
    expect(result.record.clipKind).toBe("unknown");
  });

  it("emits each warning once in exact order and keeps a readable sparse row", () => {
    const result = valid(
      normalizeFeedback(
        feedback({
          snapshot: { title: "", startTime: 1, transcript: "  " },
          evidenceKey: "",
        }),
        job({ transcriptJson: { segments: "not-an-array" }, transcriptPartial: true })
      )
    );

    expect(result.record.tier).toBe("reference-only");
    expect(result.record.warnings).toEqual([
      "transcript_segments_invalid",
      "transcript_partial",
      "snapshot_sparse",
      "transcript_slice_missing",
      "evidence_missing",
    ]);
    expect(result.record.review).toEqual({
      title: null,
      startTime: 1,
      endTime: null,
      score: null,
      transcript: null,
      note: null,
      evidenceKey: "",
    });
  });

  it.each([
    [null, true],
    ["", true],
    ["  ", true],
    [" feedback/clip-1.mp4 ", false],
  ] as const)(
    "preserves raw evidence projection %j while classifying its warning",
    (evidenceKey, warningExpected) => {
      const result = valid(normalizeFeedback(feedback({ evidenceKey }), job()));

      expect(result.record.evidenceKey).toBe(evidenceKey);
      expect(result.record.review.evidenceKey).toBe(evidenceKey);
      expect(result.record.warnings.includes("evidence_missing")).toBe(warningExpected);
    }
  );

  it("suppresses transcript warnings when the Job is missing", () => {
    const result = valid(
      normalizeFeedback(
        feedback({
          snapshot: {
            title: "Title",
            startTime: 1,
            endTime: 2,
            score: 0.5,
            transcript: "  ",
          },
        }),
        null
      )
    );

    expect(result.record).toMatchObject({
      jobProjectionId: null,
      jobPresent: false,
      transcriptPresent: null,
      segmentsIsArray: null,
      transcriptPartial: null,
      tier: "reference-only",
      warnings: ["job_missing"],
    });
  });

  it.each([
    [null, "transcript_missing"],
    [undefined, "transcript_missing"],
    [{}, "transcript_segments_invalid"],
    [{ segments: null }, "transcript_segments_invalid"],
  ])("classifies transcript projection %j", (transcriptJson, warning) => {
    const result = valid(normalizeFeedback(feedback(), job({ transcriptJson })));

    expect(result.record.tier).toBe("reference-only");
    expect(result.record.warnings[0]).toBe(warning);
  });

  it("normalizes a null snapshot to canonical null and emits only its snapshot warning", () => {
    const result = valid(normalizeFeedback(feedback({ snapshot: null }), job()));

    expect(result.record.snapshotCanonical).toBe("null");
    expect(result.record.snapshotSha256).toBe(sha256("null"));
    expect(result.record.language).toBe("unknown");
    expect(result.record.clipKind).toBe("unknown");
    expect(result.record.warnings).toEqual(["snapshot_missing"]);
    expect(result.record.review).toEqual({
      title: null,
      startTime: null,
      endTime: null,
      score: null,
      transcript: null,
      note: null,
      evidenceKey: "feedback/clip-1.mp4",
    });
  });

  it("marks non-JSON snapshots invalid instead of crashing", () => {
    const result = normalizeFeedback(feedback({ snapshot: { title: undefined } }), job());

    expect(result).toEqual({
      status: "invalid",
      invalid: {
        feedbackId: "feedback-1",
        candidateVersion: null,
        reason: "invalid_row",
        detailCode: "snapshot_not_json",
      },
    });
  });

  it.each([
    ["missing feedback id", { id: "" }, "identity_unavailable", null],
    ["invalid date", { updatedAt: new Date(Number.NaN) }, "identity_unavailable", "feedback-1"],
    ["missing clip id", { clipId: "" }, "projection_invalid", "feedback-1"],
    ["invalid note", { note: 7 }, "projection_invalid", "feedback-1"],
  ] as const)(
    "returns a deterministic invalid marker for %s",
    (_label, overrides, detailCode, expectedFeedbackId) => {
      const result = normalizeFeedback(
        feedback(overrides as unknown as Partial<FeedbackProjection>),
        job()
      );

      expect(result).toEqual({
        status: "invalid",
        invalid: {
          feedbackId: expectedFeedbackId,
          candidateVersion: null,
          reason: "invalid_row",
          detailCode,
        },
      });
    }
  );

  it("treats a mismatched Job projection as projection-invalid", () => {
    const result = normalizeFeedback(feedback(), job({ id: "different-job" }));

    expect(result).toEqual({
      status: "invalid",
      invalid: {
        feedbackId: "feedback-1",
        candidateVersion: null,
        reason: "invalid_row",
        detailCode: "projection_invalid",
      },
    });
  });
});
