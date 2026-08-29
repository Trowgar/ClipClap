import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, and why it is not arc-audit.test.ts
//
// The policy itself (the standing-flag count, the penalty tiers, the
// score-threshold drop) lives inline in index.ts (spec 2026-08-10 task 7,
// "policy in index.ts, mechanism in the module that owns the data" - there is
// no new module here, only a read of flags arc-audit.ts already publishes).
// So this file only asserts things that are FALSE about a disconnected
// policy: that turning it on can actually remove a clip from the shipped
// set, that the tier boundaries are the ones the corpus measured (2026-08-17,
// engine-notes §5c), that a REPAIRED axis does not count against a clip, that
// a dropped clip never reaches the finalizer's prompt, that an unflagged
// clip is never touched regardless of score, and that the stage is silent
// (no telemetry key at all) both when its own flag is off and when
// arcAuditEnabled is off underneath it.
//
// Modeled directly on long-clips-wiring.test.ts and arc-audit-wiring.test.ts:
// same stub-by-schema-name client, same 5s/node transcript shape (every node
// a clean start/end by construction, so arc-audit's and start-extension's own
// structural gates are never the thing under test here).
// ---------------------------------------------------------------------------

/** 40 sentences x 5s with word timings - identical in shape to
 *  arc-audit-wiring.test.ts's own fixture. */
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

const scanCandidate = (startNode: number, endNode: number, payoffNode: number) => ({
  start_node: startNode,
  end_node: endNode,
  payoff_node: payoffNode,
  interest: 0.8,
  type: "story",
  thread: null,
});

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

/** One arc-audit row. `fixStartNode`/`fixEndNode` default to `null` (no
 *  pointer offered) - a caller that wants a REPAIRABLE flag passes one
 *  explicitly, e.g. node 9 for a clip starting at node 10 (5s back, inside
 *  the 20s default window, a clean start - arc-audit-wiring.test.ts's own
 *  precedent for a pointer that clears every gate). */
const auditRow = (
  id: string,
  entryOk: boolean,
  exitOk: boolean,
  standaloneOk: boolean = true,
  fixStartNode: number | null = null,
  fixEndNode: number | null = null
) => ({
  id,
  entry: {
    ok: entryOk,
    defect: entryOk ? null : "dangling_reference",
    fix_start_node: entryOk ? null : fixStartNode,
  },
  exit: {
    ok: exitOk,
    defect: exitOk ? null : "mid_thought",
    fix_end_node: exitOk ? null : fixEndNode,
  },
  standalone: { ok: standaloneOk, missing: standaloneOk ? null : "who is speaking" },
});

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

const THROW = Symbol("stub throws");
type Reply = Record<string, unknown> | typeof THROW;

interface Recorded {
  schema: string;
  model: string;
  system: string;
  user: string;
}

/** Minimal OpenAI stand-in that answers per STAGE, keyed by the response
 *  schema callJsonSchema sends - same shape as every other wiring test file's
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
      {
        scan_candidates: 30,
        critic_verdicts: 80,
        arc_audit: 60,
        end_extension: 40,
        clip_finalizer: 90,
      }[schema] ?? 0;
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

const schemasOf = (requests: Recorded[]) => requests.map((r) => r.schema);
const userFor = (requests: Recorded[], schema: string) =>
  requests.find((r) => r.schema === schema)?.user ?? "";
const arcDownrankOf = (telemetry: Record<string, unknown>) =>
  telemetry.arcDownrank as
    | { considered: number; penalized: number; dropped: number }
    | undefined;
const standaloneFilterOf = (telemetry: Record<string, unknown>) =>
  telemetry.standaloneFilter as
    | {
        considered: number;
        eligible: number;
        dropped: number;
        bypassedNoCleanAlternative: number;
      }
    | undefined;
const postBoundaryHookGateOf = (telemetry: Record<string, unknown>) =>
  telemetry.postBoundaryHookGate as
    | {
        mode: "observe" | "shadow" | "enforce";
        evaluated: number;
        diagnostics: Array<Record<string, unknown>>;
        wouldDrop?: number;
        dropped?: number;
        distributions: { byDurationBand: { long: { count: number } } };
      }
    | undefined;

describe("arc-downrank policy wiring", () => {
  it("makes no difference and adds no telemetry key while ARC_DOWNRANK is dark, even on a two-flag clip", async () => {
    const darkCfg = loadAnalyzeConfig({ ARC_AUDIT: "on" }); // ARC_DOWNRANK left off
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.63)] },
      arc_audit: { results: [auditRow("c0", false, false)] }, // 2 standing axes
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: darkCfg });

    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "clip_finalizer",
    ]);
    // ships despite carrying two standing flags - the stage never ran
    expect(r.highlights).toHaveLength(1);
    expect("arcDownrank" in r.telemetry).toBe(false);
  });

  it("makes no difference and adds no telemetry key when ARC_DOWNRANK is on but ARC_AUDIT is off (defence in depth)", async () => {
    // No flags can ever exist without the audit, so this is a no-op either
    // way - but the explicit cfg.arcAuditEnabled check in index.ts is what
    // keeps the KEY itself absent rather than present-and-zeroed. See this
    // file's own report for the by-hand mutation proof on this exact guard.
    const flagOnlyCfg = loadAnalyzeConfig({ ARC_DOWNRANK: "on" });
    expect(flagOnlyCfg.arcAuditEnabled).toBe(false);
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.63)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: flagOnlyCfg });

    // no arc_audit call: the master switch never ran
    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "clip_finalizer"]);
    expect(r.highlights).toHaveLength(1);
    expect("arcDownrank" in r.telemetry).toBe(false);
  });

  it("never touches an unflagged clip, even sitting exactly on the score threshold", async () => {
    const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", ARC_DOWNRANK: "on" });
    expect(liveCfg.scoreThreshold).toBe(0.6);
    const { client } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.6)] },
      arc_audit: { results: [auditRow("c0", true, true, true)] }, // 0 standing
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights).toHaveLength(1);
    expect(arcDownrankOf(r.telemetry)).toEqual({ considered: 1, penalized: 0, dropped: 0 });
  });

  it("drops a two-flag clip at 0.74 (default penalty2=0.15 crosses the 0.6 threshold)", async () => {
    const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", ARC_DOWNRANK: "on" });
    expect(liveCfg.arcDownrankPenalty2).toBe(0.15);
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.74)] },
      arc_audit: { results: [auditRow("c0", false, false)] }, // 2 standing
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights).toHaveLength(0);
    // dropped before the finalizer ever ran - the only candidate had nothing
    // left to judge, the same shape long-clips-wiring.test.ts's own drop test
    // asserts for the long-clip policy's too_long path
    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "arc_audit"]);
    expect(arcDownrankOf(r.telemetry)).toEqual({ considered: 1, penalized: 1, dropped: 1 });
    const drop = (
      r.telemetry.droppedVerdicts as Array<{ id: string; stage: string; reason: string; score: number }>
    ).find((d) => d.id === "c0");
    expect(drop).toEqual({ id: "c0", stage: "arc_downrank", reason: "arc_unrepairable", score: 0.74 });
  });

  it("keeps the SAME two-flag clip at 0.76 - the 0.02 margin the corpus sizing left above threshold", async () => {
    const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", ARC_DOWNRANK: "on" });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.76)] },
      arc_audit: { results: [auditRow("c0", false, false)] }, // 2 standing
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(schemasOf(requests)).toContain("clip_finalizer");
    expect(r.highlights).toHaveLength(1);
    expect(arcDownrankOf(r.telemetry)).toEqual({ considered: 1, penalized: 1, dropped: 0 });
  });

  it("keeps a one-flag clip at 0.61 - the default penalty1=0 does nothing, on purpose (corpus: one flag is noise)", async () => {
    const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", ARC_DOWNRANK: "on" });
    expect(liveCfg.arcDownrankPenalty1).toBe(0);
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.61)] },
      arc_audit: { results: [auditRow("c0", false, true, true)] }, // 1 standing (entry only)
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(schemasOf(requests)).toContain("clip_finalizer");
    expect(r.highlights).toHaveLength(1);
    // penalty computed (standing===1 matched the tier) but its AMOUNT is 0 at
    // the default, so nothing was actually docked - not counted as penalized
    expect(arcDownrankOf(r.telemetry)).toEqual({ considered: 1, penalized: 0, dropped: 0 });
  });

  it("DROPS the same one-flag clip once ARC_DOWNRANK_PENALTY_1 is set live - proving the knob overcomes its own inert default", async () => {
    // The feedback_test_matches_default lesson: a knob whose default does
    // nothing is only proven LIVE by a test where the override changes the
    // outcome, not merely the number.
    const liveCfg = loadAnalyzeConfig({
      ARC_AUDIT: "on",
      ARC_DOWNRANK: "on",
      ARC_DOWNRANK_PENALTY_1: "0.05",
    });
    expect(liveCfg.arcDownrankPenalty1).toBe(0.05);
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.61)] },
      arc_audit: { results: [auditRow("c0", false, true, true)] }, // 1 standing (entry only)
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights).toHaveLength(0);
    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "arc_audit"]);
    expect(arcDownrankOf(r.telemetry)).toEqual({ considered: 1, penalized: 1, dropped: 1 });
    const drop = (
      r.telemetry.droppedVerdicts as Array<{ id: string; stage: string; reason: string; score: number }>
    ).find((d) => d.id === "c0");
    expect(drop).toEqual({ id: "c0", stage: "arc_downrank", reason: "arc_unrepairable", score: 0.61 });
  });

  it("excludes a REPAIRED entry axis from the standing count - a clip whose only widened defect was fixed is not double-punished", async () => {
    // entry gets a legal, gated pointer (node 9 - 5s before node 10, inside
    // the 20s window, a clean start by construction) and START_EXTENSION is
    // live, so it repairs; exit is flagged with NO pointer, so it can never
    // repair and stays standing. If the `!repaired` exclusion did not exist,
    // both axes would count (standing=2, penalty2=0.15, effective=0.48,
    // dropped); with it, only exit counts (standing=1, penalty1 default=0,
    // effective=0.63, kept).
    const liveCfg = loadAnalyzeConfig({
      ARC_AUDIT: "on",
      START_EXTENSION: "on",
      ARC_DOWNRANK: "on",
    });
    const { client } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.63)] },
      arc_audit: { results: [auditRow("c0", false, false, true, 9, null)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights).toHaveLength(1);
    const c0 = r.highlights[0];
    // the repair really did apply - the premise of the whole test
    expect(c0._arcFlags?.entry.repaired).toBe(true);
    expect(c0._arcFlags?.exit.ok).toBe(false);
    expect(c0._arcFlags?.exit.repaired).toBeUndefined();
    // standing=1 (exit only), default penalty1=0 -> not penalized, not dropped
    expect(arcDownrankOf(r.telemetry)).toEqual({ considered: 1, penalized: 0, dropped: 0 });
  });

  it("drops only the flagged clip in a multi-clip set, and its CLIP block never reaches the finalizer prompt", async () => {
    const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", ARC_DOWNRANK: "on" });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13), scanCandidate(20, 24, 23)] },
      critic_verdicts: {
        results: [verdict("c0", 10, 14, 13, 0.85), verdict("c1", 20, 24, 23, 0.74)],
      },
      arc_audit: {
        results: [auditRow("c0", true, true, true), auditRow("c1", false, false)], // c1: 2 standing
      },
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].title).toBe("Заголовок c0");
    expect(arcDownrankOf(r.telemetry)).toEqual({ considered: 2, penalized: 1, dropped: 1 });

    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).toContain("CLIP c0 |");
    expect(finalizerUser).not.toContain("CLIP c1 |");
    // and the counter the finalizer's own wiring test relies on
    // (selectedForFinalizer) reads the ARGUMENT actually handed to it, so it
    // must already reflect the drop
    expect(r.telemetry.selectedForFinalizer).toBe(1);
  });

  it("runs after both extensions and before finalizeClips - no extra model call of its own", async () => {
    const liveCfg = loadAnalyzeConfig({
      ARC_AUDIT: "on",
      START_EXTENSION: "on",
      ARC_DOWNRANK: "on",
    });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.9)] },
      arc_audit: { results: [auditRow("c0", true, true, true)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    // start-extension makes no call of its own either (arc-audit already
    // asked), so the schema sequence is unchanged by either stage being live
    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "clip_finalizer",
    ]);
  });

  it("makes no difference and adds no telemetry key while ANALYZE_STANDALONE_FILTER_V1 is dark", async () => {
    const darkCfg = loadAnalyzeConfig({ ARC_AUDIT: "on" });
    const { client } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.67)] },
      arc_audit: { results: [auditRow("c0", true, true, false)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: darkCfg });

    expect(r.highlights).toHaveLength(1);
    expect("standaloneFilter" in r.telemetry).toBe(false);
  });

  it("adds no standalone telemetry or audit call when only ANALYZE_STANDALONE_FILTER_V1 is on", async () => {
    const flagOnlyCfg = loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "on" });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.67)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: flagOnlyCfg });

    expect(schemasOf(requests)).not.toContain("arc_audit");
    expect(r.highlights).toHaveLength(1);
    expect("standaloneFilter" in r.telemetry).toBe(false);
  });

  it("filters weak non-standalone clips before the finalizer and records measured telemetry", async () => {
    const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", ANALYZE_STANDALONE_FILTER_V1: "on" });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13), scanCandidate(20, 24, 23)] },
      critic_verdicts: {
        results: [verdict("c0", 10, 14, 13, 0.82), verdict("c1", 20, 24, 23, 0.67)],
      },
      arc_audit: {
        results: [auditRow("c0", true, true, true), auditRow("c1", true, true, false)],
      },
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).toContain("CLIP c0 |");
    expect(finalizerUser).not.toContain("CLIP c1 |");
    expect(r.telemetry.selectedForFinalizer).toBe(1);
    expect(standaloneFilterOf(r.telemetry)).toEqual({
      considered: 2,
      eligible: 1,
      dropped: 1,
      bypassedNoCleanAlternative: 0,
    });
    expect(r.telemetry.droppedVerdicts).toContainEqual({
      id: "c1",
      stage: "standalone_filter",
      reason: "not_self_contained",
      score: 0.67,
    });
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].title).toBe("Заголовок c0");
  });

  it("runs the standalone filter after arc downrank and before the finalizer", async () => {
    const liveCfg = loadAnalyzeConfig({
      ARC_AUDIT: "on",
      ARC_DOWNRANK: "on",
      ANALYZE_STANDALONE_FILTER_V1: "on",
    });
    const { client, requests } = stubClient({
      scan_candidates: {
        candidates: [
          scanCandidate(10, 14, 13),
          scanCandidate(20, 24, 23),
          scanCandidate(30, 34, 33),
        ],
      },
      critic_verdicts: {
        results: [
          verdict("c0", 10, 14, 13, 0.82),
          verdict("c1", 20, 24, 23, 0.65),
          verdict("c2", 30, 34, 33, 0.67),
        ],
      },
      arc_audit: {
        results: [
          auditRow("c0", true, true, true),
          auditRow("c1", false, false, true),
          auditRow("c2", true, true, false),
        ],
      },
      clip_finalizer: { clips: [shipRow("c0")] },
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(arcDownrankOf(r.telemetry)).toEqual({ considered: 3, penalized: 1, dropped: 1 });
    expect(standaloneFilterOf(r.telemetry)).toEqual({
      considered: 2,
      eligible: 1,
      dropped: 1,
      bypassedNoCleanAlternative: 0,
    });
    expect(r.telemetry.selectedForFinalizer).toBe(1);
    expect(r.telemetry.droppedVerdicts).toContainEqual({
      id: "c1",
      stage: "arc_downrank",
      reason: "arc_unrepairable",
      score: 0.65,
    });
    expect(r.telemetry.droppedVerdicts).toContainEqual({
      id: "c2",
      stage: "standalone_filter",
      reason: "not_self_contained",
      score: 0.67,
    });
    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).toContain("CLIP c0 |");
    expect(finalizerUser).not.toContain("CLIP c1 |");
    expect(finalizerUser).not.toContain("CLIP c2 |");
  });

  it("keeps the gate dark without changing selection when post-boundary gating is off", async () => {
    const cfg = loadAnalyzeConfig({});
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.82)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg });

    expect(r.highlights).toHaveLength(1);
    expect(userFor(requests, "clip_finalizer")).toContain("CLIP c0 |");
    expect(r.telemetry).not.toHaveProperty("postBoundaryHookGate");
  });

  it("observes raw diagnostics without changing finalizer input", async () => {
    const cfg = loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "observe" });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.82)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg });
    const gate = postBoundaryHookGateOf(r.telemetry)!;

    expect(r.highlights).toHaveLength(1);
    expect(userFor(requests, "clip_finalizer")).toContain("CLIP c0 |");
    expect(gate.mode).toBe("observe");
    expect(gate.evaluated).toBe(1);
    expect(gate.diagnostics[0]).toMatchObject({ id: "c0", language: "ru" });
    expect(gate.diagnostics[0]).not.toHaveProperty("reasons");
  });

  it("reports shadow failures without removing a candidate from the finalizer", async () => {
    const cfg = loadAnalyzeConfig({
      POST_BOUNDARY_HOOK_GATE: "shadow",
      POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
      POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "0",
    });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.82)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg });
    const gate = postBoundaryHookGateOf(r.telemetry)!;

    expect(r.highlights).toHaveLength(1);
    expect(userFor(requests, "clip_finalizer")).toContain("CLIP c0 |");
    expect(gate).toMatchObject({ mode: "shadow", wouldDrop: 1 });
    expect(gate.diagnostics[0]).toMatchObject({
      id: "c0",
      reasons: ["hook_delay", "pre_hook_gap"],
    });
    expect(gate.diagnostics[0]).not.toHaveProperty("language");
  });

  it("enforces post-extension gate failures before the finalizer with provenance and a drop row", async () => {
    const cfg = loadAnalyzeConfig({
      ARC_AUDIT: "on",
      START_EXTENSION: "on",
      END_EXTENSION: "on",
      POST_BOUNDARY_HOOK_GATE: "enforce",
      POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
      POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "10",
    });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.82)] },
      arc_audit: { results: [auditRow("c0", false, true, true, 9)] },
      end_extension: { results: [{ id: "c0", extend: true, end_node: 17, reason: "finish the beat" }] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg });
    const gate = postBoundaryHookGateOf(r.telemetry)!;

    expect(r.highlights).toHaveLength(0);
    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "end_extension",
    ]);
    expect(r.telemetry.selectedForFinalizer).toBe(0);
    expect(gate).toMatchObject({ mode: "enforce", dropped: 1 });
    expect(gate.diagnostics[0]).toMatchObject({
      id: "c0",
      startRepairApplied: true,
      endExtensionApplied: true,
    });
    expect(r.telemetry.droppedVerdicts).toContainEqual({
      id: "c0",
      stage: "post_boundary_hook_gate",
      reason: "hook_delay",
      score: 0.82,
    });
  });

  it("measures hook delay from the start-repaired boundary", async () => {
    const cfg = loadAnalyzeConfig({
      ARC_AUDIT: "on",
      START_EXTENSION: "on",
      POST_BOUNDARY_HOOK_GATE: "enforce",
      // The original snapped start is 49.85s (5.15s to the hook), while the
      // audit repair moves it to 44.85s (10.15s). This limit distinguishes
      // those two geometries.
      POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "7",
      POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "10",
    });
    const { client } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.82)] },
      arc_audit: { results: [auditRow("c0", false, true, true, 9)] },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg });
    const diagnostic = postBoundaryHookGateOf(r.telemetry)!.diagnostics[0] as {
      startSec: number;
      hookDelaySec: number;
      startRepairApplied: boolean;
    };

    expect(r.highlights).toHaveLength(0);
    expect(diagnostic.startSec).toBeCloseTo(44.85, 6);
    expect(diagnostic.hookDelaySec).toBeCloseTo(10.15, 6);
    expect(diagnostic.startRepairApplied).toBe(true);
  });

  it("does not mistake snap's critic-end correction for an end extension", async () => {
    const cfg = loadAnalyzeConfig({ POST_BOUNDARY_HOOK_GATE: "observe" });
    const { client } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      // The critic requests node 14, but snap ends this clip on its payoff at
      // node 13. End extension remains disabled and must report no change.
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.82)] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg });
    const diagnostic = postBoundaryHookGateOf(r.telemetry)!.diagnostics[0] as {
      endExtensionApplied: boolean;
    };

    expect(r.highlights[0]._endNode).toBe(13);
    expect(diagnostic.endExtensionApplied).toBe(false);
  });

  it("evaluates the post-sweep long boundary rather than the pre-extension clip", async () => {
    const cfg = loadAnalyzeConfig({
      ARC_AUDIT: "on",
      LONG_CLIPS: "on",
      END_EXTENSION: "on",
      POST_BOUNDARY_HOOK_GATE: "observe",
    });
    const { client, requests } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 26, 25)] },
      critic_verdicts: { results: [verdict("c0", 10, 26, 25, 0.82)] },
      arc_audit: { results: [auditRow("c0", true, true, true)] },
      end_extension: { results: [{ id: "c0", extend: true, end_node: 30, reason: "finish the beat" }] },
      clip_finalizer: { clips: [shipRow("c0")] },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg });

    expect(userFor(requests, "clip_finalizer")).toContain("CLIP c0 | score 0.82 | 105s");
    expect(postBoundaryHookGateOf(r.telemetry)?.distributions.byDurationBand.long.count).toBe(1);
  });

  it.each([
    ["short", 200, { SHORT_SOURCE_RESCUE: "on" }],
    ["mid", 795, { RESCUE_MID_SOURCE: "on" }],
  ] as const)("does not let %s rescue restore a gate-dropped verdict", async (_tier, sourceDurationSec, rescueEnv) => {
    const cfg = loadAnalyzeConfig({
      ...rescueEnv,
      POST_BOUNDARY_HOOK_GATE: "enforce",
      POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
      POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "10",
    });
    const { client } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.82)] },
      clip_finalizer: {
        clips: [{ ...shipRow("c0"), verdict: "drop", drop_reason: "no_payoff" }],
      },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg, sourceDurationSec });

    expect(r.highlights).toHaveLength(0);
    expect(r.telemetry).not.toHaveProperty("rescue");
  });

  it.each([
    ["short", 200, { SHORT_SOURCE_RESCUE: "on" }],
    ["mid", 795, { RESCUE_MID_SOURCE: "on" }],
  ] as const)("does not let %s rescue restore c0 after arc downrank removes surviving c1", async (_tier, sourceDurationSec, rescueEnv) => {
    const cfg = loadAnalyzeConfig({
      ...rescueEnv,
      ARC_AUDIT: "on",
      ARC_DOWNRANK: "on",
      POST_BOUNDARY_HOOK_GATE: "enforce",
      POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "1",
      POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "1",
    });
    const { client } = stubClient({
      scan_candidates: {
        candidates: [scanCandidate(10, 14, 13), scanCandidate(20, 24, 23)],
      },
      critic_verdicts: {
        results: [
          verdict("c0", 10, 14, 13, 0.82),
          // c1 enters at its hook, so it survives the hook gate and can be
          // removed only by the later arc downrank stage.
          { ...verdict("c1", 20, 24, 23, 0.65), hook_start_node: 20 },
        ],
      },
      arc_audit: {
        results: [
          auditRow("c0", true, true, true),
          auditRow("c1", false, false, true),
        ],
      },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg, sourceDurationSec });

    expect(r.telemetry.droppedVerdicts).toContainEqual({
      id: "c0",
      stage: "post_boundary_hook_gate",
      reason: "hook_delay",
      score: 0.82,
    });
    expect(r.telemetry.droppedVerdicts).toContainEqual({
      id: "c1",
      stage: "arc_downrank",
      reason: "arc_unrepairable",
      score: 0.65,
    });
    // If rescue stops excluding gate-dropped ids, c0's higher score wins.
    expect(r.highlights).toHaveLength(1);
    expect(r.highlights[0].title).toBe("Заголовок c1");
    expect(r.telemetry.rescue).toMatchObject({ shipped: true, verdictId: "c1", tier: _tier });
  });

  it("keeps ordinary short-source rescue available when the critic produced no clips", async () => {
    const cfg = loadAnalyzeConfig({
      SHORT_SOURCE_RESCUE: "on",
      POST_BOUNDARY_HOOK_GATE: "enforce",
      POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "10",
      POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "10",
    });
    const { client } = stubClient({
      scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
      critic_verdicts: { results: [{ ...verdict("c0", 10, 14, 13, 0.82), keep: false }] },
    });

    const r = await analyzeHighlightsV2(transcript(), { client, cfg, sourceDurationSec: 200 });

    expect(r.highlights).toHaveLength(1);
    expect(r.telemetry.rescue).toMatchObject({ shipped: true, verdictId: "c0", tier: "short" });
  });
});
