import { describe, expect, it } from "vitest";

import { canonicalJson, jsonLine, sha256 } from "../feedback-learning/canonical";
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

  it("serializes one complete valid record as exact UTF-8 bytes in fixed field order", () => {
    const result = valid(normalizeFeedback(feedback(), job()));
    const expected =
      '{"feedbackId":"feedback-1","clipId":"clip-1","jobId":"job-1","userId":"user-1",' +
      '"verdict":"AS_IS","note":null,"evidenceKey":"feedback/clip-1.mp4",' +
      '"updatedAt":"2026-08-28T12:00:00.123Z",' +
      '"snapshotCanonical":"{\\"clipKind\\":\\" Insight \\",\\"endTime\\":45.6,' +
      '\\"language\\":\\" RU \\",\\"score\\":0.82,\\"startTime\\":12.3,' +
      '\\"title\\":\\"  A useful clip  \\",\\"transcript\\":\\" Private transcript slice \\"}",' +
      '"snapshotSha256":"sha256:b2c587d58dd1563ff94ddef52e4d2f8a844ef5589f0aebf7b624c630c8c90d05",' +
      '"jobProjectionId":"job-1","jobPresent":true,"transcriptPresent":true,' +
      '"segmentsIsArray":true,"transcriptPartial":false,"language":"ru",' +
      '"clipKind":"insight","tier":"replay-ready","warnings":[],' +
      '"review":{"title":"  A useful clip  ","startTime":12.3,"endTime":45.6,' +
      '"score":0.82,"transcript":" Private transcript slice ","note":null,' +
      '"evidenceKey":"feedback/clip-1.mp4"}}\n';

    expect(jsonLine(result.record)).toEqual(Buffer.from(expected, "utf8"));
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

  it("rejects an accessor-backed snapshot without reading or mixing it", () => {
    let reads = 0;
    const row = feedback();
    Object.defineProperty(row, "snapshot", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? feedback().snapshot : null;
      },
    });

    expect(normalizeFeedback(row, job())).toEqual({
      status: "invalid",
      invalid: {
        feedbackId: "feedback-1",
        candidateVersion: null,
        reason: "invalid_row",
        detailCode: "snapshot_not_json",
      },
    });
    expect(reads).toBe(0);
  });

  it("rejects snapshot field accessors without producing a hash/review mismatch", () => {
    let reads = 0;
    const snapshot = feedback().snapshot as Record<string, unknown>;
    Object.defineProperty(snapshot, "title", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "first title" : "different title";
      },
    });

    expect(normalizeFeedback(feedback({ snapshot }), job())).toEqual({
      status: "invalid",
      invalid: {
        feedbackId: "feedback-1",
        candidateVersion: null,
        reason: "invalid_row",
        detailCode: "snapshot_not_json",
      },
    });
    expect(reads).toBe(0);
  });

  it.each(["accessor", "inherited"] as const)(
    "does not accept %s transcript segments as replay-ready projection data",
    (kind) => {
      let reads = 0;
      const transcriptJson: Record<string, unknown> =
        kind === "inherited" ? Object.create({ segments: [] }) : {};
      if (kind === "accessor") {
        Object.defineProperty(transcriptJson, "segments", {
          enumerable: true,
          get: () => {
            reads += 1;
            return [];
          },
        });
      }

      expect(normalizeFeedback(feedback(), job({ transcriptJson }))).toEqual({
        status: "invalid",
        invalid: {
          feedbackId: "feedback-1",
          candidateVersion: null,
          reason: "invalid_row",
          detailCode: "projection_invalid",
        },
      });
      expect(reads).toBe(0);
    }
  );

  it.each([
    ["accessor id", "id", "accessor", "identity_unavailable", null],
    ["missing updatedAt", "updatedAt", "missing", "identity_unavailable", "feedback-1"],
    ["inherited id", "id", "inherited", "identity_unavailable", null],
    ["accessor clipId", "clipId", "accessor", "projection_invalid", "feedback-1"],
    ["missing clipId", "clipId", "missing", "projection_invalid", "feedback-1"],
    ["inherited clipId", "clipId", "inherited", "projection_invalid", "feedback-1"],
  ] as const)(
    "rejects %s as a non-own projection data value",
    (_label, field, mode, detailCode, expectedFeedbackId) => {
      let reads = 0;
      const row = feedback() as FeedbackProjection & Record<string, unknown>;
      const prior = row[field];
      delete row[field];
      if (mode === "accessor") {
        Object.defineProperty(row, field, {
          enumerable: true,
          get: () => {
            reads += 1;
            return prior;
          },
        });
      } else if (mode === "inherited") {
        Object.setPrototypeOf(row, { [field]: prior });
      }

      expect(normalizeFeedback(row, job())).toEqual({
        status: "invalid",
        invalid: {
          feedbackId: expectedFeedbackId,
          candidateVersion: null,
          reason: "invalid_row",
          detailCode,
        },
      });
      expect(reads).toBe(0);
    }
  );

  it.each(["accessor", "missing", "inherited"] as const)(
    "rejects a Job id supplied as %s projection data without repeated reads",
    (mode) => {
      let reads = 0;
      const projectedJob = job() as unknown as Record<string, unknown>;
      delete projectedJob.id;
      if (mode === "accessor") {
        Object.defineProperty(projectedJob, "id", {
          enumerable: true,
          get: () => {
            reads += 1;
            return "job-1";
          },
        });
      } else if (mode === "inherited") {
        Object.setPrototypeOf(projectedJob, { id: "job-1" });
      }

      expect(normalizeFeedback(feedback(), projectedJob as unknown as JobProjection)).toEqual({
        status: "invalid",
        invalid: {
          feedbackId: "feedback-1",
          candidateVersion: null,
          reason: "invalid_row",
          detailCode: "projection_invalid",
        },
      });
      expect(reads).toBe(0);
    }
  );

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
