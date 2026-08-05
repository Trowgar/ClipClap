/** OpenAI json_schema strict bodies. Strict mode requires additionalProperties:false
 *  and every property listed in required. */
export const SCANNER_SCHEMA = {
  name: "scan_candidates",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["start_node", "end_node", "payoff_node", "interest", "type", "thread"],
          properties: {
            start_node: { type: "integer" },
            end_node: { type: "integer" },
            payoff_node: { type: "integer" },
            interest: { type: "number" },
            type: {
              type: "string",
              enum: ["reaction", "conflict", "insight", "story", "funny", "reveal", "question", "opinion", "other"],
            },
            thread: { type: ["string", "null"] },
          },
        },
      },
    },
  },
} as const;

export const CRITIC_SCHEMA = {
  name: "critic_verdicts",
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
          required: [
            "id", "keep", "score", "grounded", "self_contained",
            "start_node", "payoff_node", "end_node",
            "hook_start_node", "hook_end_node",
            "title", "description",
            "title_evidence_nodes", "description_evidence_nodes",
            "language",
          ],
          properties: {
            id: { type: "string" },
            keep: { type: "boolean" },
            score: { type: "number" },
            grounded: { type: "boolean" },
            self_contained: { type: "boolean" },
            start_node: { type: "integer" },
            payoff_node: { type: "integer" },
            end_node: { type: "integer" },
            hook_start_node: { type: "integer" },
            hook_end_node: { type: "integer" },
            title: { type: "string" },
            description: { type: "string" },
            title_evidence_nodes: { type: "array", items: { type: "integer" }, maxItems: 3 },
            description_evidence_nodes: { type: "array", items: { type: "integer" }, maxItems: 3 },
            language: { type: "string" },
          },
        },
      },
    },
  },
} as const;

/** FINALIZE: one verdict per shipped clip, judged as a set (spec §4.3).
 *
 *  Strict mode cannot express "drop_reason is required WHEN verdict is drop",
 *  so every field is required and nullable, and the conditional half is carried
 *  by the prompt and enforced by the code gates in finalize.ts. The enum is the
 *  part strict mode CAN enforce: an invented drop reason is impossible, so the
 *  telemetry histogram has a closed vocabulary by construction. */
export const FINALIZER_SCHEMA = {
  name: "clip_finalizer",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["clips"],
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id", "verdict", "drop_reason", "duplicate_of",
            "shared_claim", "title", "title_evidence_nodes", "trim_start_node",
          ],
          properties: {
            id: { type: "string" },
            verdict: { type: "string", enum: ["ship", "drop"] },
            drop_reason: {
              type: ["string", "null"],
              enum: [
                "duplicate", "unanswered_title", "broken_opening",
                "no_payoff", "redundant", "teaser_montage", "incoherent", null,
              ],
            },
            duplicate_of: { type: ["string", "null"] },
            shared_claim: { type: ["string", "null"] },
            title: { type: ["string", "null"] },
            title_evidence_nodes: {
              type: ["array", "null"],
              items: { type: "integer" },
              maxItems: 3,
            },
            trim_start_node: { type: ["integer", "null"] },
          },
        },
      },
    },
  },
} as const;

/** Single-candidate copy repair (same stage-2 model, spec §8). */
export const REPAIR_SCHEMA = {
  name: "copy_repair",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "description"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
    },
  },
} as const;

/** One row per clip offered to the end-extension pass. `end_node` is a PROPOSAL
 *  and changes nothing until applyExtension accepts it.
 *
 *  FIELD ORDER IS THE POINT, not house style. Structured output decodes in
 *  schema order, so `reason` sits before `extend` and `end_node` to make the
 *  model name the beat it is reaching for BEFORE it commits to a decision and an
 *  index - the same reason the field exists at all. The code never reads it; it
 *  is required so it cannot be skipped, and a proposal with no statable reason
 *  is exactly the one this stage least wants to receive. Moving it after the
 *  index would keep the field and drop its whole purpose.
 *
 *  `extend` and `end_node` are both required, and either alone could carry the
 *  answer: a model that means "no" still has to echo an index, and a model that
 *  means "yes" has to say so twice. The redundancy is deliberate - a half-formed
 *  answer is then a contradiction rather than an instruction, and the code
 *  resolves every contradiction by doing nothing (extendClipEnds reads `extend`
 *  first, and applyExtension refuses the echo as a no-op regardless). */
export const END_EXTENSION_SCHEMA = {
  name: "end_extension",
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
          required: ["id", "reason", "extend", "end_node"],
          properties: {
            id: { type: "string" },
            reason: { type: "string" },
            extend: { type: "boolean" },
            end_node: { type: "integer" },
          },
        },
      },
    },
  },
} as const;
