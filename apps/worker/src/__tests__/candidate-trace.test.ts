import { describe, expect, it } from "vitest";
import {
  createCandidateTrace,
  PRIMARY_DISPOSITIONS,
  RECOVERY_DISPOSITIONS,
} from "../analyze-v2/candidate-trace";
import type { CandidateTraceDescriptor } from "../analyze-v2/candidate-trace";
import type { CandidateType } from "../analyze-v2/types";

function candidate(id: string, input: Partial<CandidateTraceDescriptor> = {}): CandidateTraceDescriptor {
  return {
    id,
    startNode: 0,
    payoffNode: 0,
    endNode: 0,
    interest: 0.5,
    type: "other",
    ...input,
  };
}

describe("candidate trace", () => {
  it("accounts for each primary candidate exactly once", () => {
    const trace = createCandidateTrace([candidate("c0"), candidate("c1")]);
    trace.terminatePrimary("c0", "critic_rejected");
    trace.terminatePrimary("c1", "not_selected_for_critic");

    expect(trace.summaryPrimary()).toEqual({
      critic_rejected: 1,
      not_selected_for_critic: 1,
    });
    expect(() => trace.terminatePrimary("c0", "shipped")).toThrow(
      "duplicate_disposition"
    );
    expect(() => trace.terminatePrimary("foreign", "shipped")).toThrow(
      "unknown_candidate"
    );
  });

  it("records a candidate that entered the lane without a usable critic verdict", () => {
    const trace = createCandidateTrace([candidate("c0")]);
    trace.terminatePrimary("c0", "critic_unjudged");

    expect(trace.summaryPrimary()).toEqual({ critic_unjudged: 1 });
    expect(PRIMARY_DISPOSITIONS).toContain("critic_unjudged");
    expect(RECOVERY_DISPOSITIONS).toContain("critic_unjudged");
  });

  it("keeps recovery disposition separate from primary history", () => {
    const trace = createCandidateTrace([candidate("c0")]);
    trace.terminatePrimary("c0", "not_selected_for_critic");
    trace.registerRecoveryCandidates(["c0"]);
    trace.terminateRecovery("c0", "critic_rejected");

    expect(trace.summaryPrimary()).toEqual({ not_selected_for_critic: 1 });
    expect(trace.summaryRecovery()).toEqual({ critic_rejected: 1 });
    expect(trace.serialize()).toEqual({
      primary: { not_selected_for_critic: 1 },
      recovery: { critic_rejected: 1 },
    });
    expect(() => trace.terminateRecovery("c0", "shipped")).toThrow(
      "duplicate_disposition"
    );
  });

  it("rejects unsafe recovery and serialization inputs", () => {
    const trace = createCandidateTrace([candidate("c0")]);
    expect(() => trace.terminateRecovery("c0", "shipped")).toThrow(
      "unregistered_recovery_candidate"
    );
    expect(() => trace.terminatePrimary("c0", "not_selected_for_critic")).not.toThrow();
    trace.registerRecoveryCandidates(["c0"]);
    expect(() => trace.terminateRecovery("c0", "not_selected_for_critic" as never)).toThrow(
      "invalid_recovery_disposition"
    );
    expect(() => trace.terminateRecovery("c0", "missing_range_rejected" as never)).toThrow(
      "invalid_recovery_disposition"
    );
    expect(() => createCandidateTrace([candidate("c0"), candidate("c0")])).toThrow("duplicate_candidate");
  });

  it("rejects malformed containers, descriptors, interest, and type vocabulary", () => {
    expect(() => createCandidateTrace(null as never)).toThrow("invalid_candidate_descriptors");
    expect(() => createCandidateTrace({} as never)).toThrow("invalid_candidate_descriptors");
    expect(() => createCandidateTrace([null as never])).toThrow("invalid_candidate_descriptor");
    expect(() => createCandidateTrace([candidate("high", { interest: 1.1 })])).toThrow("invalid_candidate_descriptor");
    expect(() => createCandidateTrace([candidate("low", { interest: -0.1 })])).toThrow("invalid_candidate_descriptor");
    expect(() => createCandidateTrace([candidate("prose", { type: "transcript prose" as never })])).toThrow("invalid_candidate_descriptor");
    expect(() => createCandidateTrace([candidate("nan", { interest: Number.NaN })])).toThrow("invalid_candidate_descriptor");

    const trace = createCandidateTrace([candidate("visual", { type: "visual_action" })]);
    trace.terminatePrimary("visual", "shipped");
    expect(trace.inspect()[0].type).toBe("visual_action");
  });

  it("fails closed until every known primary candidate has a terminal disposition", () => {
    const trace = createCandidateTrace([candidate("c0"), candidate("c1")]);
    trace.terminatePrimary("c0", "shipped");

    expect(() => trace.summaryPrimary()).toThrow("incomplete_primary_disposition");
    expect(() => trace.serialize()).toThrow("incomplete_primary_disposition");
  });

  it("requires explicit, unique recovery enrollment and complete recovery accounting", () => {
    const trace = createCandidateTrace([candidate("c0"), candidate("c1")]);
    trace.terminatePrimary("c0", "not_selected_for_critic");
    trace.terminatePrimary("c1", "shipped");

    expect(() => trace.registerRecoveryCandidates(["foreign"])).toThrow("unknown_candidate");
    expect(() => trace.registerRecoveryCandidates(["c0", "foreign"])).toThrow("unknown_candidate");
    expect(() => trace.terminateRecovery("c0", "shipped")).toThrow("unregistered_recovery_candidate");
    expect(() => trace.registerRecoveryCandidates(["c1"])).toThrow("primary_disposition_required");
    trace.registerRecoveryCandidates(["c0"]);
    expect(() => trace.registerRecoveryCandidates(["c0"])).toThrow("duplicate_recovery_registration");
    expect(() => trace.summaryRecovery()).toThrow("incomplete_recovery_disposition");
    expect(() => trace.serialize()).toThrow("incomplete_recovery_disposition");

    trace.terminateRecovery("c0", "shipped");
    expect(trace.serialize()).toEqual({
      primary: { not_selected_for_critic: 1, shipped: 1 },
      recovery: { shipped: 1 },
    });
  });

  it("allows an empty recovery lane when no candidates are enrolled", () => {
    const trace = createCandidateTrace([candidate("c0")]);
    trace.terminatePrimary("c0", "shipped");
    expect(trace.summaryRecovery()).toEqual({});
    expect(trace.serialize().recovery).toEqual({});
  });

  it("serializes only closed safe metadata, never candidate prose", () => {
    const trace = createCandidateTrace([candidate("safe-id")]);
    trace.terminatePrimary("safe-id", "shipped");
    const serialized = JSON.stringify(trace);
    expect(serialized).toContain("shipped");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("media");
    expect(serialized).not.toContain("model");
  });

  it("freezes disposition vocabularies so runtime mutation cannot widen them", () => {
    expect(Object.isFrozen(PRIMARY_DISPOSITIONS)).toBe(true);
    expect(Object.isFrozen(RECOVERY_DISPOSITIONS)).toBe(true);
    expect(() => (PRIMARY_DISPOSITIONS as unknown as string[]).push("bogus")).toThrow();

    const trace = createCandidateTrace([candidate("c0")]);
    expect(() => trace.terminatePrimary("c0", "bogus" as never)).toThrow("invalid_primary_disposition");
  });

  it("serializes counts in fixed disposition order regardless of termination order", () => {
    const first = createCandidateTrace([candidate("a"), candidate("b"), candidate("c")]);
    first.terminatePrimary("a", "shipped");
    first.terminatePrimary("b", "critic_rejected");
    first.terminatePrimary("c", "not_selected_for_critic");
    first.registerRecoveryCandidates(["c"]);
    first.terminateRecovery("c", "shipped");

    const reversed = createCandidateTrace([candidate("a"), candidate("b"), candidate("c")]);
    reversed.terminatePrimary("c", "not_selected_for_critic");
    reversed.terminatePrimary("b", "critic_rejected");
    reversed.terminatePrimary("a", "shipped");
    reversed.registerRecoveryCandidates(["c"]);
    reversed.terminateRecovery("c", "shipped");

    expect(JSON.stringify(first)).toBe(JSON.stringify(reversed));
    expect(Object.keys(first.serialize().primary)).toEqual([
      "not_selected_for_critic",
      "critic_rejected",
      "shipped",
    ]);
  });

  it("retains immutable safe descriptors and lane decisions for inspection", () => {
    const descriptor: { id: string; startNode: number; payoffNode: number; endNode: number; interest: number; type: CandidateType } = { id: "c0", startNode: 1, payoffNode: 2, endNode: 3, interest: 0.9, type: "question" };
    const trace = createCandidateTrace([descriptor]);
    trace.terminatePrimary("c0", "not_selected_for_critic");
    trace.registerRecoveryCandidates(["c0"]);
    trace.terminateRecovery("c0", "shipped");
    descriptor.interest = 0.1;
    descriptor.type = "changed" as CandidateType;

    expect(trace.inspect()).toEqual([
      {
        id: "c0",
        startNode: 1,
        payoffNode: 2,
        endNode: 3,
        interest: 0.9,
        type: "question",
        primary: "not_selected_for_critic",
        recovery: "shipped",
      },
    ]);
    expect(Object.isFrozen(trace.inspect()[0])).toBe(true);
  });
});
