import { describe, expect, it, vi } from "vitest";
import {
  ARC_AUDIT_BASE_TOKENS,
  ARC_AUDIT_TOKENS_PER_CLIP,
  arcAuditMaxOutputTokens,
  gateEntryFix,
  gateExitFix,
  runArcAudit,
  type ArcAuditTelemetry,
} from "../analyze-v2/arc-audit";
import { ARC_AUDIT_SYSTEM } from "../analyze-v2/prompts";
import { ARC_AUDIT_SCHEMA } from "../analyze-v2/schemas";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import type { CriticVerdict, SentenceNode, SnappedClip } from "../analyze-v2/types";

// ---------------------------------------------------------------------------
// Fixtures shared by every describe block below.
// ---------------------------------------------------------------------------

/** `count` nodes, 2s each, back to back, every one a clean start/end
 *  (leadingStrength/trailingStrength both 1.0) unless overridden by the
 *  caller. Mirrors end-extension.test.ts's own `nodes()` helper. */
function nodes(count: number): SentenceNode[] {
  const out: SentenceNode[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    out.push({
      index: i,
      start: t,
      end: t + 2,
      text: `Line ${i}.`,
      hasWords: true,
      trailingStrength: 1,
      leadingStrength: 1,
    });
    t += 2;
  }
  return out;
}

function verdict(id: string, startNode: number, endNode: number): CriticVerdict {
  return {
    id,
    keep: true,
    score: 0.8,
    grounded: true,
    selfContained: true,
    startNode,
    payoffNode: endNode,
    endNode,
    hookStartNode: startNode,
    hookEndNode: endNode,
    title: `title ${id}`,
    description: `description ${id}`,
    titleEvidenceNodes: [startNode],
    descriptionEvidenceNodes: [startNode],
    language: "en",
  };
}

function clip(
  n: SentenceNode[],
  id: string,
  startNode: number,
  endNode: number
): SnappedClip {
  return {
    verdict: verdict(id, startNode, endNode),
    startSec: n[startNode].start,
    endSec: n[endNode].end,
    finalStartNode: startNode,
    finalEndNode: endNode,
    hookStartSec: n[startNode].start,
    hookEndSec: n[endNode].end,
    payoffSec: n[endNode].end,
    shortMoment: false,
  };
}

const cfg = loadAnalyzeConfig({ ARC_AUDIT: "on" });

// ---------------------------------------------------------------------------
// gateEntryFix / gateExitFix - each gate built so the pointer is legal EXCEPT
// for the one under test, per feedback_test_matches_default: the gate must
// OVERCOME the accept default, not merely agree with it.
// ---------------------------------------------------------------------------

describe("gateEntryFix", () => {
  it("accepts a legal backward pointer: in-graph, within window, a clean start", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    const gate = gateEntryFix(5, c, n, cfg);
    expect(gate).toEqual({ ok: true, node: 5 });
  });

  it("refuses a non-integer pointer before touching the graph at all", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    for (const bad of [8.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(gateEntryFix(bad, c, n, cfg)).toEqual({ ok: false, reason: "not_an_index" });
    }
  });

  it("refuses a pointer that is not strictly BEFORE the clip's own start", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    // the clip's own start (a no-op) and a node forward of it - both illegal
    // in a way none of the other gates would catch: 10 and 12 are both
    // in-graph, within any reasonable window, and clean starts
    expect(gateEntryFix(10, c, n, cfg)).toEqual({ ok: false, reason: "wrong_direction" });
    expect(gateEntryFix(12, c, n, cfg)).toEqual({ ok: false, reason: "wrong_direction" });
  });

  // A negative index is "backward" by the pure number comparison above, so
  // this is the one construction that isolates outside_graph from
  // wrong_direction: a large positive out-of-range index would be caught by
  // wrong_direction first (11.0 in end-extension.ts's own gate ordering
  // notes: the direction gate is deliberately the one that needs no array
  // access, so it runs first).
  it("refuses an out-of-graph index that is otherwise backward", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    expect(gateEntryFix(-1, c, n, cfg)).toEqual({ ok: false, reason: "outside_graph" });
  });

  it("refuses a pointer further back than startExtensionWindowSec allows", () => {
    // clip starts at node 20 (40s); node 0 is 40s back, well past the 20s
    // default window, while still being backward, in-graph and a clean start.
    const n = nodes(30);
    const c = clip(n, "c0", 20, 23);
    expect(nodes(30)[20].start - nodes(30)[0].start).toBeGreaterThan(cfg.startExtensionWindowSec);
    expect(gateEntryFix(0, c, n, cfg)).toEqual({ ok: false, reason: "outside_window" });
  });

  it("admits a pointer exactly on the window boundary", () => {
    // node 10 sits exactly startExtensionWindowSec (20s) before node 20 at
    // this fixture's 2s-per-node spacing - the ">" in the gate must not be ">=".
    const n = nodes(30);
    const c = clip(n, "c0", 20, 23);
    expect(n[20].start - n[10].start).toBe(20);
    expect(gateEntryFix(10, c, n, cfg)).toEqual({ ok: true, node: 10 });
  });

  it("refuses a pointer that is not a clean start, and only for that reason", () => {
    const n = nodes(30);
    // dirty exactly one candidate node: weak leading boundary + lowercase onset
    n[5] = { ...n[5], leadingStrength: 0.2, text: "mid-sentence continuation." };
    const c = clip(n, "c0", 10, 13);
    expect(gateEntryFix(5, c, n, cfg)).toEqual({ ok: false, reason: "not_clean_start" });
    // and the node right next to it, untouched, is still accepted - proving
    // the refusal is about node 5 specifically, not a global effect
    expect(gateEntryFix(4, c, n, cfg)).toEqual({ ok: true, node: 4 });
  });
});

describe("gateExitFix", () => {
  it("accepts a legal forward pointer: in-graph, within window", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    expect(gateExitFix(18, c, n, cfg)).toEqual({ ok: true, node: 18 });
  });

  it("refuses a non-integer pointer", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    for (const bad of [14.5, Number.NaN]) {
      expect(gateExitFix(bad, c, n, cfg)).toEqual({ ok: false, reason: "not_an_index" });
    }
  });

  it("refuses a pointer that is not strictly AFTER the clip's own end", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    expect(gateExitFix(13, c, n, cfg)).toEqual({ ok: false, reason: "wrong_direction" });
    expect(gateExitFix(11, c, n, cfg)).toEqual({ ok: false, reason: "wrong_direction" });
  });

  it("refuses an out-of-graph index that is otherwise forward", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    expect(gateExitFix(999, c, n, cfg)).toEqual({ ok: false, reason: "outside_graph" });
  });

  it("refuses a pointer further forward than endExtensionWindowSec allows", () => {
    const n = nodes(30);
    const c = clip(n, "c0", 10, 13);
    // node 29 is (29-13)*2 = 32s past the clip's own end, over the 25s default
    expect(n[29].end - n[13].end).toBeGreaterThan(cfg.endExtensionWindowSec);
    expect(gateExitFix(29, c, n, cfg)).toEqual({ ok: false, reason: "outside_window" });
  });

  it("admits a pointer exactly on the window boundary", () => {
    const n = nodes(60);
    const c = clip(n, "c0", 10, 13);
    // Forced to land exactly on the deadline - 2s-per-node spacing does not
    // divide evenly into the 25s default window, so the boundary is set by
    // hand rather than searched for.
    n[20] = { ...n[20], end: n[13].end + cfg.endExtensionWindowSec };
    expect(gateExitFix(20, c, n, cfg)).toEqual({ ok: true, node: 20 });
  });
});

// ---------------------------------------------------------------------------
// arcAuditMaxOutputTokens - the token-budget shape, provisional per the
// module's own doc comment.
// ---------------------------------------------------------------------------

describe("arcAuditMaxOutputTokens", () => {
  it("is base + per-clip * count, matching the critic's shape", () => {
    expect(arcAuditMaxOutputTokens(0)).toBe(ARC_AUDIT_BASE_TOKENS);
    expect(arcAuditMaxOutputTokens(4)).toBe(ARC_AUDIT_BASE_TOKENS + 4 * ARC_AUDIT_TOKENS_PER_CLIP);
    expect(arcAuditMaxOutputTokens(1)).toBeLessThan(arcAuditMaxOutputTokens(2));
  });

  it("reuses exactly the critic's numbers, per the spec's 'do not invent other numbers' rule", () => {
    expect(ARC_AUDIT_BASE_TOKENS).toBe(1200);
    expect(ARC_AUDIT_TOKENS_PER_CLIP).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// ARC_AUDIT_SCHEMA - strict-mode shape, at every nesting level.
// ---------------------------------------------------------------------------

describe("ARC_AUDIT_SCHEMA", () => {
  it("is strict at the top level and every nested object", () => {
    const item = ARC_AUDIT_SCHEMA.schema.properties.results.items;
    expect(ARC_AUDIT_SCHEMA.strict).toBe(true);
    expect(ARC_AUDIT_SCHEMA.schema.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());

    for (const axis of ["entry", "exit", "standalone"] as const) {
      const node = item.properties[axis];
      expect(node.additionalProperties, `${axis} not strict`).toBe(false);
      expect([...node.required].sort(), `${axis} required != declared`).toEqual(
        Object.keys(node.properties).sort()
      );
    }
  });

  it("closes the entry/exit defect vocabularies exactly", () => {
    const item = ARC_AUDIT_SCHEMA.schema.properties.results.items;
    expect(item.properties.entry.properties.defect.enum).toEqual([
      "dangling_reference", "mid_story", "borrowed_answer", "meta_opening", null,
    ]);
    expect(item.properties.exit.properties.defect.enum).toEqual([
      "mid_thought", "setup_no_payoff", "transition_out", "refuted_after", null,
    ]);
  });

  it("lets fix_start_node/fix_end_node be any integer, not bounded to the clip's own range", () => {
    // Deliberately NOT capped the way the critic's evidence arrays are - the
    // whole point of the padded context is a pointer OUTSIDE [start, end].
    const item = ARC_AUDIT_SCHEMA.schema.properties.results.items;
    expect(item.properties.entry.properties.fix_start_node).toEqual({
      type: ["integer", "null"],
    });
    expect(item.properties.exit.properties.fix_end_node).toEqual({
      type: ["integer", "null"],
    });
  });
});

describe("ARC_AUDIT_SYSTEM", () => {
  it("names every output field in decode order", () => {
    const asked = ARC_AUDIT_SYSTEM.slice(ARC_AUDIT_SYSTEM.indexOf("For each clip, in this order:"));
    const at = ["id", "entry", "exit", "standalone"].map((f) => asked.indexOf(f));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("documents every closed defect literal verbatim", () => {
    for (const defect of [
      "dangling_reference", "mid_story", "borrowed_answer", "meta_opening",
      "mid_thought", "setup_no_payoff", "transition_out", "refuted_after",
    ]) {
      expect(ARC_AUDIT_SYSTEM, `defect not documented: ${defect}`).toContain(defect);
    }
  });
});

// ---------------------------------------------------------------------------
// runArcAudit - the stage. Batching, no-retry, unaudited counting, schema
// defence-in-depth, gate wiring, and the dark-stage killswitch.
// ---------------------------------------------------------------------------

function stubClient(handler: (body: any) => any) {
  const create = vi.fn(async (body: any) => handler(body));
  return { chat: { completions: { create } } } as any;
}

const ok = (results: unknown[]) => ({
  choices: [{ message: { content: JSON.stringify({ results }), refusal: null }, finish_reason: "stop" }],
  usage: { prompt_tokens: 500, completion_tokens: 200 },
});

const truncated = () => ({
  choices: [{ message: { content: null, refusal: null }, finish_reason: "length" }],
  usage: { prompt_tokens: 500, completion_tokens: 1 },
});

const refusal = () => ({
  choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 500, completion_tokens: 1 },
});

/** A schema-legal, fully-ok row: nothing flagged, nothing gated. */
const okRow = (id: string) => ({
  id,
  entry: { ok: true, defect: null, fix_start_node: null },
  exit: { ok: true, defect: null, fix_end_node: null },
  standalone: { ok: true, missing: null },
});

function quiet() {
  return {
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe("runArcAudit - the dark-stage killswitch", () => {
  it("makes no request and returns empty flags/telemetry when disabled", async () => {
    const n = nodes(30);
    const client = stubClient(() => ok([okRow("c0")]));
    const dark = loadAnalyzeConfig({});
    expect(dark.arcAuditEnabled).toBe(false);
    const result = await runArcAudit(client, newUsage(), [clip(n, "c0", 10, 13)], n, dark);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(result.flags.size).toBe(0);
    expect(result.telemetry).toEqual({
      audited: 0,
      unaudited: 0,
      flaggedEntry: 0,
      flaggedExit: 0,
      flaggedStandalone: 0,
      byDefect: {},
      gatedOut: {},
    });
  });

  it("makes no request for an empty clip list", async () => {
    const n = nodes(30);
    const client = stubClient(() => ok([]));
    const result = await runArcAudit(client, newUsage(), [], n, cfg);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(result.flags.size).toBe(0);
  });
});

describe("runArcAudit - config knobs", () => {
  it("arms only on the exact literal 'on', the same discipline as END_EXTENSION", () => {
    expect(loadAnalyzeConfig({ ARC_AUDIT: "on" }).arcAuditEnabled).toBe(true);
    expect(loadAnalyzeConfig({ ARC_AUDIT: "true" }).arcAuditEnabled).toBe(false);
    expect(loadAnalyzeConfig({ ARC_AUDIT: "1" }).arcAuditEnabled).toBe(false);
    expect(loadAnalyzeConfig({}).arcAuditEnabled).toBe(false);
  });

  it("defaults batch size to 4 and reads the override", () => {
    expect(loadAnalyzeConfig({}).arcAuditBatchSize).toBe(4);
    expect(loadAnalyzeConfig({ ARC_AUDIT_BATCH_SIZE: "2" }).arcAuditBatchSize).toBe(2);
  });

  it("defaults startExtensionWindowSec to 20 and reads the override", () => {
    expect(loadAnalyzeConfig({}).startExtensionWindowSec).toBe(20);
    expect(
      loadAnalyzeConfig({ START_EXTENSION_WINDOW_SEC: "45" }).startExtensionWindowSec
    ).toBe(45);
  });
});

describe("runArcAudit - the request it makes", () => {
  it("batches clips by arcAuditBatchSize, one call per batch, on the critic model", async () => {
    const n = nodes(80);
    const clips = [
      clip(n, "a", 0, 1), clip(n, "b", 4, 5), clip(n, "c", 8, 9),
      clip(n, "d", 12, 13), clip(n, "e", 16, 17),
    ];
    const small = { ...cfg, arcAuditBatchSize: 2 };
    // Answer each batch about exactly the ids it was asked about, read off the
    // rendered prompt rather than assumed - `CLIP <id> |` is this stage's own
    // header format.
    const client = stubClient((body) => {
      const ids = [...(body.messages[1].content as string).matchAll(/CLIP (\S+) \|/g)].map(
        (m) => m[1]
      );
      return ok(ids.map((id) => okRow(id)));
    });
    const result = await runArcAudit(client, newUsage(), clips, n, small);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3); // 2+2+1
    expect(result.telemetry.audited).toBe(5);
    expect(result.telemetry.unaudited).toBe(0);
    for (const id of ["a", "b", "c", "d", "e"]) expect(result.flags.has(id)).toBe(true);
  });

  it("sizes the output budget by the batch actually sent, and uses reasoningEffort", async () => {
    const n = nodes(30);
    const clips = [clip(n, "a", 0, 1), clip(n, "b", 4, 5), clip(n, "c", 8, 9)];
    const client = stubClient(() => ok([okRow("a"), okRow("b"), okRow("c")]));
    await runArcAudit(client, newUsage(), clips, n, { ...cfg, arcAuditBatchSize: 10 });
    const body = client.chat.completions.create.mock.calls[0][0];
    expect(body.model).toBe(cfg.criticModel);
    expect(body.max_completion_tokens).toBe(arcAuditMaxOutputTokens(3));
    expect(body.reasoning_effort).toBe(cfg.reasoningEffort);
    expect(body.response_format.json_schema.name).toBe("arc_audit");
  });

  it("charges its tokens to the caller's usage, per model", async () => {
    const n = nodes(30);
    const client = stubClient(() => ok([okRow("a")]));
    const usage = newUsage();
    await runArcAudit(client, usage, [clip(n, "a", 0, 1)], n, cfg);
    expect(usage.requests).toBe(1);
    expect(usage.inputTokens).toBe(500);
    expect(usage.byModel[cfg.criticModel].requests).toBe(1);
  });
});

describe("runArcAudit - no retry, unaudited counting", () => {
  it("counts a whole batch unaudited when the call truncates, with no retry", async () => {
    const q = quiet();
    try {
      const n = nodes(30);
      const clips = [clip(n, "a", 0, 1), clip(n, "b", 4, 5)];
      const client = stubClient(() => truncated());
      const result = await runArcAudit(client, newUsage(), clips, n, {
        ...cfg,
        arcAuditBatchSize: 10,
      });
      expect(client.chat.completions.create).toHaveBeenCalledTimes(1); // no retry
      expect(result.telemetry.audited).toBe(0);
      expect(result.telemetry.unaudited).toBe(2);
      expect(result.flags.size).toBe(0);
    } finally {
      q.warn.mockRestore();
      q.error.mockRestore();
    }
  });

  it("counts a whole batch unaudited when the call is refused, with no retry", async () => {
    const q = quiet();
    try {
      const n = nodes(30);
      const clips = [clip(n, "a", 0, 1)];
      const client = stubClient(() => refusal());
      const result = await runArcAudit(client, newUsage(), clips, n, cfg);
      expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(result.telemetry.unaudited).toBe(1);
    } finally {
      q.warn.mockRestore();
      q.error.mockRestore();
    }
  });

  it("counts a whole batch unaudited on a hard error, with no fallback model", async () => {
    const q = quiet();
    try {
      const n = nodes(30);
      const clips = [clip(n, "a", 0, 1)];
      const client = stubClient(() => {
        throw Object.assign(new Error("503"), { status: 503 });
      });
      const result = await runArcAudit(client, newUsage(), clips, n, cfg, { retryDelayMs: 1 });
      expect(result.telemetry.unaudited).toBe(1);
      // Every attempt landed on the same (critic) model - no criticModelFallback
      // call, unlike the critic and end-extension stages.
      const bodies = client.chat.completions.create.mock.calls.map((c: any[]) => c[0]);
      expect(bodies.every((b: any) => b.model === cfg.criticModel)).toBe(true);
    } finally {
      q.warn.mockRestore();
      q.error.mockRestore();
    }
  });

  it("leaves a single omitted row unflagged and counts exactly one unaudited", async () => {
    const n = nodes(30);
    const clips = [clip(n, "a", 0, 1), clip(n, "b", 4, 5), clip(n, "c", 8, 9)];
    const client = stubClient(() => ok([okRow("a"), okRow("c")])); // b omitted
    const result = await runArcAudit(client, newUsage(), clips, n, {
      ...cfg,
      arcAuditBatchSize: 10,
    });
    expect(result.telemetry.audited).toBe(2);
    expect(result.telemetry.unaudited).toBe(1);
    expect(result.flags.has("a")).toBe(true);
    expect(result.flags.has("b")).toBe(false);
    expect(result.flags.has("c")).toBe(true);
  });
});

describe("runArcAudit - row validation (defence in depth against a non-conforming payload)", () => {
  it("treats a row missing the entry axis as unaudited, never a crash", async () => {
    const n = nodes(30);
    const bad = { id: "a", exit: okRow("a").exit, standalone: okRow("a").standalone };
    const client = stubClient(() => ok([bad]));
    await expect(
      runArcAudit(client, newUsage(), [clip(n, "a", 0, 1)], n, cfg)
    ).resolves.toMatchObject({ telemetry: { audited: 0, unaudited: 1 } });
  });

  it("treats an out-of-enum defect as unaudited, never a crash", async () => {
    const n = nodes(30);
    const bad = {
      id: "a",
      entry: { ok: false, defect: "not_a_real_defect", fix_start_node: null },
      exit: okRow("a").exit,
      standalone: okRow("a").standalone,
    };
    const client = stubClient(() => ok([bad]));
    const result = await runArcAudit(client, newUsage(), [clip(n, "a", 0, 1)], n, cfg);
    expect(result.telemetry).toMatchObject({ audited: 0, unaudited: 1 });
    expect(result.flags.has("a")).toBe(false);
  });

  it("treats a row naming an id outside this batch as unaudited for its real clip", async () => {
    const n = nodes(30);
    const client = stubClient(() => ok([okRow("ghost-id")]));
    const result = await runArcAudit(client, newUsage(), [clip(n, "a", 0, 1)], n, cfg);
    expect(result.telemetry.unaudited).toBe(1);
    expect(result.flags.size).toBe(0);
  });

  it("keeps the first row and ignores a duplicate id", async () => {
    const n = nodes(30);
    const client = stubClient(() => ok([okRow("a"), okRow("a")]));
    const result = await runArcAudit(client, newUsage(), [clip(n, "a", 0, 1)], n, cfg);
    expect(result.telemetry.audited).toBe(1);
    expect(result.flags.size).toBe(1);
  });
});

describe("runArcAudit - flagging and gating", () => {
  it("flags each axis independently and counts them separately", async () => {
    const n = nodes(30);
    const row = {
      id: "a",
      entry: { ok: false, defect: "dangling_reference", fix_start_node: null },
      exit: { ok: true, defect: null, fix_end_node: null },
      standalone: { ok: false, missing: "who 'he' is" },
    };
    const client = stubClient(() => ok([row]));
    const result = await runArcAudit(client, newUsage(), [clip(n, "a", 10, 13)], n, cfg);
    expect(result.telemetry.flaggedEntry).toBe(1);
    expect(result.telemetry.flaggedExit).toBe(0);
    expect(result.telemetry.flaggedStandalone).toBe(1);
    expect(result.telemetry.byDefect).toEqual({ dangling_reference: 1 });
    const flag = result.flags.get("a")!;
    expect(flag.entry).toEqual({ ok: false, defect: "dangling_reference" });
    expect(flag.exit).toEqual({ ok: true });
    expect(flag.standalone).toEqual({ ok: false, missing: "who 'he' is" });
  });

  it("attaches a gated fix_start_node pointer to the flag", async () => {
    const n = nodes(30);
    const row = {
      id: "a",
      entry: { ok: false, defect: "dangling_reference", fix_start_node: 5 },
      exit: { ok: true, defect: null, fix_end_node: null },
      standalone: { ok: true, missing: null },
    };
    const client = stubClient(() => ok([row]));
    const result = await runArcAudit(client, newUsage(), [clip(n, "a", 10, 13)], n, cfg);
    expect(result.flags.get("a")!.entry.fixStartNode).toBe(5);
    expect(result.telemetry.gatedOut).toEqual({});
  });

  it("drops a pointer that fails a gate but keeps the flag, and counts the reason", async () => {
    const n = nodes(30);
    const row = {
      id: "a",
      // 11 is >= the clip's own start (10) - wrong_direction
      entry: { ok: false, defect: "dangling_reference", fix_start_node: 11 },
      exit: { ok: true, defect: null, fix_end_node: null },
      standalone: { ok: true, missing: null },
    };
    const client = stubClient(() => ok([row]));
    const result = await runArcAudit(client, newUsage(), [clip(n, "a", 10, 13)], n, cfg);
    const flag = result.flags.get("a")!;
    expect(flag.entry.ok).toBe(false);
    expect(flag.entry.defect).toBe("dangling_reference");
    expect(flag.entry.fixStartNode).toBeUndefined();
    expect(result.telemetry.gatedOut).toEqual({ wrong_direction: 1 });
    expect(result.telemetry.audited).toBe(1); // the flag itself still counts
  });

  it("never gates a pointer on an axis the model called ok", async () => {
    // A model that says entry.ok:true but still names a fix_start_node is a
    // schema-legal inconsistency; this stage normalizes it away rather than
    // gating (and potentially counting a gate failure for) a pointer nobody
    // needs.
    const n = nodes(30);
    const row = {
      id: "a",
      entry: { ok: true, defect: null, fix_start_node: 999999 }, // would fail every gate
      exit: { ok: true, defect: null, fix_end_node: null },
      standalone: { ok: true, missing: null },
    };
    const client = stubClient(() => ok([row]));
    const result = await runArcAudit(client, newUsage(), [clip(n, "a", 10, 13)], n, cfg);
    expect(result.flags.get("a")!.entry).toEqual({ ok: true });
    expect(result.telemetry.gatedOut).toEqual({});
  });
});
