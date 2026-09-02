import { describe, expect, it } from "vitest";
import { createCandidateTrace } from "../analyze-v2/candidate-trace";

describe("candidate trace", () => {
  it("accounts for each primary candidate exactly once", () => {
    const trace = createCandidateTrace(["c0", "c1"]);
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

  it("keeps recovery disposition separate from primary history", () => {
    const trace = createCandidateTrace(["c0"]);
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
    const trace = createCandidateTrace(["c0"]);
    expect(() => trace.terminateRecovery("c0", "shipped")).toThrow(
      "unregistered_recovery_candidate"
    );
    expect(() => trace.terminatePrimary("c0", "not_selected_for_critic")).not.toThrow();
    trace.registerRecoveryCandidates(["c0"]);
    expect(() => trace.terminateRecovery("c0", "not_selected_for_critic" as never)).toThrow(
      "invalid_recovery_disposition"
    );
    expect(() => createCandidateTrace(["c0", "c0"])).toThrow("duplicate_candidate");
  });

  it("fails closed until every known primary candidate has a terminal disposition", () => {
    const trace = createCandidateTrace(["c0", "c1"]);
    trace.terminatePrimary("c0", "shipped");

    expect(() => trace.summaryPrimary()).toThrow("incomplete_primary_disposition");
    expect(() => trace.serialize()).toThrow("incomplete_primary_disposition");
  });

  it("requires explicit, unique recovery enrollment and complete recovery accounting", () => {
    const trace = createCandidateTrace(["c0", "c1"]);
    trace.terminatePrimary("c0", "not_selected_for_critic");
    trace.terminatePrimary("c1", "shipped");

    expect(() => trace.registerRecoveryCandidates(["foreign"])).toThrow("unknown_candidate");
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
    const trace = createCandidateTrace(["c0"]);
    trace.terminatePrimary("c0", "shipped");
    expect(trace.summaryRecovery()).toEqual({});
    expect(trace.serialize().recovery).toEqual({});
  });

  it("serializes only closed safe metadata, never candidate prose", () => {
    const trace = createCandidateTrace(["safe-id"]);
    trace.terminatePrimary("safe-id", "shipped");
    const serialized = JSON.stringify(trace);
    expect(serialized).toContain("shipped");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("media");
    expect(serialized).not.toContain("model");
  });
});
