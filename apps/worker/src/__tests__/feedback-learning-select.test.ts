import { describe, expect, it } from "vitest";

import { sha256 } from "../feedback-learning/canonical";
import type { CapacityState, EffectiveLedger, SetCapacity } from "../feedback-learning/ledger";
import { selectCandidates, type SelectionInput } from "../feedback-learning/select";
import type {
  ApprovalEvent,
  NormalizedFeedbackResult,
  RejectionEvent,
  Sha256,
  TargetSet,
} from "../feedback-learning/types";

const SNAPSHOT_HASH = sha256("{}");
const UPDATED_AT = "2026-08-28T12:00:00.000Z";

function version(feedbackId: string, updatedAt = UPDATED_AT): Sha256 {
  return sha256(`${feedbackId}\n${updatedAt}\n${SNAPSHOT_HASH}`);
}

function normalized(
  feedbackId: string,
  overrides: {
    updatedAt?: string;
    jobId?: string;
    userId?: string;
    language?: string;
    clipKind?: string;
    tier?: "replay-ready" | "reference-only";
  } = {}
): NormalizedFeedbackResult {
  const updatedAt = overrides.updatedAt ?? UPDATED_AT;
  return {
    status: "valid",
    candidateVersion: version(feedbackId, updatedAt),
    record: {
      feedbackId,
      clipId: `clip-${feedbackId}`,
      jobId: overrides.jobId ?? `job-${feedbackId}`,
      userId: overrides.userId ?? `user-${feedbackId}`,
      verdict: "AS_IS",
      note: null,
      evidenceKey: null,
      updatedAt,
      snapshotCanonical: "{}",
      snapshotSha256: SNAPSHOT_HASH,
      jobProjectionId: overrides.jobId ?? `job-${feedbackId}`,
      jobPresent: true,
      transcriptPresent: true,
      segmentsIsArray: true,
      transcriptPartial: false,
      language: overrides.language ?? "en",
      clipKind: overrides.clipKind ?? "insight",
      tier: overrides.tier ?? "replay-ready",
      warnings: [],
      review: {
        title: `Title ${feedbackId}`,
        startTime: 1,
        endTime: 2,
        score: 0.8,
        transcript: `Transcript ${feedbackId}`,
        note: null,
        evidenceKey: null,
      },
    },
  };
}

function approval(
  feedbackId: string,
  set: TargetSet = "eval",
  overrides: Partial<ApprovalEvent> = {}
): ApprovalEvent {
  const feedbackUpdatedAt = overrides.feedbackUpdatedAt ?? UPDATED_AT;
  const snapshotSha256 = overrides.snapshotSha256 ?? SNAPSHOT_HASH;
  return {
    schemaVersion: 1,
    eventId: `approve-${feedbackId}`,
    action: "approve",
    occurredAt: "2026-08-29T10:00:00.000Z",
    candidateVersion:
      overrides.candidateVersion ??
      sha256(`${feedbackId}\n${feedbackUpdatedAt}\n${snapshotSha256}`),
    feedbackId,
    feedbackUpdatedAt,
    snapshotSha256,
    clipId: `clip-${feedbackId}`,
    jobId: `job-${feedbackId}`,
    userId: `user-${feedbackId}`,
    set,
    ...overrides,
  };
}

function rejection(feedbackId: string): RejectionEvent {
  return {
    schemaVersion: 1,
    eventId: `reject-${feedbackId}`,
    action: "reject",
    occurredAt: "2026-08-29T10:00:00.000Z",
    candidateVersion: version(feedbackId),
    feedbackId,
    feedbackUpdatedAt: UPDATED_AT,
    snapshotSha256: SNAPSHOT_HASH,
    clipId: `clip-${feedbackId}`,
    jobId: `job-${feedbackId}`,
    userId: `user-${feedbackId}`,
    reason: "private reason",
  };
}

function setCapacity(overrides: Partial<SetCapacity> = {}): SetCapacity {
  return {
    jobCounts: new Map(),
    userCounts: new Map(),
    freshApprovals: [],
    staleReservations: [],
    ...overrides,
  };
}

function capacity(
  evalCapacity: SetCapacity = setCapacity(),
  holdoutCapacity: SetCapacity = setCapacity()
): CapacityState {
  return { eval: evalCapacity, holdout: holdoutCapacity };
}

function ledger(activeDecisions: EffectiveLedger["activeDecisions"] = []): EffectiveLedger {
  return { activeDecisions, retiredTargetIds: [], destinationLocks: [] };
}

function input(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    results: [],
    targetSet: "eval",
    limit: 50,
    ledger: ledger(),
    capacity: capacity(),
    ...overrides,
  };
}

describe("selectCandidates", () => {
  it("applies invalid, stale, approval and rejection precedence before balancing", () => {
    const staleApproval = approval("stale", "holdout", {
      feedbackUpdatedAt: "2026-08-27T12:00:00.000Z",
    });
    const staleCurrent = normalized("stale");
    const staleRejection = rejection("stale");
    const approved = approval("approved");
    const rejected = rejection("rejected");
    const result = selectCandidates(
      input({
        results: [
          {
            status: "invalid",
            invalid: {
              feedbackId: null,
              candidateVersion: null,
              reason: "invalid_row",
              detailCode: "identity_unavailable",
            },
          },
          staleCurrent,
          normalized("approved"),
          normalized("rejected"),
        ],
        ledger: ledger([staleApproval, staleRejection, approved, rejected]),
        capacity: capacity(
          setCapacity({ freshApprovals: [approved] }),
          setCapacity({
            staleReservations: [{ approval: staleApproval, reason: "updated_at_changed" }],
          })
        ),
      })
    );

    expect(result.candidates).toEqual([]);
    expect(result.exclusions.map((item) => item.reason)).toEqual([
      "invalid_row",
      "already_approved",
      "already_rejected",
      "stale_review_requires_retirement",
    ]);
    expect(result.queried).toBe(result.candidates.length + result.exclusions.length);
  });

  it("uses only requested-set starting capacity and checks job before user", () => {
    const both = normalized("both", { jobId: "job-full", userId: "user-full" });
    const otherSet = normalized("other-set", { jobId: "holdout-job", userId: "holdout-user" });
    const result = selectCandidates(
      input({
        results: [both, otherSet],
        capacity: capacity(
          setCapacity({
            jobCounts: new Map([["job-full", 2]]),
            userCounts: new Map([["user-full", 3]]),
          }),
          setCapacity({
            jobCounts: new Map([["holdout-job", 2]]),
            userCounts: new Map([["holdout-user", 3]]),
          })
        ),
      })
    );

    expect(result.candidates.map((item) => item.feedbackId)).toEqual(["other-set"]);
    expect(result.exclusions).toContainEqual({
      schemaVersion: 1,
      feedbackId: "both",
      candidateVersion: version("both"),
      reason: "job_cap",
      cap: { limit: 2, occupied: 2 },
    });
  });

  it("does not let prefilter exclusions consume capacity and rechecks provisional job then user caps", () => {
    const result = selectCandidates(
      input({
        results: [
          normalized("start-full", { jobId: "job-start", userId: "user-z" }),
          normalized("job-first", { jobId: "job-x", userId: "user-x" }),
          normalized("job-second", { jobId: "job-x", userId: "user-y" }),
          normalized("user-first", { jobId: "job-y", userId: "user-z" }),
          normalized("user-second", { jobId: "job-z", userId: "user-z" }),
        ],
        capacity: capacity(
          setCapacity({
            jobCounts: new Map([
              ["job-start", 2],
              ["job-x", 1],
            ]),
            userCounts: new Map([["user-z", 2]]),
          })
        ),
      })
    );

    expect(result.candidates.map((item) => item.feedbackId)).toEqual([
      "job-first",
      "user-first",
    ]);
    expect(result.exclusions.map((item) => [item.feedbackId, item.reason])).toEqual([
      ["start-full", "job_cap"],
      ["job-second", "job_cap"],
      ["user-second", "user_cap"],
    ]);
  });

  it("sorts strata by UTF-8 bytes, rows by time then feedback bytes, and round-robins", () => {
    const earlier = "2026-08-28T11:00:00.000Z";
    const result = selectCandidates(
      input({
        results: [
          normalized("astral", { language: "\u{10000}", clipKind: "k" }),
          normalized("bmp-older", {
            language: "\ue000",
            clipKind: "k",
            updatedAt: earlier,
          }),
          normalized("bmp-new-b", { language: "\ue000", clipKind: "k" }),
          normalized("bmp-new-a", { language: "\ue000", clipKind: "k" }),
        ],
      })
    );

    expect(result.candidates.map((item) => item.feedbackId)).toEqual([
      "bmp-new-a",
      "astral",
      "bmp-new-b",
      "bmp-older",
    ]);
  });

  it("continues round-robin order after the limit and marks all remaining eligible rows", () => {
    const result = selectCandidates(
      input({
        limit: 2,
        results: [
          normalized("a-1", { language: "a" }),
          normalized("a-2", { language: "a", updatedAt: "2026-08-28T11:00:00.000Z" }),
          normalized("b-1", { language: "b" }),
          normalized("b-2", { language: "b", updatedAt: "2026-08-28T11:00:00.000Z" }),
        ],
      })
    );

    expect(result.candidates.map((item) => item.feedbackId)).toEqual(["a-1", "b-1"]);
    expect(result.exclusions.map((item) => [item.feedbackId, item.reason])).toEqual([
      ["a-2", "limit_reached"],
      ["b-2", "limit_reached"],
    ]);
  });

  it("does not let retired decisions block a candidate", () => {
    const result = selectCandidates(
      input({
        results: [normalized("retired")],
        ledger: {
          activeDecisions: [],
          retiredTargetIds: ["retired-event"],
          destinationLocks: [{ feedbackId: "retired", set: "eval" }],
        },
      })
    );

    expect(result.candidates.map((item) => item.feedbackId)).toEqual(["retired"]);
    expect(result.exclusions).toEqual([]);
  });

  it("preserves exact candidate and exclusion field order", () => {
    const result = selectCandidates(
      input({
        limit: 1,
        results: [normalized("candidate"), normalized("excluded")],
      })
    );

    expect(Object.keys(result.candidates[0])).toEqual([
      "schemaVersion",
      "candidateVersion",
      "targetSet",
      "feedbackId",
      "clipId",
      "jobId",
      "userId",
      "updatedAt",
      "snapshotSha256",
      "language",
      "clipKind",
      "tier",
      "warnings",
      "review",
    ]);
    expect(Object.keys(result.candidates[0].review)).toEqual([
      "title",
      "startTime",
      "endTime",
      "score",
      "transcript",
      "note",
      "evidenceKey",
    ]);
    expect(Object.keys(result.exclusions[0])).toEqual([
      "schemaVersion",
      "feedbackId",
      "candidateVersion",
      "reason",
    ]);

    const invalidAndCap = selectCandidates(
      input({
        results: [
          {
            status: "invalid",
            invalid: {
              feedbackId: null,
              candidateVersion: null,
              reason: "invalid_row",
              detailCode: "identity_unavailable",
            },
          },
          normalized("capped", { jobId: "job-full" }),
        ],
        capacity: capacity(
          setCapacity({ jobCounts: new Map([["job-full", 2]]) })
        ),
      })
    );
    expect(Object.keys(invalidAndCap.exclusions[0])).toEqual([
      "schemaVersion",
      "feedbackId",
      "candidateVersion",
      "reason",
      "detailCode",
    ]);
    expect(Object.keys(invalidAndCap.exclusions[1])).toEqual([
      "schemaVersion",
      "feedbackId",
      "candidateVersion",
      "reason",
      "cap",
    ]);
    expect(Object.keys(invalidAndCap.exclusions[1].cap ?? {})).toEqual([
      "limit",
      "occupied",
    ]);
  });

  it("rejects malformed Unicode before byte ordering can collapse identities", () => {
    expect(() =>
      selectCandidates(input({ results: [normalized("bad\ud800")] }))
    ).toThrowError("selection_input_invalid");
  });
});
