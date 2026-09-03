import { describe, expect, it } from "vitest";

import {
  outcomeFreshnessSha256,
  OutcomeSchemaError,
  parseOutcomeCase,
  parseOutcomeLabel,
  type OutcomeCase,
  type OutcomeLabel,
} from "../feedback-quality/outcome-types";

function immutablePublicContract(labelValue: OutcomeLabel, caseValue: OutcomeCase): void {
  // @ts-expect-error Public labels are deeply immutable.
  labelValue.confidence = "medium";
  // @ts-expect-error Public expected-window arrays are immutable.
  labelValue.expected.approvedWindows.push({ start: 1, end: 2 });
  // @ts-expect-error Public window coordinates are immutable.
  labelValue.expected.approvedWindows[0].start = 0;
  // @ts-expect-error Materialized cases are immutable too.
  caseValue.analysisVersion = "changed";
}
void immutablePublicContract;

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;
const expected = { approvedWindows: [{ start: 120, end: 160 }], forbiddenWindows: [{ start: 200, end: 220 }] };

function label(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    action: "label",
    eventId: "event-1",
    occurredAt: "2026-09-02T20:00:00.000Z",
    caseVersion: sha("a"),
    set: "eval",
    disposition: "recoverable_false_negative",
    confidence: "high",
    expected,
    ...overrides,
  };
}

function outcomeCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    schemaVersion: 1,
    caseVersion: sha("a"),
    jobIdentitySha256: sha("b"),
    analyzeStepSha256: sha("c"),
    analysisVersion: "core-v4-recovery-v1",
    engineFingerprint: sha("d"),
    configSha256: sha("e"),
    sourceDurationSec: 300,
    transcriptSha256: sha("f"),
    sourceSha256: sha("1"),
    recordedResponsesSha256: sha("2"),
    jobUpdatedAt: "2026-09-02T23:00:00.000Z",
    reviewedAt: "2026-09-02T23:10:00.000Z",
    materializedAt: "2026-09-02T23:11:00.000Z",
    set: "eval",
    disposition: "recoverable_false_negative",
    confidence: "high",
    subsystem: "selection",
    expected,
  };
  const merged = { ...base, ...overrides };
  return { ...merged, freshnessSha256: Object.prototype.hasOwnProperty.call(overrides, "freshnessSha256") ? overrides.freshnessSha256 : outcomeFreshnessSha256(merged) };
}

describe("zero-outcome contracts", () => {
  it("parses a closed recoverable label with branded content identity", () => {
    const result: OutcomeLabel = parseOutcomeLabel(label());
    expect(result).toMatchObject({ caseVersion: sha("a"), disposition: "recoverable_false_negative", set: "eval" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.expected.approvedWindows)).toBe(true);
    expect(Object.isFrozen(result.expected.forbiddenWindows)).toBe(true);
    expect(Object.isFrozen(result.expected.approvedWindows[0])).toBe(true);
    expect(Object.isFrozen(result.expected.forbiddenWindows[0])).toBe(true);
  });

  it.each([
    ["top-level", { surprise: true }],
    ["free-form note", { note: "looks good" }],
    ["raw mutable job id", { jobId: "job-1" }],
  ])("rejects unknown %s label keys", (_name, extra) => {
    expect(() => parseOutcomeLabel(label(extra))).toThrow(OutcomeSchemaError);
  });

  it.each([null, undefined, true, 1, "label", [], new Date()])("rejects non-plain input with the schema error", (value) => {
    expect(() => parseOutcomeLabel(value)).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeCase(value)).toThrow(OutcomeSchemaError);
  });

  it("rejects inherited, symbol, accessor-backed, and missing own properties without invoking getters", () => {
    expect(() => parseOutcomeLabel(Object.assign(Object.create({ inherited: true }), label()))).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeLabel({ ...label(), [Symbol("hidden")]: true })).toThrow(OutcomeSchemaError);
    let reads = 0;
    const accessor = label();
    Object.defineProperty(accessor, "expected", { enumerable: true, get: () => { reads += 1; return expected; } });
    expect(() => parseOutcomeLabel(accessor)).toThrow(OutcomeSchemaError);
    expect(reads).toBe(0);
    const missing = label();
    delete missing.eventId;
    expect(() => parseOutcomeLabel(missing)).toThrow(OutcomeSchemaError);
  });

  it.each([
    "2026-09-02T20:00:00Z",
    "2026-09-02T22:00:00.000+02:00",
    "2026-9-2T20:00:00.000Z",
    "not-a-date",
  ])("rejects non-canonical UTC %s", (occurredAt) => {
    expect(() => parseOutcomeLabel(label({ occurredAt }))).toThrow(OutcomeSchemaError);
  });

  it.each(["a".repeat(64), `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, `sha512:${"a".repeat(64)}`])("rejects invalid SHA-256 identity %s", (caseVersion) => {
    expect(() => parseOutcomeLabel(label({ caseVersion }))).toThrow(OutcomeSchemaError);
  });

  it.each([
    { approvedWindows: [{ start: -1, end: 1 }], forbiddenWindows: [] },
    { approvedWindows: [{ start: 1, end: 1 }], forbiddenWindows: [] },
    { approvedWindows: [{ start: 1, end: Number.POSITIVE_INFINITY }], forbiddenWindows: [] },
    { approvedWindows: [{ start: 1, end: 3 }, { start: 2, end: 4 }], forbiddenWindows: [] },
    { approvedWindows: [{ start: 1, end: 3 }], forbiddenWindows: [{ start: 2, end: 4 }] },
    { approvedWindows: Array.from({ length: 65 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 })), forbiddenWindows: [] },
  ])("rejects invalid, overlapping, or unbounded windows", (badExpected) => {
    expect(() => parseOutcomeLabel(label({ expected: badExpected }))).toThrow(OutcomeSchemaError);
  });

  it("enforces disposition and set constraints", () => {
    expect(() => parseOutcomeLabel(label({ expected: { approvedWindows: [], forbiddenWindows: [] } }))).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeLabel(label({ disposition: "valid_empty" }))).toThrow(OutcomeSchemaError);
    expect(parseOutcomeLabel(label({ disposition: "valid_empty", expected: { approvedWindows: [], forbiddenWindows: [{ start: 10, end: 20 }] } }))).toMatchObject({ disposition: "valid_empty", set: "eval" });
    const excluded = label({ disposition: "exclude", expected: { approvedWindows: [], forbiddenWindows: [] } });
    delete excluded.set;
    expect(parseOutcomeLabel(excluded)).toMatchObject({ disposition: "exclude" });
    expect(() => parseOutcomeLabel(label({ disposition: "exclude", expected: { approvedWindows: [], forbiddenWindows: [] } }))).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeLabel(label({ set: "training" }))).toThrow(OutcomeSchemaError);
  });

  it("never accepts an inherited set for an active label", () => {
    const raw = label();
    delete raw.set;
    let thrown: unknown;
    Object.defineProperty(Object.prototype, "set", { configurable: true, value: "eval" });
    try {
      parseOutcomeLabel(raw);
    } catch (error) {
      thrown = error;
    } finally {
      delete (Object.prototype as { set?: unknown }).set;
    }
    expect(thrown).toBeInstanceOf(OutcomeSchemaError);
  });

  it("parses an exact, pseudonymous materialized case", () => {
    const result: OutcomeCase = parseOutcomeCase(outcomeCase());
    expect(result).toMatchObject({ sourceDurationSec: 300, subsystem: "selection", disposition: "recoverable_false_negative" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("requires an exact privacy-safe freshness binding and bounded timestamp order", () => {
    const missing = outcomeCase();
    delete missing.freshnessSha256;
    expect(() => parseOutcomeCase(missing)).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeCase(outcomeCase({ freshnessSha256: sha("9") }))).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeCase(outcomeCase({ reviewedAt: "2026-09-02T22:59:00.000Z" }))).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeCase(outcomeCase({ materializedAt: "2026-09-02T23:09:00.000Z" }))).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeCase(outcomeCase({ reviewedAt: "2026-08-01T00:00:00.000Z" }))).toThrow(OutcomeSchemaError);
  });

  it("rejects mutable/private identifiers and free-form text from a case", () => {
    for (const extra of [{ jobId: "job-1" }, { userId: "user-1" }, { sourceKey: "private/key" }, { note: "review note" }]) {
      expect(() => parseOutcomeCase(outcomeCase(extra))).toThrow(OutcomeSchemaError);
    }
  });

  it("binds all windows to a finite positive source duration", () => {
    expect(() => parseOutcomeCase(outcomeCase({ sourceDurationSec: 0 }))).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeCase(outcomeCase({ sourceDurationSec: Number.NaN }))).toThrow(OutcomeSchemaError);
    expect(() => parseOutcomeCase(outcomeCase({ sourceDurationSec: 150 }))).toThrow(OutcomeSchemaError);
  });

  it("applies the same disposition/set contract to cases", () => {
    expect(() => parseOutcomeCase(outcomeCase({ disposition: "valid_empty" }))).toThrow(OutcomeSchemaError);
    const excluded = outcomeCase({ disposition: "exclude", expected: { approvedWindows: [], forbiddenWindows: [] } });
    delete excluded.set;
    expect(parseOutcomeCase(excluded)).toMatchObject({ disposition: "exclude" });
    expect(() => parseOutcomeCase(outcomeCase({ disposition: "exclude", expected: { approvedWindows: [], forbiddenWindows: [] } }))).toThrow(OutcomeSchemaError);
  });

  it("never accepts an inherited set for an active materialized case", () => {
    const raw = outcomeCase();
    delete raw.set;
    let thrown: unknown;
    Object.defineProperty(Object.prototype, "set", { configurable: true, value: "holdout" });
    try {
      parseOutcomeCase(raw);
    } catch (error) {
      thrown = error;
    } finally {
      delete (Object.prototype as { set?: unknown }).set;
    }
    expect(thrown).toBeInstanceOf(OutcomeSchemaError);
  });
});
