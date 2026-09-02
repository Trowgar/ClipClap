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
      "primary_disposition_required"
    );
    expect(() => trace.terminatePrimary("c0", "not_selected_for_critic")).not.toThrow();
    expect(() => trace.terminateRecovery("c0", "not_selected_for_critic" as never)).toThrow(
      "invalid_recovery_disposition"
    );
    expect(() => createCandidateTrace(["c0", "c0"])).toThrow("duplicate_candidate");
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
