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

function candidateVersion(
  feedbackId: string,
  feedbackUpdatedAt: string,
  snapshotSha256: Sha256
): Sha256 {
  return sha256(`${feedbackId}\n${feedbackUpdatedAt}\n${snapshotSha256}`);
}

function approval(
  eventId: string,
  overrides: Partial<ApprovalEvent> = {}
): ApprovalEvent {
  const event: ApprovalEvent = {
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
  if (!Object.prototype.hasOwnProperty.call(overrides, "candidateVersion")) {
    event.candidateVersion = candidateVersion(
      event.feedbackId,
      event.feedbackUpdatedAt,
      event.snapshotSha256
    );
  }
  return event;
}

function rejection(
  eventId: string,
  overrides: Partial<RejectionEvent> = {}
): RejectionEvent {
  const event: RejectionEvent = {
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
  if (!Object.prototype.hasOwnProperty.call(overrides, "candidateVersion")) {
    event.candidateVersion = candidateVersion(
      event.feedbackId,
      event.feedbackUpdatedAt,
      event.snapshotSha256
    );
  }
  return event;
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
    const reject = rejection("reject-1");
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

  it("rejects a candidate version that does not match its frozen identity", () => {
    expectLedgerCode(
      () => parseLedger(lines(approval("mismatch", { candidateVersion: HASH_A }))),
      "invalid_event"
    );
  });

  it("does not invoke a polluted Object.prototype.toJSON while checking compact bytes", () => {
    const bytes = lines(approval("safe-event"));
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    let invoked = 0;
    let result: readonly ReviewEvent[] | undefined;
    let caught: unknown;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        enumerable: false,
        value: () => {
          invoked += 1;
          throw new Error("private toJSON contents");
        },
      });
      result = parseLedger(bytes);
    } catch (error) {
      caught = error;
    } finally {
      if (original === undefined) Reflect.deleteProperty(Object.prototype, "toJSON");
      else Object.defineProperty(Object.prototype, "toJSON", original);
    }

    expect(caught).toBeUndefined();
    expect(invoked).toBe(0);
    expect(result).toEqual([approval("safe-event")]);
  });

  it("rejects escaped lone surrogates before distinct feedback identities can hash alike", () => {
    const highA = approval("surrogate-a", { feedbackId: "\uD800" });
    const highB = approval("surrogate-b", { feedbackId: "\uD801" });
    expect(highA.candidateVersion).toBe(highB.candidateVersion);

    expectLedgerCode(() => parseLedger(lines(highA)), "invalid_event");
    expectLedgerCode(() => parseLedger(lines(highB)), "invalid_event");
  });
});

describe("foldLedger", () => {
  it("rejects duplicate event IDs without leaking the ID", () => {
    expectLedgerCode(
      () => foldLedger([approval("private-id"), rejection("private-id")]),
      "duplicate_event_id"
    );
  });

  it("rejects a direct event whose candidate version does not match its frozen identity", () => {
    expectLedgerCode(
      () => foldLedger([rejection("mismatch", { candidateVersion: HASH_A })]),
      "invalid_event"
    );
  });

  it("does not read inherited action or common fields from Object.prototype", () => {
    const originalSchema = Object.getOwnPropertyDescriptor(Object.prototype, "schemaVersion");
    const originalAction = Object.getOwnPropertyDescriptor(Object.prototype, "action");
    let invoked = 0;
    let caught: unknown;
    try {
      Object.defineProperty(Object.prototype, "schemaVersion", {
        configurable: true,
        enumerable: true,
        get: () => {
          invoked += 1;
          return 1;
        },
      });
      Object.defineProperty(Object.prototype, "action", {
        configurable: true,
        enumerable: true,
        get: () => {
          invoked += 1;
          return "approve";
        },
      });
      foldLedger([{} as ReviewEvent]);
    } catch (error) {
      caught = error;
    } finally {
      if (originalSchema === undefined) Reflect.deleteProperty(Object.prototype, "schemaVersion");
      else Object.defineProperty(Object.prototype, "schemaVersion", originalSchema);
      if (originalAction === undefined) Reflect.deleteProperty(Object.prototype, "action");
      else Object.defineProperty(Object.prototype, "action", originalAction);
    }

    expect(caught).toMatchObject({ code: "invalid_event", message: "invalid_event" });
    expect(invoked).toBe(0);
  });

  it("rejects an own accessor without invoking it or leaking its private error", () => {
    const malicious: Record<string, unknown> = {};
    let invoked = 0;
    Object.defineProperty(malicious, "schemaVersion", {
      enumerable: true,
      get: () => {
        invoked += 1;
        throw new Error("private getter contents");
      },
    });

    let caught: unknown;
    try {
      foldLedger([malicious as unknown as ReviewEvent]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "invalid_event", message: "invalid_event" });
    expect(invoked).toBe(0);
  });

  it("normalizes throwing proxy reflection traps to a safe ledger error", () => {
    const privateMessage = "private proxy contents";
    const malicious = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(privateMessage);
        },
      }
    );

    let caught: unknown;
    try {
      foldLedger([malicious as ReviewEvent]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "invalid_event", message: "invalid_event" });
    expect(String(caught)).not.toContain(privateMessage);
  });

  it.each([
    ["event ID", approval("\uD800")],
    ["feedback ID", approval("bad-feedback", { feedbackId: "\uD800" })],
    ["clip ID", approval("bad-clip", { clipId: "\uD800" })],
    ["job ID", approval("bad-job", { jobId: "\uD800" })],
    ["user ID", approval("bad-user", { userId: "\uD800" })],
    ["rejection reason", rejection("bad-reason", { reason: "\uD800" })],
    ["correction target ID", correction("bad-target", "\uD800")],
    ["correction reason", correction("bad-correction", "target", { reason: "\uD800" })],
  ] satisfies readonly (readonly [string, ReviewEvent])[])(
    "rejects malformed Unicode in direct %s",
    (_label, event) => {
      expectLedgerCode(() => foldLedger([event]), "invalid_event");
    }
  );

  it.each([
    ["forward target", [correction("c", "later"), rejection("later")]],
    ["correction target", [rejection("r"), correction("c1", "r"), correction("c2", "c1")]],
    ["inactive target", [rejection("r"), correction("c1", "r"), correction("c2", "r")]],
    ["active candidate conflict", [rejection("r"), approval("a")]],
    [
      "approval across versions conflict",
      [approval("a1"), approval("a2", { feedbackUpdatedAt: "2026-08-28T12:00:01.000Z" })],
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
    const replacement = approval("approval-new", {
      feedbackUpdatedAt: "2026-08-28T12:00:01.000Z",
    });
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
          approval("wrong-set", {
            feedbackUpdatedAt: "2026-08-28T12:00:01.000Z",
            set: "holdout",
          }),
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
    const first = rejection("z-event", { feedbackId: "z-feedback" });
    const second = rejection("a-event", { feedbackId: "a-feedback" });
    const [low, high] = [first, second].sort((left, right) =>
      Buffer.compare(Buffer.from(left.candidateVersion), Buffer.from(right.candidateVersion))
    );
    const left = foldLedger([high, low]);
    const right = foldLedger([low, high]);

    expect(left.activeDecisions.map((event) => event.candidateVersion)).toEqual([
      low.candidateVersion,
      high.candidateVersion,
    ]);
    expect(canonicalLedgerState(left)).toBe(canonicalLedgerState(right));
    expect(canonicalLedgerState(left)).toBe(canonicalJson(left));
  });

  it("sorts Unicode identifiers by UTF-8 bytes rather than JavaScript UTF-16 code units", () => {
    const bmp = "\uE000";
    const astral = "\u{10000}";
    expect(astral < bmp).toBe(true);
    expect(Buffer.compare(Buffer.from(bmp), Buffer.from(astral))).toBeLessThan(0);

    const state = foldLedger([
      approval("astral-event", { feedbackId: astral }),
      approval("bmp-event", { feedbackId: bmp }),
    ]);

    expect(state.destinationLocks.map((lock) => lock.feedbackId)).toEqual([bmp, astral]);
  });

  it("canonicalizes histories that differ only in correction metadata identically", () => {
    const target = rejection("target-event");
    const first = foldLedger([
      target,
      correction("correction-a", target.eventId, {
        occurredAt: "2026-08-29T10:00:01.000Z",
        reason: "first private reason",
      }),
    ]);
    const second = foldLedger([
      target,
      correction("correction-b", target.eventId, {
        occurredAt: "2026-08-29T10:00:02.000Z",
        reason: "second private reason",
      }),
    ]);

    expect(canonicalLedgerState(first)).toBe(canonicalLedgerState(second));
  });

  it("accepts reordered direct event keys while serialized JSONL remains ordered", () => {
    const event = approval("reordered-event");
    const reordered = {
      action: event.action,
      schemaVersion: event.schemaVersion,
      set: event.set,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      candidateVersion: event.candidateVersion,
      feedbackId: event.feedbackId,
      feedbackUpdatedAt: event.feedbackUpdatedAt,
      snapshotSha256: event.snapshotSha256,
      clipId: event.clipId,
      jobId: event.jobId,
      userId: event.userId,
    } as ApprovalEvent;

    expect(foldLedger([reordered])).toEqual(foldLedger([event]));
    expectLedgerCode(() => parseLedger(lines(reordered)), "invalid_event");
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

  it("treats a non-matching current feedback identity as missing before other checks", () => {
    expect(
      classifyApprovalFreshness(
        freshApproval,
        projection(snapshot, { id: "different-feedback" })
      )
    ).toEqual({ fresh: false, reason: "missing" });
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

  it.each(["approval", "current"] as const)(
    "rejects an own accessor on %s without invoking or leaking it",
    (target) => {
      const snapshot = { safe: true };
      const safeApproval = approval("safe-approval", {
        snapshotSha256: sha256(canonicalJson(snapshot)),
      });
      const safeCurrent = projection(snapshot);
      const malicious = target === "approval" ? safeApproval : safeCurrent;
      let invoked = 0;
      Object.defineProperty(malicious, "id" in malicious ? "id" : "feedbackId", {
        configurable: true,
        enumerable: true,
        get: () => {
          invoked += 1;
          throw new Error("private freshness getter");
        },
      });

      let caught: unknown;
      try {
        classifyApprovalFreshness(
          (target === "approval" ? malicious : safeApproval) as ApprovalEvent,
          (target === "current" ? malicious : safeCurrent) as FeedbackProjection
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "invalid_event", message: "invalid_event" });
      expect(String(caught)).not.toContain("private freshness getter");
      expect(invoked).toBe(0);
    }
  );

  it.each(["approval", "current"] as const)(
    "captures %s proxy own data without invoking its get trap",
    (target) => {
      const snapshot = { safe: true };
      const safeApproval = approval("safe-approval", {
        snapshotSha256: sha256(canonicalJson(snapshot)),
      });
      const safeCurrent = projection(snapshot);
      let invoked = 0;
      const proxied = new Proxy(target === "approval" ? safeApproval : safeCurrent, {
        get: () => {
          invoked += 1;
          throw new Error("private freshness proxy");
        },
      });

      const result = classifyApprovalFreshness(
        (target === "approval" ? proxied : safeApproval) as ApprovalEvent,
        (target === "current" ? proxied : safeCurrent) as FeedbackProjection
      );

      expect(result).toEqual({ fresh: true });
      expect(invoked).toBe(0);
    }
  );
});

describe("EffectiveLedger boundaries", () => {
  function expectStateCode(state: EffectiveLedger, code: LedgerError["code"]): void {
    expectLedgerCode(() => canonicalLedgerState(state), code);
    expectLedgerCode(() => buildCapacity(state, new Map()), code);
  }

  it.each([
    [
      "non-array root field",
      {
        activeDecisions: {},
        retiredTargetIds: [],
        destinationLocks: [],
      } as unknown as EffectiveLedger,
      "invalid_event",
    ],
    [
      "invalid active candidate formula",
      {
        activeDecisions: [approval("bad-candidate", { candidateVersion: HASH_A })],
        retiredTargetIds: [],
        destinationLocks: [{ feedbackId: "feedback-1", set: "eval" }],
      },
      "invalid_event",
    ],
    [
      "duplicate active candidate",
      {
        activeDecisions: [approval("event-a"), approval("event-b")],
        retiredTargetIds: [],
        destinationLocks: [{ feedbackId: "feedback-1", set: "eval" }],
      },
      "invalid_transition",
    ],
    [
      "duplicate active event ID",
      {
        activeDecisions: [
          rejection("same-event", { feedbackId: "feedback-a" }),
          rejection("same-event", { feedbackId: "feedback-b" }),
        ],
        retiredTargetIds: [],
        destinationLocks: [],
      },
      "invalid_transition",
    ],
    [
      "multiple active approvals for one feedback",
      {
        activeDecisions: [
          approval("approval-a"),
          approval("approval-b", { feedbackUpdatedAt: "2026-08-28T12:00:01.000Z" }),
        ],
        retiredTargetIds: [],
        destinationLocks: [{ feedbackId: "feedback-1", set: "eval" }],
      },
      "invalid_transition",
    ],
    [
      "contradictory destination locks",
      {
        activeDecisions: [],
        retiredTargetIds: [],
        destinationLocks: [
          { feedbackId: "feedback-1", set: "eval" },
          { feedbackId: "feedback-1", set: "holdout" },
        ],
      },
      "invalid_transition",
    ],
    [
      "approval without its matching lock",
      {
        activeDecisions: [approval("approval")],
        retiredTargetIds: [],
        destinationLocks: [{ feedbackId: "feedback-1", set: "holdout" }],
      },
      "invalid_transition",
    ],
    [
      "duplicate retired target",
      {
        activeDecisions: [],
        retiredTargetIds: ["retired", "retired"],
        destinationLocks: [],
      },
      "invalid_transition",
    ],
    [
      "empty retired target",
      {
        activeDecisions: [],
        retiredTargetIds: [""],
        destinationLocks: [],
      },
      "invalid_event",
    ],
    [
      "active event also retired",
      {
        activeDecisions: [rejection("same-event")],
        retiredTargetIds: ["same-event"],
        destinationLocks: [],
      },
      "invalid_transition",
    ],
    [
      "malformed destination lock ID",
      {
        activeDecisions: [],
        retiredTargetIds: [],
        destinationLocks: [
          { feedbackId: "\uD800", set: "eval" },
          { feedbackId: "\uD801", set: "holdout" },
        ],
      },
      "invalid_event",
    ],
    [
      "malformed retired target ID",
      {
        activeDecisions: [],
        retiredTargetIds: ["\uD800", "\uD801"],
        destinationLocks: [],
      },
      "invalid_event",
    ],
  ] as const)("rejects fabricated state with %s", (_label, state, code) => {
    expectStateCode(state as EffectiveLedger, code);
  });

  it("normalizes a throwing state accessor to invalid_event", () => {
    const state: Record<string, unknown> = {};
    Object.defineProperty(state, "activeDecisions", {
      enumerable: true,
      get: () => {
        throw new Error("private state contents");
      },
    });

    expectStateCode(state as unknown as EffectiveLedger, "invalid_event");
  });

  it("accepts reordered structural root and destination-lock keys", () => {
    const event = approval("approval");
    const reordered = {
      destinationLocks: [{ set: "eval", feedbackId: event.feedbackId }],
      activeDecisions: [event],
      retiredTargetIds: [],
    } as unknown as EffectiveLedger;
    const expected = foldLedger([event]);

    expect(canonicalLedgerState(reordered)).toBe(canonicalLedgerState(expected));
    expect(buildCapacity(reordered, new Map([[event.feedbackId, null]]))).toEqual(
      buildCapacity(expected, new Map([[event.feedbackId, null]]))
    );
  });

  it("does not use inherited numeric array accessors while capturing or accumulating", () => {
    const snapshot = { safe: true };
    const event = approval("approval", {
      snapshotSha256: sha256(canonicalJson(snapshot)),
    });
    const state = foldLedger([event]);
    const row = projection(snapshot);
    const bytes = lines(event);
    const operations = [
      () => parseLedger(bytes),
      () => canonicalLedgerState(state),
      () => buildCapacity(state, new Map([[event.feedbackId, row]])),
    ] as const;

    for (const operation of operations) {
      const original = Object.getOwnPropertyDescriptor(Array.prototype, "0");
      let invoked = 0;
      let caught: unknown;
      try {
        Object.defineProperty(Array.prototype, "0", {
          configurable: true,
          enumerable: false,
          get: () => {
            invoked += 1;
            throw new Error("private inherited array getter");
          },
          set: () => {
            invoked += 1;
            throw new Error("private inherited array setter");
          },
        });
        operation();
      } catch (error) {
        caught = error;
      } finally {
        if (original === undefined) Reflect.deleteProperty(Array.prototype, "0");
        else Object.defineProperty(Array.prototype, "0", original);
      }

      expect(caught).toBeUndefined();
      expect(invoked).toBe(0);
    }
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

  it("rejects a fabricated cross-destination duplicate feedback state", () => {
    const item = assigned("approval-a", "feedback-1", "eval", "job-eval", "user-eval", {
      n: 1,
    });
    const evalDuplicate = approval("approval-b", {
      feedbackId: "feedback-1",
      feedbackUpdatedAt: "2026-08-28T12:00:01.000Z",
      jobId: "job-eval",
      userId: "user-eval",
    });
    const holdout = approval("approval-c", {
      feedbackId: "feedback-1",
      feedbackUpdatedAt: "2026-08-28T12:00:02.000Z",
      jobId: "job-holdout",
      userId: "user-holdout",
      set: "holdout",
    });
    const holdoutDuplicate = approval("approval-d", {
      feedbackId: "feedback-1",
      feedbackUpdatedAt: "2026-08-28T12:00:03.000Z",
      jobId: "job-holdout",
      userId: "user-holdout",
      set: "holdout",
    });
    const malformedState: EffectiveLedger = {
      activeDecisions: [holdoutDuplicate, evalDuplicate, holdout, item.approval],
      retiredTargetIds: [],
      destinationLocks: [
        { feedbackId: "feedback-1", set: "eval" },
        { feedbackId: "feedback-1", set: "holdout" },
      ],
    };
    expectLedgerCode(
      () => buildCapacity(malformedState, new Map([[item.approval.feedbackId, item.row]])),
      "invalid_transition"
    );
  });
});
