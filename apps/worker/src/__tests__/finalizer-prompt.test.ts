import { describe, expect, it } from "vitest";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import {
  finalizerSystemPrompt,
  finalizerUserPrompt,
} from "../analyze-v2/prompts";
import { FINALIZER_SCHEMA } from "../analyze-v2/schemas";
import type {
  ArcFlags,
  CriticVerdict,
  SentenceNode,
  SnappedClip,
} from "../analyze-v2/types";

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
      [
        "title promising what the speech never delivers",
        "promises what the speech never delivers",
      ],
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

  // ---------------------------------------------------------------------------
  // LENGTH EXCEPTION (spec 2026-08-10 §2e, task 5) - the owner's first
  // condition ("an explicit finalizer decision") in code: an overLength clip's
  // block gains one line, everything else stays byte-identical.
  // ---------------------------------------------------------------------------

  it("adds a LENGTH EXCEPTION line right after the header for an overLength clip", () => {
    const wide: SnappedClip = { ...clip("c1", 0, 2), overLength: true };
    const user = finalizerUserPrompt([wide], nodes);
    const lines = user.split("\n");
    const headerIdx = lines.findIndex((l) => l.startsWith("CLIP c1"));
    const durationSec = Math.round(wide.endSec - wide.startSec);
    expect(lines[headerIdx + 1]).toBe(
      `LENGTH EXCEPTION: this clip runs ${durationSec}s, over the 90s standard - ` +
        `ship it long only if every second earns its place.`
    );
    expect(lines[headerIdx + 2]).toBe("title: Заголовок c1"); // title follows immediately after
  });

  it("renders a clip WITHOUT the mark byte-identically to before this task", () => {
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes);
    const lines = user.split("\n");
    // the header is immediately followed by "title:" - no line was inserted
    expect(lines[0]).toBe(
      `CLIP c1 | score 0.80 | ${Math.round(nodes[2].end - nodes[0].start)}s | payoff #2`
    );
    expect(lines[1]).toBe("title: Заголовок c1");
    expect(user).not.toContain("LENGTH EXCEPTION");
  });

  it("renders identically whether overLength is absent or explicitly false - the render with the feature dark", () => {
    const absent = clip("c1", 0, 2);
    const explicitlyDark: SnappedClip = { ...absent, overLength: false };
    expect(finalizerUserPrompt([explicitlyDark], nodes)).toBe(
      finalizerUserPrompt([absent], nodes)
    );
  });
});

// ---------------------------------------------------------------------------
// AUDIT NOTE (spec 2026-08-10 task 6) - a clip whose STANDING `_arcFlags`
// carry `ok: false` on any axis gains one line, right after the LENGTH
// EXCEPTION line's position; a clip nothing flagged, or a dark run, renders
// BYTE-IDENTICALLY to before this task - the same discipline task 5's LENGTH
// EXCEPTION line and task 4's buildExtensionUser hint both used.
// ---------------------------------------------------------------------------

describe("finalizerUserPrompt - AUDIT NOTE (spec 2026-08-10 task 6)", () => {
  const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", ARC_AUDIT_FINALIZER_NOTES: "on" });

  const entryOnly: ArcFlags = {
    entry: { ok: false, defect: "mid_story" },
    exit: { ok: true },
    standalone: { ok: true },
  };
  const exitOnly: ArcFlags = {
    entry: { ok: true },
    exit: { ok: false, defect: "mid_thought" },
    standalone: { ok: true },
  };
  const allThree: ArcFlags = {
    entry: { ok: false, defect: "dangling_reference" },
    exit: { ok: false, defect: "setup_no_payoff" },
    standalone: { ok: false, missing: "кто такой Иван" },
  };
  // The spec's own worked example (§4, task 6): entry + standalone, no exit.
  const entryAndStandalone: ArcFlags = {
    entry: { ok: false, defect: "mid_story" },
    exit: { ok: true },
    standalone: { ok: false, missing: "что означает «там»..." },
  };
  const fullyOk: ArcFlags = {
    entry: { ok: true },
    exit: { ok: true },
    standalone: { ok: true },
  };

  const WEIGH =
    "Weigh this against your own reading - the audit sees the same text you do and can be wrong.";

  it("renders an entry-only note", () => {
    const arcFlags = new Map([["c1", entryOnly]]);
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
    expect(user).toContain(
      `AUDIT NOTE: a per-clip audit of this finished cut flagged the OPENING (mid_story). ${WEIGH}`
    );
  });

  it("renders an exit-only note", () => {
    const arcFlags = new Map([["c1", exitOnly]]);
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
    expect(user).toContain(
      `AUDIT NOTE: a per-clip audit of this finished cut flagged the ENDING (mid_thought). ${WEIGH}`
    );
  });

  it("renders an all-three note", () => {
    const arcFlags = new Map([["c1", allThree]]);
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
    expect(user).toContain(
      "AUDIT NOTE: a per-clip audit of this finished cut flagged the OPENING " +
        "(dangling_reference) and the ENDING (setup_no_payoff) and judged the clip " +
        `not self-contained (кто такой Иван). ${WEIGH}`
    );
  });

  it("matches the spec's own worked example verbatim (entry + standalone)", () => {
    const arcFlags = new Map([["c1", entryAndStandalone]]);
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
    expect(user).toContain(
      "AUDIT NOTE: a per-clip audit of this finished cut flagged the OPENING (mid_story) " +
        `and judged the clip not self-contained (что означает «там»...). ${WEIGH}`
    );
  });

  it("renders the note right after the header when the clip is not overLength", () => {
    const arcFlags = new Map([["c1", entryOnly]]);
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
    const lines = user.split("\n");
    expect(lines[0]).toBe(
      `CLIP c1 | score 0.80 | ${Math.round(nodes[2].end - nodes[0].start)}s | payoff #2`
    );
    expect(lines[1]).toContain("AUDIT NOTE:");
    expect(lines[2]).toBe("title: Заголовок c1");
  });

  it("renders the note after the LENGTH EXCEPTION line, not before it", () => {
    const wide: SnappedClip = { ...clip("c1", 0, 2), overLength: true };
    const arcFlags = new Map([["c1", entryOnly]]);
    const user = finalizerUserPrompt([wide], nodes, arcFlags, liveCfg);
    const lines = user.split("\n");
    expect(lines[1]).toContain("LENGTH EXCEPTION");
    expect(lines[2]).toContain("AUDIT NOTE:");
    expect(lines[3]).toBe("title: Заголовок c1");
  });

  it("renders a fully-ok clip's block byte-identically to the dark render, even with flags present", () => {
    const arcFlags = new Map([["c1", fullyOk]]);
    const flagged = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
    const dark = finalizerUserPrompt([clip("c1", 0, 2)], nodes);
    expect(flagged).toBe(dark);
    expect(flagged).not.toContain("AUDIT NOTE");
  });

  it("renders byte-identically to the feature-dark render when arcFlags/cfg are simply omitted", () => {
    // The discipline every prior prompt addition used (LENGTH EXCEPTION, the
    // extension hint): assert equality against a render with the feature dark,
    // not merely "no AUDIT NOTE string appears".
    const clips = [clip("c1", 0, 2), clip("c7", 3, 5)];
    expect(finalizerUserPrompt(clips, nodes)).toBe(
      finalizerUserPrompt(
        clips,
        nodes,
        new Map(),
        { arcFinalizerNotesEnabled: false, arcAuditEnabled: false }
      )
    );
  });

  // --- gating: BOTH switches must be on, checked at the point of lookup -----

  it("renders nothing when arcFinalizerNotesEnabled is on but arcAuditEnabled is off", () => {
    const auditDarkCfg = loadAnalyzeConfig({ ARC_AUDIT_FINALIZER_NOTES: "on" });
    expect(auditDarkCfg.arcAuditEnabled).toBe(false);
    const arcFlags = new Map([["c1", entryOnly]]); // flags present anyway
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, auditDarkCfg);
    expect(user).toBe(finalizerUserPrompt([clip("c1", 0, 2)], nodes));
    expect(user).not.toContain("AUDIT NOTE");
  });

  it("renders nothing when arcAuditEnabled is on but arcFinalizerNotesEnabled is off (the feature's own default)", () => {
    const notesDarkCfg = loadAnalyzeConfig({ ARC_AUDIT: "on" });
    expect(notesDarkCfg.arcFinalizerNotesEnabled).toBe(false);
    const arcFlags = new Map([["c1", entryOnly]]); // flags present anyway
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, notesDarkCfg);
    expect(user).toBe(finalizerUserPrompt([clip("c1", 0, 2)], nodes));
    expect(user).not.toContain("AUDIT NOTE");
  });

  it("renders nothing for a clip missing from the flags map even with the feature fully live", () => {
    const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, new Map(), liveCfg);
    expect(user).not.toContain("AUDIT NOTE");
  });

  // ---------------------------------------------------------------------------
  // THE `repaired` FOLLOW-UP (2026-08-11, real job cmsoqmy47008fuhfjosaxi86s).
  //
  // Before this fix, nothing ever cleared a STANDING flag once its repair
  // APPLIED: a clip whose exit extendClipEnds successfully widened still
  // carried `exit.ok: false`, so the informed finalizer read a stale accusation
  // about a defect the shipped clip no longer has. These tests pin the fix at
  // the prompt layer - `ok` is untouched (the detector's record), `repaired`
  // is what keeps a fixed axis out of the note.
  // ---------------------------------------------------------------------------

  describe("the repaired follow-up (2026-08-11)", () => {
    const entryOnlyRepaired: ArcFlags = {
      entry: { ok: false, defect: "mid_story", repaired: true },
      exit: { ok: true },
      standalone: { ok: true },
    };
    const exitOnlyRepaired: ArcFlags = {
      entry: { ok: true },
      exit: { ok: false, defect: "mid_thought", repaired: true },
      standalone: { ok: true },
    };
    const entryStandingExitRepaired: ArcFlags = {
      entry: { ok: false, defect: "dangling_reference" },
      exit: { ok: false, defect: "setup_no_payoff", repaired: true },
      standalone: { ok: true },
    };
    const entryRepairedExitStanding: ArcFlags = {
      entry: { ok: false, defect: "dangling_reference", repaired: true },
      exit: { ok: false, defect: "setup_no_payoff" },
      standalone: { ok: true },
    };
    const allRepaired: ArcFlags = {
      entry: { ok: false, defect: "mid_story", repaired: true },
      exit: { ok: false, defect: "mid_thought", repaired: true },
      standalone: { ok: true },
    };

    it("renders NO note when the only flagged axis (entry) is repaired", () => {
      const arcFlags = new Map([["c1", entryOnlyRepaired]]);
      const flagged = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
      const dark = finalizerUserPrompt([clip("c1", 0, 2)], nodes);
      expect(flagged).toBe(dark);
      expect(flagged).not.toContain("AUDIT NOTE");
    });

    it("renders NO note when the only flagged axis (exit) is repaired", () => {
      const arcFlags = new Map([["c1", exitOnlyRepaired]]);
      const flagged = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
      const dark = finalizerUserPrompt([clip("c1", 0, 2)], nodes);
      expect(flagged).toBe(dark);
      expect(flagged).not.toContain("AUDIT NOTE");
    });

    it("renders an ENTRY-ONLY note when entry is standing and exit is repaired", () => {
      const arcFlags = new Map([["c1", entryStandingExitRepaired]]);
      const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
      expect(user).toContain(
        `AUDIT NOTE: a per-clip audit of this finished cut flagged the OPENING (dangling_reference). ${WEIGH}`
      );
      // the repaired axis's own defect must not leak into the note text
      expect(user).not.toContain("setup_no_payoff");
      expect(user).not.toContain("the ENDING");
    });

    it("renders an EXIT-ONLY note when exit is standing and entry is repaired", () => {
      const arcFlags = new Map([["c1", entryRepairedExitStanding]]);
      const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
      expect(user).toContain(
        `AUDIT NOTE: a per-clip audit of this finished cut flagged the ENDING (setup_no_payoff). ${WEIGH}`
      );
      expect(user).not.toContain("dangling_reference");
      expect(user).not.toContain("the OPENING");
    });

    it("renders NO note when every not-ok axis is repaired, byte-identical to an unflagged clip", () => {
      const arcFlags = new Map([["c1", allRepaired]]);
      const flagged = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
      const dark = finalizerUserPrompt([clip("c1", 0, 2)], nodes);
      expect(flagged).toBe(dark);
      expect(flagged).not.toContain("AUDIT NOTE");
    });

    it("still renders a standalone clause for a repaired-entry clip whose standalone axis is standing", () => {
      // standalone has no `repaired` field at all - a repaired entry/exit must
      // not accidentally suppress an unrelated, still-standing standalone flag.
      const mixed: ArcFlags = {
        entry: { ok: false, defect: "mid_story", repaired: true },
        exit: { ok: true },
        standalone: { ok: false, missing: "кто такой Иван" },
      };
      const arcFlags = new Map([["c1", mixed]]);
      const user = finalizerUserPrompt([clip("c1", 0, 2)], nodes, arcFlags, liveCfg);
      expect(user).toContain(
        `AUDIT NOTE: a per-clip audit of this finished cut judged the clip not self-contained (кто такой Иван). ${WEIGH}`
      );
      expect(user).not.toContain("the OPENING");
    });
  });
});

describe("arcFinalizerNotesEnabled config knob", () => {
  it("arms only on the exact literal 'on', the same discipline as ARC_AUDIT", () => {
    expect(loadAnalyzeConfig({ ARC_AUDIT_FINALIZER_NOTES: "on" }).arcFinalizerNotesEnabled).toBe(
      true
    );
    expect(loadAnalyzeConfig({ ARC_AUDIT_FINALIZER_NOTES: "true" }).arcFinalizerNotesEnabled).toBe(
      false
    );
    expect(loadAnalyzeConfig({ ARC_AUDIT_FINALIZER_NOTES: "1" }).arcFinalizerNotesEnabled).toBe(
      false
    );
    expect(loadAnalyzeConfig({}).arcFinalizerNotesEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rule 7 (META-INSTRUCTION OPENING): recap-narration example (spec 2026-08-10
// task 9). The finalizer's rule 7 under-fired on non-Russian recap openers
// ("Cerita dimulai dengan memperlihatkan...", "In this video you saw us...")
// per engine-notes §5c; this adds one recap example to the rule's own list.
// ---------------------------------------------------------------------------

describe("finalizerSystemPrompt - rule 7 recap example (spec 2026-08-10 task 9)", () => {
  it("renders the new recap example in the meta-instruction-opening list", () => {
    const prompt = finalizerSystemPrompt("ru", "Russian");
    expect(prompt).toContain("In this video you saw us...");
  });

  it("leaves a distant, unrelated rule (the duplicate_of/shared_claim field line) byte-identical", () => {
    const prompt = finalizerSystemPrompt("ru", "Russian");
    expect(prompt).toContain(
      '- duplicate_of and shared_claim: only with drop_reason "duplicate", else null.'
    );
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
