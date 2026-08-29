import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { SAFE_END_AUDIT_SCHEMA, readSafeEndAuditRow } from "../analyze-v2/safe-end-audit-schema";
import { SAFE_END_AUDIT_SYSTEM, safeEndAuditUserPrompt } from "../analyze-v2/safe-end-audit-prompts";
import { APIConnectionTimeoutError } from "openai";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

function transcript(): TranscriptionResult {
  const segments: WhisperSegment[] = Array.from({ length: 12 }, (_, index) => {
    const start = index * 5;
    return {
      start,
      end: start + 4.5,
      text: `Invented scene sentence ${index}.`,
      words: [
        { text: "Invented", start, end: start + 1 },
        { text: "scene", start: start + 1.1, end: start + 2 },
        { text: "sentence", start: start + 2.1, end: start + 3 },
        { text: `${index}.`, start: start + 3.1, end: start + 4.5 },
      ],
    };
  });
  return { text: segments.map((segment) => segment.text).join(" "), segments, language: "en" };
}

const scan = { candidates: [{ start_node: 2, end_node: 4, payoff_node: 3, interest: 0.9, type: "story", thread: null }] };
const critic = {
  results: [{
    id: "c0", keep: true, score: 0.8, grounded: true, self_contained: true,
    start_node: 2, payoff_node: 3, end_node: 4, hook_start_node: 2, hook_end_node: 3,
    title: "Invented title", description: "Invented description.", title_evidence_nodes: [3],
    description_evidence_nodes: [3], language: "en",
  }],
};
const finalizer = { clips: [{ id: "c0", verdict: "ship", drop_reason: null, duplicate_of: null, shared_claim: null, title: null, title_evidence_nodes: null, trim_start_node: null }] };

type Reply = Record<string, unknown> | "refusal" | "timeout" | "sdk_timeout" | "truncated" | "malformed" | "serialization_failure";
interface Request { schema: string; user: string; }

function clientFor(replies: Record<string, Reply>) {
  const requests: Request[] = [];
  const create = vi.fn(async (body: { messages: Array<{ role: string; content: string }>; response_format: { json_schema: { name: string } } }) => {
    const schema = body.response_format.json_schema.name;
    requests.push({ schema, user: body.messages.find((message) => message.role === "user")?.content ?? "" });
    const reply = replies[schema];
    if (reply === "timeout") throw new Error("request timeout");
    if (reply === "sdk_timeout") throw new APIConnectionTimeoutError();
    if (reply === "serialization_failure") JSON.stringify({ value: BigInt(1) });
    if (reply === "refusal") return { choices: [{ message: { content: null, refusal: "cannot assess" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    if (reply === "truncated") return { choices: [{ message: { content: "{", refusal: null }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    if (reply === "malformed") return { choices: [{ message: { content: JSON.stringify({ results: [{ id: "c0", outcome: "unsafe prose", reason: "prose", extendToNode: 9 }] }), refusal: null }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    if (!reply) throw new Error(`missing ${schema}`);
    return { choices: [{ message: { content: JSON.stringify(reply), refusal: null }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  });
  return { client: { chat: { completions: { create } } } as never, requests };
}

function replies(safeEnd: Reply = { results: [{ id: "c0", outcome: "safe", reason: null, extendToNode: null }] }) {
  return { scan_candidates: scan, critic_verdicts: critic, safe_end_audit: safeEnd, clip_finalizer: finalizer };
}

const twoStandingArcFlags = {
  results: [{
    id: "c0",
    entry: { ok: false, defect: "mid_story", fix_start_node: null },
    exit: { ok: false, defect: "mid_thought", fix_end_node: null },
    standalone: { ok: true, missing: null },
  }],
};

function projection(result: Awaited<ReturnType<typeof analyzeHighlightsV2>>) {
  return {
    highlights: result.highlights,
    noClipsReason: result.noClipsReason,
    rescue: result.telemetry.rescue,
  };
}

function safeEndTelemetry(result: Awaited<ReturnType<typeof analyzeHighlightsV2>>) {
  return result.telemetry.safeEndAudit as
    | {
        normal: {
          evaluated: number;
          needs_afterbeat: number;
          hard_handoff: number;
          audit_failed: number;
          records: Array<Record<string, unknown>>;
        };
      }
    | undefined;
}

describe("safe-end normal shadow wiring", () => {
  it("does not request or publish a safe-end audit when off", async () => {
    const stub = clientFor(replies());
    const result = await analyzeHighlightsV2(transcript(), { client: stub.client, cfg: loadAnalyzeConfig({}) });

    expect(stub.requests.map((request) => request.schema)).toEqual(["scan_candidates", "critic_verdicts", "clip_finalizer"]);
    expect("safeEndAudit" in result.telemetry).toBe(false);
  });

  it("uses the isolated strict schema and never renders more than 25 seconds of following context", async () => {
    const stub = clientFor(replies({ results: [{ id: "c0", outcome: "needs_afterbeat", reason: "post_payoff_context", extendToNode: 6 }] }));
    const result = await analyzeHighlightsV2(transcript(), { client: stub.client, cfg: loadAnalyzeConfig({ SAFE_END_AUDIT: "shadow" }) });
    const request = stub.requests.find((entry) => entry.schema === "safe_end_audit");

    expect(SAFE_END_AUDIT_SCHEMA.name).toBe("safe_end_audit");
    expect(SAFE_END_AUDIT_SCHEMA.strict).toBe(true);
    expect(SAFE_END_AUDIT_SYSTEM).toContain("hard_handoff");
    expect(request?.user).toContain("#4");
    expect(request?.user).toContain("#8");
    expect(request?.user).not.toContain("#9");
    expect(safeEndTelemetry(result)).toMatchObject({ normal: { evaluated: 1, needs_afterbeat: 1 } });
    expect(safeEndTelemetry(result)?.normal.records[0]).toMatchObject({ outcome: "needs_afterbeat", reason: "post_payoff_context", extendToNode: 6 });
  });

  it("keeps downstream output and finalizer input identical while shadow observes before downrank", async () => {
    const off = clientFor(replies());
    const shadow = clientFor(replies({ results: [{ id: "c0", outcome: "hard_handoff", reason: "next_question", extendToNode: null }] }));
    const control = await analyzeHighlightsV2(transcript(), { client: off.client, cfg: loadAnalyzeConfig({}) });
    const observed = await analyzeHighlightsV2(transcript(), { client: shadow.client, cfg: loadAnalyzeConfig({ SAFE_END_AUDIT: "shadow" }) });

    expect(projection(observed)).toEqual(projection(control));
    expect(shadow.requests.map((request) => request.schema)).toEqual(["scan_candidates", "critic_verdicts", "safe_end_audit", "clip_finalizer"]);
    expect(safeEndTelemetry(observed)).toMatchObject({ normal: { hard_handoff: 1 } });
    expect(observed.highlights[0]).not.toHaveProperty("_safeEnd");
    expect(shadow.requests.find((request) => request.schema === "clip_finalizer")?.user).toEqual(
      off.requests.find((request) => request.schema === "clip_finalizer")?.user
    );
    expect(shadow.requests.find((request) => request.schema === "clip_finalizer")?.user).not.toContain("safe_end");
  });

  it("keeps every persisted highlight field identical with arc audit enabled", async () => {
    const arcReply = {
      results: [{
        id: "c0",
        entry: { ok: true, defect: null, fix_start_node: null },
        exit: { ok: true, defect: null, fix_end_node: null },
        standalone: { ok: true, missing: null },
      }],
    };
    const controlStub = clientFor({ ...replies(), arc_audit: arcReply });
    const shadowStub = clientFor({
      ...replies({ results: [{ id: "c0", outcome: "hard_handoff", reason: "topic_switch", extendToNode: null }] }),
      arc_audit: arcReply,
    });
    const cfg = loadAnalyzeConfig({ ARC_AUDIT: "on" });
    const control = await analyzeHighlightsV2(transcript(), { client: controlStub.client, cfg });
    const observed = await analyzeHighlightsV2(transcript(), {
      client: shadowStub.client,
      cfg: { ...cfg, safeEndAuditMode: "shadow" },
    });

    expect(projection(observed)).toEqual(projection(control));
    expect(observed.highlights[0]).toEqual(control.highlights[0]);
    expect(shadowStub.requests.find((request) => request.schema === "clip_finalizer")?.user).toEqual(
      controlStub.requests.find((request) => request.schema === "clip_finalizer")?.user
    );
  });

  it("rejects an afterbeat pointer outside the prompt's bounded forward context", async () => {
    const observed = await analyzeHighlightsV2(transcript(), {
      client: clientFor(replies({ results: [{ id: "c0", outcome: "needs_afterbeat", reason: "post_payoff_context", extendToNode: 11 }] })).client,
      cfg: loadAnalyzeConfig({ SAFE_END_AUDIT: "shadow" }),
    });

    expect(safeEndTelemetry(observed)?.normal.records[0]).toMatchObject({
      outcome: "audit_failed",
      failureCode: "malformed_response",
      extendToNode: null,
    });
  });

  it("audits the post-hook survivor before arc downrank removes the synthetic candidate", async () => {
    const stub = clientFor({
      ...replies(),
      critic_verdicts: { results: [{ ...critic.results[0], score: 0.7 }] },
      arc_audit: twoStandingArcFlags,
    });
    const result = await analyzeHighlightsV2(transcript(), {
      client: stub.client,
      cfg: loadAnalyzeConfig({
        SAFE_END_AUDIT: "shadow",
        ARC_AUDIT: "on",
        ARC_DOWNRANK: "on",
        POST_BOUNDARY_HOOK_GATE: "shadow",
        POST_BOUNDARY_HOOK_MAX_DELAY_SEC: "3",
        POST_BOUNDARY_HOOK_MAX_PRE_HOOK_GAP_SEC: "3",
      }),
    });

    expect(stub.requests.map((request) => request.schema)).toEqual([
      "scan_candidates",
      "critic_verdicts",
      "arc_audit",
      "safe_end_audit",
    ]);
    expect(safeEndTelemetry(result)?.normal).toMatchObject({ evaluated: 1, safe: 1 });
    expect(result.telemetry.postBoundaryHookGate).toBeDefined();
    expect(result.telemetry.arcDownrank).toMatchObject({ considered: 1, dropped: 1 });
    expect(result.highlights).toEqual([]);
  });

  it.each([
    ["refusal", "model_refusal"],
    ["malformed", "malformed_response"],
    ["timeout", "timeout"],
    ["sdk_timeout", "timeout"],
    ["truncated", "malformed_response"],
    ["serialization_failure", "construction_error"],
  ] as const)("fails open on %s without changing output", async (failure, code) => {
    const off = await analyzeHighlightsV2(transcript(), { client: clientFor(replies()).client, cfg: loadAnalyzeConfig({}) });
    const observed = await analyzeHighlightsV2(transcript(), { client: clientFor(replies(failure)).client, cfg: loadAnalyzeConfig({ SAFE_END_AUDIT: "shadow" }), retryDelayMs: 1 });

    expect(projection(observed)).toEqual(projection(off));
    expect(safeEndTelemetry(observed)?.normal).toMatchObject({ evaluated: 1, audit_failed: 1 });
    expect(safeEndTelemetry(observed)?.normal.records[0]).toMatchObject({
      outcome: "audit_failed",
      reason: null,
      failureCode: code,
    });
  });

  it("fails open when safe-end telemetry itself cannot be JSON serialized", async () => {
    const off = await analyzeHighlightsV2(transcript(), { client: clientFor(replies()).client, cfg: loadAnalyzeConfig({}) });
    const observed = await analyzeHighlightsV2(transcript(), {
      client: clientFor(replies()).client,
      cfg: loadAnalyzeConfig({ SAFE_END_AUDIT: "shadow" }),
      safeEndAuditTelemetryTestHook: (result) => ({
        ...(result as Record<string, unknown>),
        nonJson: BigInt(1),
      }),
    });

    expect(projection(observed)).toEqual(projection(off));
    expect(safeEndTelemetry(observed)?.normal).toMatchObject({ evaluated: 1, audit_failed: 1 });
    expect(safeEndTelemetry(observed)?.normal.records[0]).toMatchObject({
      outcome: "audit_failed",
      failureCode: "construction_error",
    });
  });

  it("only accepts closed safe-end rows", () => {
    expect(readSafeEndAuditRow({ id: "c0", outcome: "safe", reason: null, extendToNode: null })).toEqual({ id: "c0", outcome: "safe", reason: null, extendToNode: null });
    expect(readSafeEndAuditRow({ id: "c0", outcome: "needs_afterbeat", reason: "post_payoff_context", extendToNode: 6 })).toEqual({ id: "c0", outcome: "needs_afterbeat", reason: "post_payoff_context", extendToNode: 6 });
    expect(readSafeEndAuditRow({ id: "c0", outcome: "hard_handoff", reason: "topic_switch", extendToNode: null })).toEqual({ id: "c0", outcome: "hard_handoff", reason: "topic_switch", extendToNode: null });
    expect(readSafeEndAuditRow({ id: "c0", outcome: "safe", reason: "model prose", extendToNode: null })).toBeNull();
    expect(readSafeEndAuditRow({ id: "c0", outcome: "safe", reason: null, extendToNode: null, prose: "never persist" })).toBeNull();
  });

  it("builds a bounded synthetic prompt", () => {
    const nodes = Array.from({ length: 8 }, (_, index) => ({ index, start: index * 5, end: index * 5 + 4, text: `Invented line ${index}.`, hasWords: true, trailingStrength: 1, leadingStrength: 1 }));
    const prompt = safeEndAuditUserPrompt([{ verdict: { id: "synthetic" }, startSec: 0, endSec: 14, finalStartNode: 0, finalEndNode: 2 } as never], nodes);
    expect(prompt).toContain("Invented line 7.");
    expect(prompt).not.toContain("user transcript");
  });
});
