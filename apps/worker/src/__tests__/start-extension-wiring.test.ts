import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { StartExtensionTelemetry } from "../analyze-v2/start-extension";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, and why it is not start-extension.test.ts
//
// The stage itself (every gate, the window, the teaser region wired for real,
// the telemetry shape) is covered next door, against a caller that never
// existed. This file only asserts things that are FALSE about a disconnected
// stage: that the whole chain - a real arc-audit call producing a gated
// pointer, extendClipStarts consuming it - moves a shipped highlight's start
// and node, that the finalizer is handed the WIDENED clip and not the one
// selection chose, that BOTH flags are required (mirroring arc-audit-wiring's
// own "makes no call and adds no key" test), and that the stage's own gates
// (not just arc-audit's) surface in the job's telemetry when they refuse.
//
// Modeled directly on arc-audit-wiring.test.ts and end-extension-wiring.
// test.ts: same stub-by-schema-name client, same transcript shape (arc-audit-
// wiring's own - every node a clean start/end by construction, no scene
// cuts), so a pointer that is otherwise legal is refused ONLY by the thing
// each test names.
// ---------------------------------------------------------------------------

const darkCfg = loadAnalyzeConfig({});
const auditOnlyCfg = loadAnalyzeConfig({ ARC_AUDIT: "on" });
const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", START_EXTENSION: "on" });

/** 40 sentences x 5s with word timings - one scan window, no scene cuts.
 *  Identical to arc-audit-wiring.test.ts's own fixture: every node is a clean
 *  start/end by construction, so a refusal in the tests below is never the
 *  transcript's fault. */
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

/** An entry-flagged row naming a legal, gated backward pointer. */
const pointerAuditRow = (id: string, fixStartNode: number, defect = "dangling_reference") => ({
  id,
  entry: { ok: false, defect, fix_start_node: fixStartNode },
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
 *  schema callJsonSchema sends - same shape as arc-audit-wiring.test.ts's own
 *  stubClient. start-extension has no schema of its own: it never calls the
 *  model, so its presence or absence is only ever visible through what it did
 *  to the clip the finalizer receives. */
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
const userFor = (requests: Recorded[], schema: string) =>
  requests.find((r) => r.schema === schema)?.user ?? "";
const telemetryOf = (telemetry: Record<string, unknown>) =>
  telemetry.startExtension as StartExtensionTelemetry | undefined;

// node 10 = 50s; node 9 = 45s, 5s back - well inside the 20s default window,
// a clean start (every node in this transcript is), no scene cuts anywhere.
const C0_START = 49.85; // node 10 start minus leadInSec, the UNWIDENED value
const C0_START_WIDENED = 44.85; // node 9 start minus leadInSec

describe("start-extension wiring", () => {
  it("makes no boundary change and adds no key while both flags are dark", async () => {
    const { client, requests } = stubClient(baseReplies({ results: [pointerAuditRow("c0", 9)] }));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: darkCfg });

    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "clip_finalizer"]);
    expect(r.highlights).toHaveLength(3);
    expect(r.highlights[0].start).toBeCloseTo(C0_START, 6);
    expect("startExtension" in r.telemetry).toBe(false);
  });

  // The property the spec names explicitly: BOTH flags gate the stage, and the
  // dependency has to be visible in code. arc-audit runs and flags c0 for real
  // - the pointer exists - but startExtensionEnabled is still off, so nothing
  // may apply it.
  it("runs arc-audit but still makes no boundary change when startExtensionEnabled is off", async () => {
    const { client, requests } = stubClient(baseReplies({ results: [pointerAuditRow("c0", 9)] }));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: auditOnlyCfg });

    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "clip_finalizer",
    ]);
    expect(r.highlights[0].start).toBeCloseTo(C0_START, 6);
    expect(r.highlights[0]._arcFlags?.entry.fixStartNode).toBe(9); // the pointer DID survive its own gate
    expect("startExtension" in r.telemetry).toBe(false); // but nothing applied it
  });

  it("applies a gated pointer to the clip that actually ships, and hands the finalizer the widened clip", async () => {
    const { client, requests } = stubClient(baseReplies({ results: [pointerAuditRow("c0", 9)] }));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights).toHaveLength(3);
    expect(r.highlights[0].start).toBeCloseTo(C0_START_WIDENED, 6);
    expect(r.highlights[0]._startNode).toBe(9);
    // the clips nobody proposed anything for are untouched
    expect(r.highlights[1].start).toBeCloseTo(20 * 5 - 0.15, 6);
    expect(r.highlights[2].start).toBeCloseTo(30 * 5 - 0.15, 6);

    const telemetry = telemetryOf(r.telemetry);
    expect(telemetry).toEqual({
      eligible: 1,
      applied: 1,
      refused: 0,
      refusedBy: {},
      secondsGained: expect.closeTo(C0_START - C0_START_WIDENED, 6),
    });

    // THE FINALIZER SAW THE WIDENED CLIP, not the one selection/arc-audit
    // received: its prompt prints each clip's duration, and c0 grew by exactly
    // one node's worth (5s) of start.
    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).toContain(`CLIP c0 | score 0.85 | ${(69.8 - C0_START_WIDENED).toFixed(0)}s`);
  });

  it("runs after arc-audit and before the finalizer, adding no schema call of its own", async () => {
    const { client, requests } = stubClient(baseReplies({ results: [pointerAuditRow("c0", 9)] }));
    await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    // extendClipStarts never touches the model - its whole point is that
    // arc-audit already asked. So the schema sequence is identical to the
    // audit-only run above; only the SHIPPED clip differs.
    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "clip_finalizer",
    ]);
  });

  it("ships every clip unchanged when arc-audit flags nothing", async () => {
    const { client } = stubClient(
      baseReplies({ results: [okAuditRow("c0"), okAuditRow("c1"), okAuditRow("c2")] })
    );
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights[0].start).toBeCloseTo(C0_START, 6);
    expect(telemetryOf(r.telemetry)).toEqual({
      eligible: 0,
      applied: 0,
      refused: 0,
      refusedBy: {},
      secondsGained: 0,
    });
  });

  // A pointer that fails arc-audit's OWN gate (too far back for the default
  // 20s window) never becomes a fixStartNode at all - so extendClipStarts
  // never even sees it as eligible. This is arc-audit's gatedOut, not
  // start-extension's refusedBy, and the two telemetry blocks must not
  // confuse them.
  it("never sees a pointer arc-audit's own gate already refused", async () => {
    const { client } = stubClient(baseReplies({ results: [pointerAuditRow("c0", 0)] })); // 50s back
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(r.highlights[0].start).toBeCloseTo(C0_START, 6);
    expect(r.highlights[0]._arcFlags?.entry.fixStartNode).toBeUndefined();
    expect((r.telemetry.arcAudit as { gatedOut: Record<string, number> }).gatedOut).toEqual({
      outside_window: 1,
    });
    expect(telemetryOf(r.telemetry)).toEqual({
      eligible: 0,
      applied: 0,
      refused: 0,
      refusedBy: {},
      secondsGained: 0,
    });
  });

  // A pointer that DOES pass arc-audit's own gate but fails a check ONLY
  // start-extension makes (too_long here - a wide enough window plus a tight
  // enough cap) must surface in THIS stage's own refusedBy, proving the extra
  // gate chain actually runs rather than rubber-stamping whatever arc-audit
  // already approved.
  it("counts a pointer its own too_long gate refuses, and ships the clip unchanged", async () => {
    // maxSec=40 must stay ABOVE the candidate's own natural duration (c0 is
    // 49.85-69.8, 19.95s) or snap's own over-length compression would move the
    // start before arc-audit ever sees the clip, confounding the test; it must
    // fall BELOW the duration a full widen to node 0 would produce (69.8-0 =
    // 69.8s) so the widen itself is what breaches it. The window is opened
    // wide (1000s) so arc-audit's own gate admits the pointer - this failure
    // has to be start-extension's own too_long gate, not arc-audit's window.
    const wideThenTight = loadAnalyzeConfig({
      ARC_AUDIT: "on",
      START_EXTENSION: "on",
      START_EXTENSION_WINDOW_SEC: "1000",
      CLIP_MAX_SEC: "40",
    });
    const { client } = stubClient(baseReplies({ results: [pointerAuditRow("c0", 0)] })); // node 0, t=0
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: wideThenTight });

    expect(r.highlights[0].start).toBeCloseTo(C0_START, 6); // unchanged
    expect(r.highlights[0]._arcFlags?.entry.fixStartNode).toBe(0); // arc-audit's gate passed it
    expect(telemetryOf(r.telemetry)).toEqual({
      eligible: 1,
      applied: 0,
      refused: 1,
      refusedBy: { too_long: 1 },
      secondsGained: 0,
    });
  });

  it("ships the whole set unchanged when the arc-audit call dies, and never fails the job", async () => {
    const { client } = stubClient(baseReplies(THROW));
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg, retryDelayMs: 1 });

    expect(r.noClipsReason).toBeUndefined();
    expect(r.highlights).toHaveLength(3);
    expect(r.highlights[0].start).toBeCloseTo(C0_START, 6);
    // arc-audit itself failed the call, so nothing was ever flagged - the same
    // "eligible: 0" shape as the "flags nothing" case above, not a distinct
    // failure mode of this stage (it never got a chance to run into one: it is
    // pure and synchronous, so there is no call of its own to die).
    expect(telemetryOf(r.telemetry)).toEqual({
      eligible: 0,
      applied: 0,
      refused: 0,
      refusedBy: {},
      secondsGained: 0,
    });
  });
});
