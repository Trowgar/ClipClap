import { describe, expect, it } from "vitest";

import { sha256 } from "../feedback-learning/canonical";
import type { CapacityState, EffectiveLedger, SetCapacity } from "../feedback-learning/ledger";
import * as selectModule from "../feedback-learning/select";
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
  } = {},
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
  overrides: Partial<ApprovalEvent> = {},
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
  holdoutCapacity: SetCapacity = setCapacity(),
): CapacityState {
  return { eval: evalCapacity, holdout: holdoutCapacity };
}

function ledger(activeDecisions: EffectiveLedger["activeDecisions"] = []): EffectiveLedger {
  const destinationLocks: EffectiveLedger["destinationLocks"][number][] = [];
  const seen = new Set<string>();
  for (const decision of activeDecisions) {
    if (decision.action === "approve" && !seen.has(decision.feedbackId)) {
      destinationLocks.push({
        feedbackId: decision.feedbackId,
        set: decision.set,
      });
      seen.add(decision.feedbackId);
    }
  }
  return { activeDecisions, retiredTargetIds: [], destinationLocks };
}

function stateFromDecisions(
  activeDecisions: EffectiveLedger["activeDecisions"],
  staleReasons: ReadonlyMap<
    string,
    "missing" | "verdict_changed" | "updated_at_changed" | "snapshot_changed"
  > = new Map(),
): { ledger: EffectiveLedger; capacity: CapacityState } {
  const sets = { eval: setCapacity(), holdout: setCapacity() };
  const mutable = {
    eval: {
      jobs: new Map<string, number>(),
      users: new Map<string, number>(),
      fresh: [] as ApprovalEvent[],
      stale: [] as {
        approval: ApprovalEvent;
        reason: "missing" | "verdict_changed" | "updated_at_changed" | "snapshot_changed";
      }[],
    },
    holdout: {
      jobs: new Map<string, number>(),
      users: new Map<string, number>(),
      fresh: [] as ApprovalEvent[],
      stale: [] as {
        approval: ApprovalEvent;
        reason: "missing" | "verdict_changed" | "updated_at_changed" | "snapshot_changed";
      }[],
    },
  };
  for (const decision of activeDecisions) {
    if (decision.action !== "approve") continue;
    const destination = mutable[decision.set];
    destination.jobs.set(decision.jobId, (destination.jobs.get(decision.jobId) ?? 0) + 1);
    destination.users.set(decision.userId, (destination.users.get(decision.userId) ?? 0) + 1);
    const reason = staleReasons.get(decision.feedbackId);
    if (reason === undefined) destination.fresh.push(decision);
    else destination.stale.push({ approval: decision, reason });
  }
  for (const set of ["eval", "holdout"] as const) {
    sets[set] = setCapacity({
      jobCounts: mutable[set].jobs,
      userCounts: mutable[set].users,
      freshApprovals: mutable[set].fresh,
      staleReservations: mutable[set].stale,
    });
  }
  return { ledger: ledger(activeDecisions), capacity: sets };
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
  it("exports only the safe public runtime entrypoint", () => {
    expect(Object.keys(selectModule)).toEqual(["selectCandidates"]);
  });

  it("applies invalid, stale, approval and rejection precedence before balancing", () => {
    const staleApproval = approval("stale", "holdout", {
      feedbackUpdatedAt: "2026-08-27T12:00:00.000Z",
    });
    const staleCurrent = normalized("stale");
    const staleRejection = rejection("stale");
    const approved = approval("approved");
    const rejected = rejection("rejected");
    const reviewState = stateFromDecisions(
      [staleApproval, staleRejection, approved, rejected],
      new Map([[staleApproval.feedbackId, "updated_at_changed"]]),
    );
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
        ledger: reviewState.ledger,
        capacity: reviewState.capacity,
      }),
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
    const otherSet = normalized("other-set", {
      jobId: "holdout-job",
      userId: "holdout-user",
    });
    const approvals = [
      approval("eval-job-1", "eval", {
        jobId: "job-full",
        userId: "user-full",
      }),
      approval("eval-job-2", "eval", {
        jobId: "job-full",
        userId: "user-full",
      }),
      approval("eval-user-3", "eval", {
        jobId: "job-other",
        userId: "user-full",
      }),
      approval("holdout-job-1", "holdout", {
        jobId: "holdout-job",
        userId: "holdout-user",
      }),
      approval("holdout-job-2", "holdout", {
        jobId: "holdout-job",
        userId: "holdout-user",
      }),
      approval("holdout-user-3", "holdout", {
        jobId: "holdout-other",
        userId: "holdout-user",
      }),
    ];
    const reviewState = stateFromDecisions(approvals);
    const result = selectCandidates(
      input({
        results: [both, otherSet],
        ledger: reviewState.ledger,
        capacity: reviewState.capacity,
      }),
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
    const approvals = [
      approval("starting-1", "eval", { jobId: "job-start", userId: "user-z" }),
      approval("starting-2", "eval", { jobId: "job-start", userId: "user-a" }),
      approval("starting-3", "eval", { jobId: "job-x", userId: "user-z" }),
    ];
    const reviewState = stateFromDecisions(approvals);
    const result = selectCandidates(
      input({
        results: [
          normalized("start-full", { jobId: "job-start", userId: "user-z" }),
          normalized("job-first", { jobId: "job-x", userId: "user-x" }),
          normalized("job-second", { jobId: "job-x", userId: "user-y" }),
          normalized("user-first", { jobId: "job-y", userId: "user-z" }),
          normalized("user-second", { jobId: "job-z", userId: "user-z" }),
        ],
        ledger: reviewState.ledger,
        capacity: reviewState.capacity,
      }),
    );

    expect(result.candidates.map((item) => item.feedbackId)).toEqual(["job-first", "user-first"]);
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
      }),
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
          normalized("a-2", {
            language: "a",
            updatedAt: "2026-08-28T11:00:00.000Z",
          }),
          normalized("b-1", { language: "b" }),
          normalized("b-2", {
            language: "b",
            updatedAt: "2026-08-28T11:00:00.000Z",
          }),
        ],
      }),
    );

    expect(result.candidates.map((item) => item.feedbackId)).toEqual(["a-1", "b-1"]);
    expect(result.exclusions.map((item) => [item.feedbackId, item.reason])).toEqual([
      ["a-2", "limit_reached"],
      ["b-2", "limit_reached"],
    ]);
  });

  it("checks provisional job and user caps before limit_reached", () => {
    const jobState = stateFromDecisions([
      approval("job-starting", "eval", {
        jobId: "job-shared",
        userId: "user-starting",
      }),
    ]);
    const jobCollision = selectCandidates(
      input({
        limit: 1,
        results: [
          normalized("job-first", { jobId: "job-shared", userId: "user-a" }),
          normalized("job-second", { jobId: "job-shared", userId: "user-b" }),
          normalized("limit-only", { jobId: "job-free", userId: "user-free" }),
        ],
        ledger: jobState.ledger,
        capacity: jobState.capacity,
      }),
    );
    expect(jobCollision.candidates.map((item) => item.feedbackId)).toEqual(["job-first"]);
    expect(jobCollision.exclusions.map((item) => [item.feedbackId, item.reason])).toEqual([
      ["job-second", "job_cap"],
      ["limit-only", "limit_reached"],
    ]);

    const userState = stateFromDecisions([
      approval("user-starting-1", "eval", {
        jobId: "job-starting-1",
        userId: "user-shared",
      }),
      approval("user-starting-2", "eval", {
        jobId: "job-starting-2",
        userId: "user-shared",
      }),
    ]);
    const userCollision = selectCandidates(
      input({
        limit: 1,
        results: [
          normalized("user-first", { jobId: "job-a", userId: "user-shared" }),
          normalized("user-second", { jobId: "job-b", userId: "user-shared" }),
        ],
        ledger: userState.ledger,
        capacity: userState.capacity,
      }),
    );
    expect(userCollision.exclusions.map((item) => item.reason)).toEqual(["user_cap"]);
  });

  it("keeps exact decisions ahead of starting caps", () => {
    const rejected = rejection("rejected-cap");
    const capApprovals = [
      approval("rejected-cap-slot-1", "eval", { jobId: rejected.jobId }),
      approval("rejected-cap-slot-2", "eval", { jobId: rejected.jobId }),
    ];
    const reviewState = stateFromDecisions([rejected, ...capApprovals]);
    const result = selectCandidates(
      input({
        results: [normalized("rejected-cap", { jobId: rejected.jobId })],
        ledger: reviewState.ledger,
        capacity: reviewState.capacity,
      }),
    );

    expect(result.exclusions.map((item) => item.reason)).toEqual(["already_rejected"]);
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
      }),
    );

    expect(result.candidates.map((item) => item.feedbackId)).toEqual(["retired"]);
    expect(result.exclusions).toEqual([]);
  });

  it("preserves exact candidate and exclusion field order", () => {
    const result = selectCandidates(
      input({
        limit: 1,
        results: [normalized("candidate"), normalized("excluded")],
      }),
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

    const capState = stateFromDecisions([
      approval("field-cap-1", "eval", { jobId: "job-full" }),
      approval("field-cap-2", "eval", { jobId: "job-full" }),
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
        ledger: capState.ledger,
        capacity: capState.capacity,
      }),
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
    expect(Object.keys(invalidAndCap.exclusions[1].cap ?? {})).toEqual(["limit", "occupied"]);
  });

  it("rejects malformed Unicode before byte ordering can collapse identities", () => {
    expect(() => selectCandidates(input({ results: [normalized("bad\ud800")] }))).toThrowError(
      "selection_input_invalid",
    );
  });

  it("rejects duplicate valid and non-null invalid feedback identities", () => {
    expect(() =>
      selectCandidates(input({ results: [normalized("duplicate"), normalized("duplicate")] })),
    ).toThrowError("selection_input_invalid");
    expect(() =>
      selectCandidates(
        input({
          results: [
            normalized("duplicate"),
            {
              status: "invalid",
              invalid: {
                feedbackId: "duplicate",
                candidateVersion: null,
                reason: "invalid_row",
                detailCode: "projection_invalid",
              },
            },
          ],
        }),
      ),
    ).toThrowError("selection_input_invalid");

    const nullInvalid = {
      status: "invalid" as const,
      invalid: {
        feedbackId: null,
        candidateVersion: null,
        reason: "invalid_row" as const,
        detailCode: "identity_unavailable" as const,
      },
    };
    const allowed = selectCandidates(input({ results: [nullInvalid, nullInvalid] }));
    expect(allowed.exclusions).toHaveLength(2);
  });

  it("rejects incoherent ledger and capacity state at the public boundary", () => {
    const approved = approval("capacity-approved");
    const coherent = capacity(
      setCapacity({
        jobCounts: new Map([[approved.jobId, 1]]),
        userCounts: new Map([[approved.userId, 1]]),
        freshApprovals: [approved],
      }),
    );

    expect(() =>
      selectCandidates(
        input({
          ledger: {
            activeDecisions: [approved],
            retiredTargetIds: [],
            destinationLocks: [],
          },
          capacity: coherent,
        }),
      ),
    ).toThrowError("selection_input_invalid");
    expect(() =>
      selectCandidates(
        input({
          ledger: ledger([approved]),
          capacity: capacity(),
        }),
      ),
    ).toThrowError("selection_input_invalid");
    expect(() =>
      selectCandidates(
        input({
          ledger: ledger([approved]),
          capacity: capacity(
            setCapacity({
              jobCounts: new Map([[approved.jobId, 2]]),
              userCounts: new Map([[approved.userId, 2]]),
              freshApprovals: [approved, approved],
            }),
          ),
        }),
      ),
    ).toThrowError("selection_input_invalid");
    expect(() =>
      selectCandidates(
        input({
          ledger: ledger(),
          capacity: capacity(setCapacity({ jobCounts: new Map([["fabricated", 1]]) })),
        }),
      ),
    ).toThrowError("selection_input_invalid");
    expect(() =>
      selectCandidates(
        input({
          ledger: ledger(),
          capacity: capacity(
            setCapacity({
              jobCounts: new Map([[approved.jobId, 1]]),
              userCounts: new Map([[approved.userId, 1]]),
              staleReservations: [{ approval: approved, reason: "missing" }],
            }),
          ),
        }),
      ),
    ).toThrowError("selection_input_invalid");

    const changedFrozenApproval = { ...approved, jobId: "changed-private-job" };
    expect(() =>
      selectCandidates(
        input({
          ledger: ledger([approved]),
          capacity: capacity(
            setCapacity({
              jobCounts: new Map([[changedFrozenApproval.jobId, 1]]),
              userCounts: new Map([[changedFrozenApproval.userId, 1]]),
              freshApprovals: [changedFrozenApproval],
            }),
          ),
        }),
      ),
    ).toThrowError("selection_input_invalid");
  });

  it("captures closed root fields without invoking accessors or proxy traps", () => {
    const changingInput = input() as SelectionInput;
    let changingInvoked = 0;
    Object.defineProperty(changingInput, "limit", {
      configurable: true,
      enumerable: true,
      get: () => {
        changingInvoked += 1;
        return changingInvoked === 1 ? 50 : 0;
      },
    });
    expect(() => selectCandidates(changingInput)).toThrowError("selection_input_invalid");
    expect(changingInvoked).toBe(0);

    const getterInput = input() as SelectionInput;
    let invoked = 0;
    Object.defineProperty(getterInput, "results", {
      configurable: true,
      enumerable: true,
      get: () => {
        invoked += 1;
        throw new Error("private selection getter sentinel");
      },
    });
    let getterError: unknown;
    try {
      selectCandidates(getterInput);
    } catch (error) {
      getterError = error;
    }
    expect(invoked).toBe(0);
    expect(getterError).toMatchObject({ message: "selection_input_invalid" });
    expect(String(getterError)).not.toContain("private selection getter sentinel");

    const proxy = new Proxy(input(), {
      get: () => {
        invoked += 1;
        throw new Error("private selection proxy sentinel");
      },
      ownKeys: () => {
        invoked += 1;
        throw new Error("private selection proxy sentinel");
      },
    });
    let proxyError: unknown;
    try {
      selectCandidates(proxy);
    } catch (error) {
      proxyError = error;
    }
    expect(invoked).toBe(0);
    expect(proxyError).toMatchObject({ message: "selection_input_invalid" });
    expect(String(proxyError)).not.toContain("private selection proxy sentinel");
  });

  it("does not depend on inherited Array prototype methods or numeric setters", () => {
    const names = ["map", "indexOf", "0"] as const;
    const originals = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const name of names)
      originals.set(name, Object.getOwnPropertyDescriptor(Array.prototype, name));
    let invoked = 0;
    let result: ReturnType<typeof selectCandidates> | undefined;
    let caught: unknown;
    try {
      for (const name of names.slice(0, -1)) {
        Object.defineProperty(Array.prototype, name, {
          configurable: true,
          value: () => {
            invoked += 1;
            throw new Error("private array method sentinel");
          },
          writable: true,
        });
      }
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        set: () => {
          invoked += 1;
          throw new Error("private array setter sentinel");
        },
      });
      result = selectCandidates(input({ results: [normalized("safe-array")] }));
    } catch (error) {
      caught = error;
    } finally {
      for (const [name, descriptor] of originals) {
        if (descriptor === undefined) Reflect.deleteProperty(Array.prototype, name);
        else Object.defineProperty(Array.prototype, name, descriptor);
      }
    }
    expect(caught).toBeUndefined();
    expect(invoked).toBe(0);
    expect(result?.candidates[0]?.feedbackId).toBe("safe-array");
  });
});
