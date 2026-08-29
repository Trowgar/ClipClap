/**
 * Isolated response contract for the safe-end shadow audit. This intentionally
 * does not share ARC_AUDIT_SCHEMA: a safe-end observation has no authority to
 * publish arc flags or boundary-repair pointers.
 */
export const SAFE_END_AUDIT_SCHEMA = {
  name: "safe_end_audit",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "outcome", "reason", "extendToNode"],
          properties: {
            id: { type: "string" },
            outcome: {
              type: "string",
              enum: ["safe", "needs_afterbeat", "hard_handoff", "not_evaluable"],
            },
            reason: {
              type: ["string", "null"],
              enum: ["post_payoff_context", "next_question", "topic_switch", "unfinished_turn", null],
            },
            extendToNode: { type: ["integer", "null"] },
          },
        },
      },
    },
  },
} as const;

export type SafeEndAuditModelRow =
  | { id: string; outcome: "safe" | "not_evaluable"; reason: null; extendToNode: null }
  | { id: string; outcome: "needs_afterbeat"; reason: "post_payoff_context"; extendToNode: number }
  | {
      id: string;
      outcome: "hard_handoff";
      reason: "next_question" | "topic_switch" | "unfinished_turn";
      extendToNode: null;
    };

/** Reads only the closed, internally consistent subset. Model text is never
 * carried through this boundary, including in malformed answers. */
export function readSafeEndAuditRow(value: unknown): SafeEndAuditModelRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "extendToNode" ||
    keys[1] !== "id" ||
    keys[2] !== "outcome" ||
    keys[3] !== "reason"
  ) {
    return null;
  }
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (row.outcome === "safe" || row.outcome === "not_evaluable") {
    return row.reason === null && row.extendToNode === null
      ? { id: row.id, outcome: row.outcome, reason: null, extendToNode: null }
      : null;
  }
  if (row.outcome === "needs_afterbeat") {
    return row.reason === "post_payoff_context" && Number.isInteger(row.extendToNode)
      ? { id: row.id, outcome: row.outcome, reason: row.reason, extendToNode: row.extendToNode as number }
      : null;
  }
  if (row.outcome === "hard_handoff") {
    return (row.reason === "next_question" || row.reason === "topic_switch" || row.reason === "unfinished_turn") &&
      row.extendToNode === null
      ? { id: row.id, outcome: row.outcome, reason: row.reason, extendToNode: null }
      : null;
  }
  return null;
}
