import { describe, expect, it, vi } from "vitest";
import type { TranscriptionResult } from "@clipclap/shared";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { AnalyzeTechnicalError } from "../analyze-v2/critic";

function transcript(): TranscriptionResult {
  const segments = Array.from({ length: 40 }, (_, index) => {
    const start = index * 5;
    return {
      start,
      end: start + 4.5,
      text: `Scene sentence ${index}.`,
      words: [
        { text: "Scene", start, end: start + 1 },
        { text: "sentence", start: start + 1.1, end: start + 2.4 },
        { text: `${index}.`, start: start + 2.5, end: start + 4.5 },
      ],
    };
  });
  return { text: segments.map((segment) => segment.text).join(" "), segments, language: "en" };
}

function scanResponse() {
  return { candidates: [
    { start_node: 20, end_node: 24, payoff_node: 23, interest: 0.8, type: "story", thread: null },
  ] };
}

function tinyTranscript(): TranscriptionResult {
  const segments = Array.from({ length: 6 }, (_, index) => {
    const start = index * 5;
    return {
      start,
      end: start + 4.5,
      text: `Tiny sentence ${index}.`,
      words: [
        { text: "Tiny", start, end: start + 1 },
        { text: "test", start: start + 1.1, end: start + 2 },
        { text: "scene", start: start + 2.1, end: start + 3 },
        { text: `${index}.`, start: start + 3.1, end: start + 4.5 },
      ],
    };
  });
  return { text: segments.map((segment) => segment.text).join(" "), segments, language: "en" };
}

function tinyVerdict(id: string) {
  return verdict(id, true, 0, 5, 3);
}

function tinyReplayClient() {
  const requests: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (body: Record<string, unknown>) => {
    requests.push(body);
    const schema = (body.response_format as { json_schema: { name: string } }).json_schema.name;
    if (schema !== "critic_verdicts") throw new Error(`unexpected schema ${schema}`);
    return {
      choices: [{ message: { content: JSON.stringify({ results: [tinyVerdict("c0")] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
  });
  return { client: { chat: { completions: { create } } } as never, requests };
}

function verdict(id: string, keep: boolean, startNode: number, endNode: number, payoffNode: number) {
  return {
    id,
    keep,
    score: keep ? 0.85 : 0.2,
    grounded: true,
    self_contained: true,
    start_node: startNode,
    payoff_node: payoffNode,
    end_node: endNode,
    hook_start_node: startNode,
    hook_end_node: payoffNode,
    title: `Scene ${id}`,
    description: `Description ${id}.`,
    title_evidence_nodes: [payoffNode],
    description_evidence_nodes: [payoffNode],
    language: "en",
  };
}

function replayClient() {
  const requests: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (body: Record<string, unknown>) => {
    requests.push(body);
    const schema = (body.response_format as { json_schema: { name: string } }).json_schema.name;
    if (schema === "scan_candidates") return {
      choices: [{ message: { content: JSON.stringify(scanResponse()) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
    if (schema === "critic_verdicts") {
      const user = String((body.messages as Array<{ role: string; content: string }>).find((message) => message.role === "user")?.content ?? "");
      const rows = user.includes("type visual_action")
        ? [
            verdict("c0", true, 20, 24, 23),
            verdict("c1", false, 0, 4, 3),
          ]
        : [verdict("c0", true, 20, 24, 23)];
      return {
        choices: [{ message: { content: JSON.stringify({ results: rows }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      };
    }
    throw new Error(`unexpected schema ${schema}`);
  });
  return { client: { chat: { completions: { create } } } as never, requests };
}

function cfg(mode: "off" | "shadow" | "on") {
  return loadAnalyzeConfig({
    ANALYZE_FINALIZER: "off",
    SAFE_END_AUDIT: "off",
    ANALYZE_VISUAL_RECALL_V1: mode,
  });
}

const motion = Array.from({ length: 40 }, (_, index) => index === 5 ? 100 : 0);

describe("visual recall wiring", () => {
  it("keeps off and shadow highlight sets byte-identical while shadow reports visual telemetry", async () => {
    const off = await analyzeHighlightsV2(transcript(), {
      client: replayClient().client,
      cfg: cfg("off"),
      retryDelayMs: 1,
    });
    const shadow = await analyzeHighlightsV2(transcript(), {
      client: replayClient().client,
      cfg: cfg("shadow"),
      motionEnvelope: motion,
      retryDelayMs: 1,
    });

    expect(off.highlights).toEqual(shadow.highlights);
    expect(off.telemetry).not.toHaveProperty("visualRecall");
    expect(shadow.telemetry.visualRecall).toMatchObject({ mode: "shadow" });
  });

  it("unions visual candidates before critic and records their survival", async () => {
    const replay = replayClient();
    const result = await analyzeHighlightsV2(transcript(), {
      client: replay.client,
      cfg: cfg("on"),
      motionEnvelope: motion,
      retryDelayMs: 1,
    });

    expect(result.telemetry.visualRecall).toMatchObject({
      mode: "on",
      unionCandidates: 1,
      mergedByType: { visual_action: 1 },
      criticByType: { visual_action: 1 },
    });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0].title).toBe("Scene c0");
    expect(replay.requests.some((request) => JSON.stringify(request).includes("type story"))).toBe(true);
    expect(replay.requests.some((request) => JSON.stringify(request).includes("type visual_action"))).toBe(true);
  });

  it("keeps tiny off and shadow output identical and attaches shadow no-motion telemetry", async () => {
    const off = await analyzeHighlightsV2(tinyTranscript(), {
      client: tinyReplayClient().client,
      cfg: cfg("off"),
      retryDelayMs: 1,
    });
    const shadow = await analyzeHighlightsV2(tinyTranscript(), {
      client: tinyReplayClient().client,
      cfg: cfg("shadow"),
      retryDelayMs: 1,
    });

    expect(off.highlights).toEqual(shadow.highlights);
    expect(off.telemetry).not.toHaveProperty("visualRecall");
    expect(shadow.telemetry).toHaveProperty("visualRecall");
    expect(shadow.telemetry.visualRecall).toMatchObject({ mode: "shadow", reason: "no_motion_envelope" });
  });

  it("unions tiny visual nominations into the ordinary candidate before critic", async () => {
    const replay = tinyReplayClient();
    const result = await analyzeHighlightsV2(tinyTranscript(), {
      client: replay.client,
      cfg: cfg("on"),
      motionEnvelope: [0, 100, 0, 0, 0, 0],
      retryDelayMs: 1,
    });

    expect((result.telemetry.visualRecall as { unionCandidates: number }).unionCandidates).toBeGreaterThan(0);
    expect(replay.requests.some((request) => JSON.stringify(request).includes("type visual_action"))).toBe(true);
  });

  it("degrades missing motion in shadow and on without changing transcript output", async () => {
    const shadow = await analyzeHighlightsV2(transcript(), {
      client: replayClient().client,
      cfg: cfg("shadow"),
      retryDelayMs: 1,
    });
    const on = await analyzeHighlightsV2(transcript(), {
      client: replayClient().client,
      cfg: cfg("on"),
      retryDelayMs: 1,
    });

    expect(on.highlights).toEqual(shadow.highlights);
    expect(shadow.telemetry.visualRecall).toMatchObject({ mode: "shadow", reason: "no_motion_envelope" });
    expect(on.telemetry.visualRecall).toMatchObject({ mode: "on", reason: "no_motion_envelope" });
  });

  it("keeps scanner total outage as a technical failure", async () => {
    const create = vi.fn(async () => { throw new Error("scanner unavailable"); });
    await expect(analyzeHighlightsV2(transcript(), {
      client: { chat: { completions: { create } } } as never,
      cfg: cfg("on"),
      motionEnvelope: motion,
      retryDelayMs: 1,
    })).rejects.toBeInstanceOf(AnalyzeTechnicalError);
  });
});
