import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { ArcAuditTelemetry } from "../analyze-v2/arc-audit";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, and why it is not arc-audit.test.ts
//
// The stage itself (gates, row validation, batching, no-retry counting) is
// covered next door, against a caller that never existed - every one of those
// tests passed just as happily while analyzeHighlightsV2 never called
// runArcAudit at all. So this file only asserts things that are FALSE about a
// disconnected stage: that turning it on adds exactly one call in the right
// place in the sequence, that a flag reaches the highlight the pipeline
// actually ships, that a gated-out pointer still ships its flag without the
// pointer, and - the single most important property for a "detection only"
// task - that the stage can be switched on or off without moving a single
// boundary anywhere in the shipped set.
//
// Modeled directly on end-extension-wiring.test.ts: same stub-by-schema-name
// client, same reasoning for why the wiring needs its own file.
// ---------------------------------------------------------------------------

const darkCfg = loadAnalyzeConfig({});
const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on" });

/** 40 sentences x 5s with word timings - one scan window, no scene cuts.
 *  Identical in shape to end-extension-wiring.test.ts's own fixture: every
 *  sentence ends on terminal punctuation and opens capitalized, so every node
 *  is a clean start/end by construction and arc-audit's structural gates are
 *  never blocked by the transcript itself, only by the pointer under test. */
function transcript(): TranscriptionResult {
  const segments: WhisperSegment[] = Array.from({ length: 40 }, (_, i) => {
    const base = i * 5;
    return {
      start: base,
      end: base + 4.5,
      text: `Это предложение номер ${i}.`,
      words: [
        { text: "Это", start: base, end: base + 1 },
        { text: "предложение", start: base + 1.1, end: base + 2.5 },
        { text: "номер", start: base + 2.6, end: base + 3.4 },
        { text: `${i}.`, start: base + 3.5, end: base + 4.5 },
      ],
    };
  });
  return { text: segments.map((s) => s.text).join(" "), segments, language: "ru" };
}

const scanResponse = {
  candidates: [
    { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
    { start_node: 20, end_node: 24, payoff_node: 23, interest: 0.8, type: "story", thread: null },
    { start_node: 30, end_node: 34, payoff_node: 33, interest: 0.8, type: "story", thread: null },
  ],
};

const verdict = (
  id: string,
  startNode: number,
  endNode: number,
  payoffNode: number,
  score: number
) => ({
  id,
  keep: true,
  score,
  grounded: true,
  self_contained: true,
  start_node: startNode,
  payoff_node: payoffNode,
  end_node: endNode,
  hook_start_node: startNode + 1,
  hook_end_node: payoffNode,
  title: `Заголовок ${id}`,
  description: `Спикер называет номер предложения ${payoffNode}.`,
  title_evidence_nodes: [payoffNode],
  description_evidence_nodes: [payoffNode],
  language: "ru",
});

const criticResponse = {
  results: [
    verdict("c0", 10, 14, 13, 0.85),
    verdict("c1", 20, 24, 23, 0.82),
    verdict("c2", 30, 34, 33, 0.8),
  ],
};

const shipRow = (id: string) => ({
  id,
  verdict: "ship",
  drop_reason: null,
  duplicate_of: null,
  shared_claim: null,
  title: null,
  title_evidence_nodes: null,
  trim_start_node: null,
});

const finalizerResponse = { clips: [shipRow("c0"), shipRow("c1"), shipRow("c2")] };

/** A fully-ok arc-audit row: nothing flagged, no pointer offered. */
const okAuditRow = (id: string) => ({
  id,
  entry: { ok: true, defect: null, fix_start_node: null },
  exit: { ok: true, defect: null, fix_end_node: null },
  standalone: { ok: true, missing: null },
});

const THROW = Symbol("stub throws");
type Reply = Record<string, unknown> | typeof THROW;

interface Recorded {
  schema: string;
  model: string;
  system: string;
  user: string;
}

/** Minimal OpenAI stand-in that answers per STAGE, keyed by the response
 *  schema callJsonSchema sends - same shape as end-extension-wiring.test.ts's
 *  own stubClient. */
function stubClient(replies: Record<string, Reply>) {
  const requests: Recorded[] = [];
  const create = vi.fn(async (body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format: { json_schema: { name: string } };
  }) => {
    const schema = body.response_format.json_schema.name;
    requests.push({
      schema,
      model: body.model,
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    });
    const reply = replies[schema];
    if (reply === undefined) throw new Error(`stub has no reply for schema "${schema}"`);
    if (reply === THROW) throw new Error("stub outage");
    const completionTokens =
      { scan_candidates: 30, critic_verdicts: 80, arc_audit: 60, clip_finalizer: 90 }[schema] ?? 0;
    return {
      choices: [
        { message: { content: JSON.stringify(reply), refusal: null }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: completionTokens },
    };
  });
  return {
    requests,
    client: { chat: { completions: { create } } } as never,
  };
}

const baseReplies = (arcAudit: Reply): Record<string, Reply> => ({
  scan_candidates: scanResponse,
  critic_verdicts: criticResponse,
  arc_audit: arcAudit,
  clip_finalizer: finalizerResponse,
});

const schemasOf = (requests: Recorded[]) => requests.map((r) => r.schema);
const telemetryOf = (telemetry: Record<string, unknown>) =>
  telemetry.arcAudit as ArcAuditTelemetry | undefined;

describe("arc-audit wiring", () => {
  it("makes no call and adds no key while the stage is dark", async () => {
    const { client, requests } = stubClient(baseReplies({ results: [okAuditRow("c0")] }));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: darkCfg });

    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "clip_finalizer"]);
    expect(r.highlights).toHaveLength(3);
    // not a zeroed placeholder - the key itself must not exist
    expect("arcAudit" in r.telemetry).toBe(false);
    for (const h of r.highlights) {
      expect("_arcFlags" in h).toBe(false);
    }
  });

  it("makes exactly one call, after the critic and before the finalizer", async () => {
    const { client, requests } = stubClient(
      baseReplies({ results: [okAuditRow("c0"), okAuditRow("c1"), okAuditRow("c2")] })
    );
    await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "clip_finalizer",
    ]);
  });

  it("charges the arc-audit call to the job's usage", async () => {
    const { client } = stubClient(
      baseReplies({ results: [okAuditRow("c0"), okAuditRow("c1"), okAuditRow("c2")] })
    );
    const darkUsage = (
      await analyzeHighlightsV2(transcript(), {
        client: stubClient(baseReplies({ results: [] })).client,
        cfg: darkCfg,
      })
    ).usage;
    const liveUsage = (await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg })).usage;
    expect(liveUsage.requests).toBe(darkUsage.requests + 1);
  });

  it("attaches an ok:false flag with its defect, and a legal fix pointer, to the shipped highlight", async () => {
    const auditResponse = {
      results: [
        {
          id: "c0",
          entry: { ok: false, defect: "dangling_reference", fix_start_node: 9 }, // 5s before node 10 - inside the 20s window, a clean start
          exit: { ok: true, defect: null, fix_end_node: null },
          standalone: { ok: true, missing: null },
        },
        okAuditRow("c1"),
        okAuditRow("c2"),
      ],
    };
    const { client } = stubClient(baseReplies(auditResponse));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    const c0 = r.highlights.find((h) => h.title === "Заголовок c0")!;
    expect(c0._arcFlags).toEqual({
      entry: { ok: false, defect: "dangling_reference", fixStartNode: 9 },
      exit: { ok: true },
      standalone: { ok: true },
    });
    expect(telemetryOf(r.telemetry)?.flaggedEntry).toBe(1);
    expect(telemetryOf(r.telemetry)?.byDefect).toEqual({ dangling_reference: 1 });
  });

  it("drops a pointer that fails a gate but keeps the flag, and counts the reason", async () => {
    const auditResponse = {
      results: [
        okAuditRow("c0"),
        {
          id: "c1",
          // node 0 is 100s before c1's start (node 20) - past the 20s default window
          entry: { ok: false, defect: "mid_story", fix_start_node: 0 },
          exit: { ok: true, defect: null, fix_end_node: null },
          standalone: { ok: true, missing: null },
        },
        okAuditRow("c2"),
      ],
    };
    const { client } = stubClient(baseReplies(auditResponse));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    const c1 = r.highlights.find((h) => h.title === "Заголовок c1")!;
    expect(c1._arcFlags?.entry.ok).toBe(false);
    expect(c1._arcFlags?.entry.defect).toBe("mid_story");
    expect(c1._arcFlags?.entry.fixStartNode).toBeUndefined();
    expect(telemetryOf(r.telemetry)?.gatedOut).toEqual({ outside_window: 1 });
    // the flag SURVIVES the gate failure - only the pointer is dropped
    expect(telemetryOf(r.telemetry)?.audited).toBe(3);
  });

  it("leaves an omitted clip unflagged, ships it unchanged, and counts it unaudited", async () => {
    const { client } = stubClient(baseReplies({ results: [okAuditRow("c0"), okAuditRow("c2")] })); // c1 omitted
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights).toHaveLength(3); // the clip still ships
    const c1 = r.highlights.find((h) => h.title === "Заголовок c1")!;
    expect("_arcFlags" in c1).toBe(false);
    expect(telemetryOf(r.telemetry)).toEqual({
      audited: 2,
      unaudited: 1,
      flaggedEntry: 0,
      flaggedExit: 0,
      flaggedStandalone: 0,
      byDefect: {},
      gatedOut: {},
    });
  });

  it("ships the whole set unchanged when the arc-audit call dies, and never fails the job", async () => {
    const { client } = stubClient(baseReplies(THROW));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg, retryDelayMs: 1 });

    expect(r.noClipsReason).toBeUndefined();
    expect(r.highlights).toHaveLength(3);
    expect(telemetryOf(r.telemetry)).toEqual({
      audited: 0,
      unaudited: 3,
      flaggedEntry: 0,
      flaggedExit: 0,
      flaggedStandalone: 0,
      byDefect: {},
      gatedOut: {},
    });
  });

  it("moves nothing: every shipped boundary is identical whether the stage is on or off", async () => {
    // THE property a pure-detector task exists to prove. Same scan/critic/
    // finalizer answers on both runs; only arcAuditEnabled and the presence of
    // an arc_audit reply differ.
    const dark = await analyzeHighlightsV2(transcript(), {
      client: stubClient(baseReplies({ results: [] })).client,
      cfg: darkCfg,
    });
    const auditResponse = {
      results: [
        {
          id: "c0",
          entry: { ok: false, defect: "dangling_reference", fix_start_node: 9 },
          exit: { ok: false, defect: "transition_out", fix_end_node: 16 },
          standalone: { ok: false, missing: "who is speaking" },
        },
        okAuditRow("c1"),
        okAuditRow("c2"),
      ],
    };
    const live = await analyzeHighlightsV2(transcript(), {
      client: stubClient(baseReplies(auditResponse)).client,
      cfg: liveCfg,
    });

    expect(live.highlights).toHaveLength(dark.highlights.length);
    for (let i = 0; i < dark.highlights.length; i++) {
      const { _arcFlags: _darkFlags, ...darkRest } = dark.highlights[i];
      const { _arcFlags: _liveFlags, ...liveRest } = live.highlights[i];
      expect(liveRest).toEqual(darkRest);
    }
    // and the flag really did attach to something, or the comparison above
    // would be true for a stage that silently did nothing at all
    expect(live.highlights.find((h) => h.title === "Заголовок c0")?._arcFlags?.entry.ok).toBe(
      false
    );
  });
});
