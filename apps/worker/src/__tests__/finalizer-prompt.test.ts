import { describe, expect, it } from "vitest";
import {
  finalizerSystemPrompt,
  finalizerUserPrompt,
} from "../analyze-v2/prompts";
import { FINALIZER_SCHEMA } from "../analyze-v2/schemas";
import type { CriticVerdict, SentenceNode, SnappedClip } from "../analyze-v2/types";

function node(i: number, text: string, over: Partial<SentenceNode> = {}): SentenceNode {
  return {
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text,
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
    ...over,
  };
}

/** Node 3 is mid-flow (weak leading boundary + lowercase onset), so it must NOT
 *  carry a ¶ - the marker is what tells the judge which lines a trim may land
 *  on, and a marker on every line would make rules 5-7 unusable. */
const nodes = [
  node(0, "Уникальный ноль."),
  node(1, "Уникальная единица."),
  node(2, "Уникальная двойка."),
  node(3, "уникальная тройка.", { leadingStrength: 0.4 }),
  node(4, "Уникальная четвёрка."),
  node(5, "Уникальная пятёрка."),
];

function clip(
  id: string,
  startNode: number,
  endNode: number,
  over: Partial<CriticVerdict> = {}
): SnappedClip {
  const verdict: CriticVerdict = {
    id,
    keep: true,
    score: 0.8,
    grounded: true,
    selfContained: true,
    startNode,
    payoffNode: endNode,
    endNode,
    hookStartNode: startNode,
    hookEndNode: startNode,
    title: `Заголовок ${id}`,
    description: `Описание ${id}`,
    titleEvidenceNodes: [startNode],
    descriptionEvidenceNodes: [startNode],
    language: "ru",
    ...over,
  };
  return {
    verdict,
    startSec: nodes[startNode].start,
    endSec: nodes[endNode].end,
    hookStartSec: nodes[startNode].start,
    hookEndSec: nodes[startNode].end,
    payoffSec: nodes[endNode].start,
    shortMoment: false,
    finalStartNode: startNode,
    finalEndNode: endNode,
  };
}

/** drop_reason literals the schema will actually accept, null excluded. */
const SCHEMA_DROP_REASONS = (
  FINALIZER_SCHEMA.schema.properties.clips.items.properties.drop_reason
    .enum as readonly (string | null)[]
).filter((r): r is string => r !== null);

describe("finalizerSystemPrompt", () => {
  it("names the clip's language by name and ISO code", () => {
    const ru = finalizerSystemPrompt("ru", "Russian");
    expect(ru).toContain("Russian");
    expect(ru).toContain("(Russian, ru)");
    expect(ru).not.toContain("{{");

    // the template is substituted, not hardcoded to the fixtures' language
    const en = finalizerSystemPrompt("en", "English");
    expect(en).toContain("English");
    expect(en).not.toContain("Russian");
  });

  it("documents every drop_reason the schema accepts", () => {
    const prompt = finalizerSystemPrompt("ru", "Russian");
    expect(SCHEMA_DROP_REASONS.length).toBe(7);
    for (const reason of SCHEMA_DROP_REASONS) {
      expect(prompt, `drop_reason not explained in the prompt: ${reason}`).toContain(
        reason
      );
    }
  });

  it("names every output field the judge may emit", () => {
    const prompt = finalizerSystemPrompt("ru", "Russian");
    for (const field of [
      "verdict",
      "drop_reason",
      "duplicate_of",
      "shared_claim",
      "title_evidence_nodes",
      "trim_start_node",
    ]) {
      expect(prompt, `output field missing: ${field}`).toContain(field);
    }
  });

  it("carries a concrete rule for each of the six real defects", () => {
    const prompt = finalizerSystemPrompt("ru", "Russian");
    // Each entry is a defect the owner found by watching shipped clips. The
    // marker is a phrase from the REAL failing line: rules 4, 5 and 7 were
    // nominally covered by general phrasing already in the critic prompt and
    // shipped anyway, so a general restatement is not an acceptable
    // substitute and this test exists to make replacing one go red.
    const defects: Array<[string, string]> = [
      ["question title with no answer inside", "question title is valid ONLY when"],
      ["duplicate clips across the set", "watched the same thing twice"],
      ["meandering opening", "crosstalk runs before the real topic"],
      ["punchline outside the clip", "летающих пауков ядовитых"],
      ["answer whose question is outside", "Вообще-то думать это энергозатратно"],
      ["meta-instruction opening", "резюмируем"],
    ];
    for (const [defect, marker] of defects) {
      expect(prompt, `rule missing for defect: ${defect}`).toContain(marker);
    }
  });

  it("forbids moving the end or re-scoring, and protects honest emphasis", () => {
    const prompt = finalizerSystemPrompt("ru", "Russian");
    // the only boundary lever is a forward trim - ends are code-owned
    expect(prompt).toMatch(/may not move an end/i);
    expect(prompt).toMatch(/re-score/i);
    // the repetition rule must carry its carve-out or it eats good clips
    expect(prompt).toMatch(/NOT\s+repetition/);
  });
});

describe("finalizerUserPrompt", () => {
  it("renders every node of every clip with index, time and paragraph marker", () => {
    const user = finalizerUserPrompt([clip("c1", 0, 2), clip("c7", 3, 5)], nodes);

    expect(user).toContain("CLIP c1");
    expect(user).toContain("CLIP c7");
    // every node of both clips is present, addressed by index
    for (let i = 0; i <= 5; i++) {
      expect(user, `node #${i} not rendered`).toContain(`#${i} [`);
      expect(user).toContain(nodes[i].text);
    }
    // ¶ marks clean starts only - node 3 is mid-flow
    const line = (i: number) =>
      user.split("\n").find((l) => l.includes(`#${i} [`))!;
    expect(line(0).startsWith("¶ ")).toBe(true);
    expect(line(2).startsWith("¶ ")).toBe(true);
    expect(line(3).startsWith("¶ ")).toBe(false);
    expect(line(4).startsWith("¶ ")).toBe(true);
  });

  it("shows the payoff index so a proposed trim can stay before it", () => {
    const user = finalizerUserPrompt([clip("c1", 0, 4, { payoffNode: 3 })], nodes);
    expect(user).toContain("payoff #3");
  });

  it("shows the clip's own range ONLY - no context padding", () => {
    // The judge must see what the viewer sees. Padding is what lets the batch
    // critic "understand" a clip whose arc is broken outside its own edges,
    // which is the defect this stage exists to catch (rules 4 and 5).
    const user = finalizerUserPrompt([clip("c1", 2, 3)], nodes);
    expect(user).toContain("Уникальная двойка.");
    expect(user).toContain("уникальная тройка.");
    for (const outside of [
      "Уникальный ноль.",
      "Уникальная единица.",
      "Уникальная четвёрка.",
      "Уникальная пятёрка.",
    ]) {
      expect(user, `context leaked into the block: ${outside}`).not.toContain(
        outside
      );
    }
  });

  it("separates clips and survives an end node past the transcript", () => {
    const user = finalizerUserPrompt([clip("c1", 0, 1), clip("c2", 4, 5)], nodes);
    expect(user.split("\n---\n").length).toBe(2);

    const truncated = finalizerUserPrompt(
      [clip("c1", 4, 5, { endNode: 99, payoffNode: 5 })],
      nodes
    );
    expect(truncated).toContain("#5 [");
    expect(truncated).not.toContain("#6 [");
  });
});

describe("FINALIZER_SCHEMA", () => {
  const item = FINALIZER_SCHEMA.schema.properties.clips.items;

  it("is strict: no additional properties, every field required", () => {
    expect(FINALIZER_SCHEMA.strict).toBe(true);
    expect(FINALIZER_SCHEMA.schema.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
    const required = item.required as readonly string[];
    for (const field of [
      "id",
      "verdict",
      "drop_reason",
      "duplicate_of",
      "shared_claim",
      "title",
      "title_evidence_nodes",
      "trim_start_node",
    ]) {
      expect(required, `schema field not required: ${field}`).toContain(field);
    }
    // required must cover the declared properties exactly - strict mode rejects
    // a schema where they differ, and the model would omit whatever is missing
    expect([...required].sort()).toEqual(Object.keys(item.properties).sort());
  });

  it("closes the drop-reason vocabulary and allows null only for a ship", () => {
    const reasons = item.properties.drop_reason.enum as readonly (string | null)[];
    expect(reasons).toContain(null);
    for (const reason of [
      "duplicate",
      "unanswered_title",
      "broken_opening",
      "no_payoff",
      "redundant",
      "teaser_montage",
      "incoherent",
    ]) {
      expect(reasons, `drop_reason missing from enum: ${reason}`).toContain(reason);
    }
    expect(reasons.length).toBe(8);
    expect(item.properties.verdict.enum).toEqual(["ship", "drop"]);
  });

  it("carries evidence indices for a rewrite, capped like the critic's", () => {
    const evidence = item.properties.title_evidence_nodes;
    expect(evidence.type).toEqual(["array", "null"]);
    expect(evidence.items.type).toBe("integer");
    expect(evidence.maxItems).toBe(3);
    // a rewrite is a title plus its grounding - both nullable, so the pairing
    // is enforced by finalize.ts, but the field must exist to be checked
    expect(item.properties.title.type).toEqual(["string", "null"]);
    expect(item.properties.trim_start_node.type).toEqual(["integer", "null"]);
  });
});
