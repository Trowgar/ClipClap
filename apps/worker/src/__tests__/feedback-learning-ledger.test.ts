import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import {
  buildCapacity,
  canonicalLedgerState,
  classifyApprovalFreshness,
  foldLedger,
  LedgerError,
  parseLedger,
  type EffectiveLedger,
} from "../feedback-learning/ledger";
import type {
  ApprovalEvent,
  CorrectionEvent,
  FeedbackProjection,
  RejectionEvent,
  ReviewEvent,
  Sha256,
  TargetSet,
} from "../feedback-learning/types";

const HASH_A = `sha256:${"a".repeat(64)}` as Sha256;
const HASH_B = `sha256:${"b".repeat(64)}` as Sha256;
const OCCURRED_AT = "2026-08-29T10:00:00.000Z";
const UPDATED_AT = "2026-08-28T12:00:00.000Z";

function approval(
  eventId: string,
  overrides: Partial<ApprovalEvent> = {}
): ApprovalEvent {
  return {
    schemaVersion: 1,
    eventId,
    action: "approve",
    occurredAt: OCCURRED_AT,
    candidateVersion: HASH_A,
    feedbackId: "feedback-1",
    feedbackUpdatedAt: UPDATED_AT,
    snapshotSha256: HASH_B,
    clipId: "clip-1",
    jobId: "job-1",
    userId: "user-1",
    set: "eval",
    ...overrides,
  };
}

function rejection(
  eventId: string,
  overrides: Partial<RejectionEvent> = {}
): RejectionEvent {
  return {
    schemaVersion: 1,
    eventId,
    action: "reject",
    occurredAt: OCCURRED_AT,
    candidateVersion: HASH_A,
    feedbackId: "feedback-1",
    feedbackUpdatedAt: UPDATED_AT,
    snapshotSha256: HASH_B,
    clipId: "clip-1",
    jobId: "job-1",
    userId: "user-1",
    reason: "private rejection reason",
    ...overrides,
  };
}

function correction(
  eventId: string,
  targetEventId: string,
  overrides: Partial<CorrectionEvent> = {}
): CorrectionEvent {
  return {
    schemaVersion: 1,
    eventId,
    action: "correct",
    occurredAt: OCCURRED_AT,
    operation: "retire",
    targetEventId,
    reason: "private correction reason",
    ...overrides,
  };
}

function lines(...events: readonly object[]): Buffer {
  return Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function expectLedgerCode(run: () => unknown, code: LedgerError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect(error).toMatchObject({ code, message: code });
    return;
  }
  throw new Error(`expected ${code}`);
}

function projection(
  snapshot: unknown,
  overrides: Partial<FeedbackProjection> = {}
): FeedbackProjection {
  return {
    id: "feedback-1",
    clipId: "clip-1",
    jobId: "job-1",
    userId: "user-1",
    verdict: "AS_IS",
    note: null,
    snapshot,
    evidenceKey: null,
    updatedAt: new Date(UPDATED_AT),
    ...overrides,
  };
}

describe("parseLedger", () => {
  it("allows a zero-byte ledger and parses every exact closed event variant", () => {
    expect(parseLedger(Buffer.alloc(0))).toEqual([]);

    const approve = approval("approve-1");
    const reject = rejection("reject-1", { candidateVersion: HASH_B });
    const correct = correction("correct-1", "reject-1");
    const parsed = parseLedger(lines(approve, reject, correct));

    expect(parsed).toEqual([approve, reject, correct]);
    expect((parsed[1] as RejectionEvent).reason).toBe("private rejection reason");
    expect((parsed[2] as CorrectionEvent).reason).toBe("private correction reason");
  });

  it.each([
    ["UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lines(approval("a"))])],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["invalid UTF-8 without a terminal LF", Buffer.from([0xff])],
  ])("rejects %s without including ledger bytes in the error", (_label, bytes) => {
    expectLedgerCode(() => parseLedger(bytes), "invalid_encoding");
  });

  it.each([
    ["no terminal LF", Buffer.from(JSON.stringify(approval("a")))],
    ["CRLF", Buffer.from(`${JSON.stringify(approval("a"))}\r\n`)],
    ["two terminal LFs", Buffer.from(`${JSON.stringify(approval("a"))}\n\n`)],
    ["blank middle line", Buffer.from(`${JSON.stringify(approval("a"))}\n\n${JSON.stringify(rejection("b"))}\n`)],
    ["pretty JSON", Buffer.from(`${JSON.stringify(approval("a"), null, 2)}\n`)],
    ["non-object JSON", Buffer.from("[]\n")],
  ])("rejects non-canonical JSONL: %s", (_label, bytes) => {
    expectLedgerCode(() => parseLedger(bytes), "invalid_jsonl");
  });

  it("rejects valid JSON with the wrong field order", () => {
    const event = approval("approve-1");
    const wrongOrder = {
      eventId: event.eventId,
      schemaVersion: event.schemaVersion,
      action: event.action,
      occurredAt: event.occurredAt,
      candidateVersion: event.candidateVersion,
      feedbackId: event.feedbackId,
      feedbackUpdatedAt: event.feedbackUpdatedAt,
      snapshotSha256: event.snapshotSha256,
      clipId: event.clipId,
      jobId: event.jobId,
      userId: event.userId,
      set: event.set,
    };

    expectLedgerCode(() => parseLedger(lines(wrongOrder)), "invalid_event");
  });

  it.each([
    ["schema version", { ...approval("a"), schemaVersion: 2 }],
    ["extra key", { ...approval("a"), privateExtra: "must not pass" }],
    ["approve reason", { ...approval("a"), reason: "wrong union" }],
    ["reject set", { ...rejection("a"), set: "eval" }],
    ["correct frozen key", { ...correction("a", "b"), feedbackId: "feedback-1" }],
    ["empty identifier", { ...approval("a"), jobId: "" }],
    ["empty reason", { ...rejection("a"), reason: "" }],
    ["uppercase hash", { ...approval("a"), candidateVersion: `sha256:${"A".repeat(64)}` }],
    ["bare hash", { ...approval("a"), snapshotSha256: "b".repeat(64) }],
    ["non-millisecond time", { ...approval("a"), occurredAt: "2026-08-29T10:00:00Z" }],
    ["impossible time", { ...approval("a"), occurredAt: "2026-02-30T10:00:00.000Z" }],
    ["unknown set", { ...approval("a"), set: "training" }],
    ["unknown operation", { ...correction("a", "b"), operation: "replace" }],
  ])("rejects invalid closed event schema: %s", (_label, event) => {
    expectLedgerCode(() => parseLedger(lines(event)), "invalid_event");
  });
});

describe("foldLedger", () => {
  it("rejects duplicate event IDs without leaking the ID", () => {
    expectLedgerCode(
      () => foldLedger([approval("private-id"), rejection("private-id", { candidateVersion: HASH_B })]),
      "duplicate_event_id"
    );
  });

  it.each([
    ["forward target", [correction("c", "later"), rejection("later")]],
    ["correction target", [rejection("r"), correction("c1", "r"), correction("c2", "c1")]],
    ["inactive target", [rejection("r"), correction("c1", "r"), correction("c2", "r")]],
    ["active candidate conflict", [rejection("r"), approval("a")]],
    [
      "approval across versions conflict",
      [approval("a1"), approval("a2", { candidateVersion: HASH_B })],
    ],
  ] satisfies readonly (readonly [string, readonly ReviewEvent[]])[])(
    "rejects invalid transition: %s",
    (_label, events) => {
      expectLedgerCode(() => foldLedger(events), "invalid_transition");
    }
  );

  it("retires decisions, permits a replacement, and permanently preserves the first set lock", () => {
    const first = approval("approval-old");
    const retired = correction("correction-1", first.eventId);
    const replacement = approval("approval-new", { candidateVersion: HASH_B });
    const state = foldLedger([first, retired, replacement]);

    expect(state).toEqual({
      activeDecisions: [replacement],
      retiredTargetIds: ["approval-old"],
      destinationLocks: [{ feedbackId: "feedback-1", set: "eval" }],
    });
    expectLedgerCode(
      () =>
        foldLedger([
          first,
          retired,
          approval("wrong-set", { candidateVersion: HASH_B, set: "holdout" }),
        ]),
      "invalid_transition"
    );
  });

  it("does not create a destination lock for a rejection", () => {
    const reject = rejection("reject-1");
    expect(foldLedger([reject])).toEqual({
      activeDecisions: [reject],
      retiredTargetIds: [],
      destinationLocks: [],
    });
  });

  it("sorts with byte comparison and canonicalizes equivalent effective states identically", () => {
    const low = rejection("z-event", {
      candidateVersion: `sha256:${"0".repeat(64)}`,
      feedbackId: "z-feedback",
    });
    const high = rejection("a-event", {
      candidateVersion: `sha256:${"f".repeat(64)}`,
      feedbackId: "a-feedback",
    });
    const left = foldLedger([high, low]);
    const right = foldLedger([low, high]);

    expect(left.activeDecisions.map((event) => event.candidateVersion)).toEqual([
      low.candidateVersion,
      high.candidateVersion,
    ]);
    expect(canonicalLedgerState(left)).toBe(canonicalLedgerState(right));
    expect(canonicalLedgerState(left)).toBe(canonicalJson(left));
  });
});

describe("classifyApprovalFreshness", () => {
  const snapshot = { transcript: "private", score: 0.9 };
  const freshApproval = approval("approval", {
    snapshotSha256: sha256(canonicalJson(snapshot)),
  });

  it("returns fresh only for an exact AS_IS timestamp and canonical snapshot", () => {
    expect(classifyApprovalFreshness(freshApproval, projection(snapshot))).toEqual({ fresh: true });
  });

  it.each([
    ["missing wins", null, "missing"],
    [
      "verdict wins over timestamp and snapshot",
      projection({ changed: true }, { verdict: "BAD", updatedAt: new Date("2026-01-01T00:00:00.000Z") }),
      "verdict_changed",
    ],
    [
      "timestamp wins over snapshot",
      projection({ changed: true }, { updatedAt: new Date("2026-01-01T00:00:00.000Z") }),
      "updated_at_changed",
    ],
    ["snapshot is last", projection({ changed: true }), "snapshot_changed"],
  ] as const)("uses stale precedence: %s", (_label, current, reason) => {
    expect(classifyApprovalFreshness(freshApproval, current)).toEqual({ fresh: false, reason });
  });

  it("classifies invalid dates and invalid snapshots without throwing private values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(
      classifyApprovalFreshness(freshApproval, projection(snapshot, { updatedAt: new Date(NaN) }))
    ).toEqual({ fresh: false, reason: "updated_at_changed" });
    expect(classifyApprovalFreshness(freshApproval, projection(cyclic))).toEqual({
      fresh: false,
      reason: "snapshot_changed",
    });
  });
});

describe("buildCapacity", () => {
  function assigned(
    eventId: string,
    feedbackId: string,
    set: TargetSet,
    jobId: string,
    userId: string,
    snapshot: unknown
  ): { approval: ApprovalEvent; row: FeedbackProjection } {
    return {
      approval: approval(eventId, {
        candidateVersion: sha256(eventId),
        feedbackId,
        set,
        jobId,
        userId,
        snapshotSha256: sha256(canonicalJson(snapshot)),
      }),
      row: projection(snapshot, { id: feedbackId, jobId, userId }),
    };
  }

  it("keeps sets separate and counts fresh approvals and stale frozen reservations", () => {
    const evalFresh = assigned("z-event", "feedback-z", "eval", "job-a", "user-a", { n: 1 });
    const evalFresh2 = assigned("a-event", "feedback-a", "eval", "job-a", "user-b", { n: 2 });
    const holdoutStale = assigned(
      "holdout-event",
      "feedback-h",
      "holdout",
      "frozen-job",
      "frozen-user",
      { n: 3 }
    );
    const reject = rejection("reject", {
      candidateVersion: sha256("reject"),
      feedbackId: "feedback-r",
    });
    const state = foldLedger([evalFresh.approval, evalFresh2.approval, holdoutStale.approval, reject]);
    const capacity = buildCapacity(
      state,
      new Map([
        [evalFresh.approval.feedbackId, evalFresh.row],
        [evalFresh2.approval.feedbackId, evalFresh2.row],
        [holdoutStale.approval.feedbackId, null],
      ])
    );

    expect([...capacity.eval.jobCounts]).toEqual([["job-a", 2]]);
    expect([...capacity.eval.userCounts]).toEqual([
      ["user-a", 1],
      ["user-b", 1],
    ]);
    expect(capacity.eval.freshApprovals.map((event) => event.feedbackId)).toEqual([
      "feedback-a",
      "feedback-z",
    ]);
    expect(capacity.eval.staleReservations).toEqual([]);
    expect([...capacity.holdout.jobCounts]).toEqual([["frozen-job", 1]]);
    expect([...capacity.holdout.userCounts]).toEqual([["frozen-user", 1]]);
    expect(capacity.holdout.freshApprovals).toEqual([]);
    expect(capacity.holdout.staleReservations).toEqual([
      { approval: holdoutStale.approval, reason: "missing" },
    ]);
  });

  it("retired approvals free capacity without removing their destination lock", () => {
    const item = assigned("approval", "feedback-1", "eval", "job-1", "user-1", { n: 1 });
    const state = foldLedger([item.approval, correction("retire", item.approval.eventId)]);
    const capacity = buildCapacity(state, new Map([[item.approval.feedbackId, item.row]]));

    expect(capacity.eval.freshApprovals).toEqual([]);
    expect(capacity.eval.staleReservations).toEqual([]);
    expect([...capacity.eval.jobCounts]).toEqual([]);
    expect(state.destinationLocks).toEqual([{ feedbackId: "feedback-1", set: "eval" }]);
  });

  it("counts a feedback ID at most once when handed a duplicated effective state", () => {
    const item = assigned("approval-a", "feedback-1", "eval", "job-1", "user-1", { n: 1 });
    const duplicate = approval("approval-b", {
      ...item.approval,
      eventId: "approval-b",
      candidateVersion: HASH_B,
    });
    const malformedState: EffectiveLedger = {
      activeDecisions: [duplicate, item.approval],
      retiredTargetIds: [],
      destinationLocks: [{ feedbackId: "feedback-1", set: "eval" }],
    };
    const capacity = buildCapacity(
      malformedState,
      new Map([[item.approval.feedbackId, item.row]])
    );

    expect(capacity.eval.freshApprovals).toHaveLength(1);
    expect([...capacity.eval.jobCounts]).toEqual([["job-1", 1]]);
    expect([...capacity.eval.userCounts]).toEqual([["user-1", 1]]);
  });
});
