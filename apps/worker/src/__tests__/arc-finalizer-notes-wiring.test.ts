import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, and why it is not finalizer-prompt.test.ts or
// finalize.test.ts (spec 2026-08-10 task 6)
//
// The rendering mechanism (resolveArcAuditNote, composeAuditNote, the position
// right after the LENGTH EXCEPTION line, the gating) is pinned next door in
// finalizer-prompt.test.ts, against `finalizerUserPrompt` called directly. This
// file only asserts things that are FALSE about a disconnected mechanism: that
// a clip arcAudit actually flagged, running through the real pipeline, ends up
// with an AUDIT NOTE line inside the finalizer prompt the LLM is actually sent,
// and that the job's telemetry actually counts it - the exact wiring gap
// long-clips-wiring.test.ts's own header describes ("the mechanism pieces ...
// are covered next door in isolation. This file only asserts things that are
// FALSE about a disconnected policy").
//
// Modeled directly on long-clips-wiring.test.ts's stub-by-schema-name client
// and on end-extension-wiring.test.ts's transcript shape.
// ---------------------------------------------------------------------------

const liveCfg = loadAnalyzeConfig({ ARC_AUDIT: "on", ARC_AUDIT_FINALIZER_NOTES: "on" });
const notesDarkCfg = loadAnalyzeConfig({ ARC_AUDIT: "on" }); // audit live, notes dark
const auditDarkCfg = loadAnalyzeConfig({}); // both dark

/** 40 sentences x 5s with word timings - one scan window, no scene cuts. */
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

// Two candidates: c0 is what arc-audit flags, c1 ships clean throughout - the
// same "one flagged, one not" shape that makes "only the flagged clip's block
// carries the note, telemetry counts exactly one" a testable claim rather than
// a coincidence of there being only one clip in the run.
const scanResponse = {
  candidates: [
    { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
    { start_node: 20, end_node: 24, payoff_node: 23, interest: 0.8, type: "story", thread: null },
  ],
};

const verdict = (id: string, startNode: number, endNode: number, payoffNode: number, score: number) => ({
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
  results: [verdict("c0", 10, 14, 13, 0.85), verdict("c1", 20, 24, 23, 0.82)],
};

const flaggedAuditRow = {
  id: "c0",
  entry: { ok: false, defect: "mid_story", fix_start_node: null },
  exit: { ok: true, defect: null, fix_end_node: null },
  standalone: { ok: true, missing: null },
};
const okAuditRow = {
  id: "c1",
  entry: { ok: true, defect: null, fix_start_node: null },
  exit: { ok: true, defect: null, fix_end_node: null },
  standalone: { ok: true, missing: null },
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
const finalizerResponse = { clips: [shipRow("c0"), shipRow("c1")] };

const THROW = Symbol("stub throws");
type Reply = Record<string, unknown> | typeof THROW;

interface Recorded {
  schema: string;
  model: string;
  system: string;
  user: string;
}

/** Minimal OpenAI stand-in that answers per STAGE, keyed by the response
 *  schema callJsonSchema sends - same shape as long-clips-wiring.test.ts's own
 *  stubClient. */
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

const schemasOf = (requests: Recorded[]) => requests.map((r) => r.schema);
const userFor = (requests: Recorded[], schema: string) =>
  requests.find((r) => r.schema === schema)?.user ?? "";
/** The finalizer prompt separates clip blocks with "\n\n---\n\n" - split on it
 *  so an assertion about "c0's block" cannot accidentally match a note that
 *  actually landed in c1's block. */
const blockFor = (finalizerUser: string, id: string) =>
  finalizerUser.split("\n\n---\n\n").find((b) => b.startsWith(`CLIP ${id} `)) ?? "";

describe("arc-finalizer-notes wiring", () => {
  it("renders the AUDIT NOTE in the finalizer prompt for the flagged clip only, and telemetry counts it", async () => {
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse,
      arc_audit: { results: [flaggedAuditRow, okAuditRow] },
      clip_finalizer: finalizerResponse,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: liveCfg });

    expect(schemasOf(requests)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "clip_finalizer",
    ]);

    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(blockFor(finalizerUser, "c0")).toContain(
      "AUDIT NOTE: a per-clip audit of this finished cut flagged the OPENING (mid_story)."
    );
    // c1 was audited and came back fully OK - no note in its block.
    expect(blockFor(finalizerUser, "c1")).not.toContain("AUDIT NOTE");

    expect(r.telemetry.auditNotes).toBe(1);
    expect(r.highlights).toHaveLength(2);
  });

  it("audits and flags the clip, but renders nothing and leaves telemetry absent when ARC_AUDIT_FINALIZER_NOTES is off", async () => {
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse,
      arc_audit: { results: [flaggedAuditRow, okAuditRow] },
      clip_finalizer: finalizerResponse,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: notesDarkCfg });

    // arc-audit itself still ran and still flagged c0 - only the finalizer's
    // rendering is gated off, proving the doubling checks its OWN switch
    // rather than merely reflecting arcAuditEnabled.
    expect(schemasOf(requests)).toContain("arc_audit");
    expect((r.telemetry.arcAudit as { flaggedEntry: number }).flaggedEntry).toBe(1);

    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).not.toContain("AUDIT NOTE");
    expect("auditNotes" in r.telemetry).toBe(false);
  });

  it("makes no arc_audit call and renders nothing when ARC_AUDIT is off entirely", async () => {
    const { client, requests } = stubClient({
      scan_candidates: scanResponse,
      critic_verdicts: criticResponse,
      clip_finalizer: finalizerResponse,
    });
    const r = await analyzeHighlightsV2(transcript(), { client, cfg: auditDarkCfg });

    expect(schemasOf(requests)).toEqual(["scan_candidates", "critic_verdicts", "clip_finalizer"]);
    const finalizerUser = userFor(requests, "clip_finalizer");
    expect(finalizerUser).not.toContain("AUDIT NOTE");
    expect("auditNotes" in r.telemetry).toBe(false);
    expect("arcAudit" in r.telemetry).toBe(false);
  });
});
