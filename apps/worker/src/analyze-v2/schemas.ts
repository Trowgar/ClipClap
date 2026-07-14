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
