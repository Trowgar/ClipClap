import { describe, expect, it, vi } from "vitest";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult, WhisperSegment } from "@clipclap/shared";

/** Characterization fixtures for the pre-extraction quality lane.  These tests
 * intentionally call the public analyzer: the lane did not have a seam before
 * this refactor, so the observable contract is the customer's result. */
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

const scan = {
  choices: [{ message: { content: JSON.stringify({ candidates: [
    { start_node: 10, end_node: 14, payoff_node: 13, interest: 0.8, type: "story", thread: null },
  ] }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 30 },
};

function critic(patch: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: JSON.stringify({ results: [{
      id: "c0", keep: true, score: 0.85, grounded: true, self_contained: true,
      start_node: 10, payoff_node: 13, end_node: 14,
      hook_start_node: 12, hook_end_node: 13,
      title: "Он назвал номер", description: "Спикер называет номер предложения.",
      title_evidence_nodes: [13], description_evidence_nodes: [13], language: "ru",
      ...patch,
    }] }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 200, completion_tokens: 80 },
  };
}

const finalizer = {
  choices: [{ message: { content: JSON.stringify({ clips: [{
    id: "c0", verdict: "ship", drop_reason: null, duplicate_of: null,
    shared_claim: null, title: null, title_evidence_nodes: null,
    trim_start_node: null,
  }] }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 300, completion_tokens: 90 },
};

function client(responses: unknown[]) {
  let index = 0;
  const create = vi.fn(async (body: any) => {
    const response = responses[Math.min(index++, responses.length - 1)];
    return typeof response === "function" ? response(body) : response;
  });
  return { client: { chat: { completions: { create } } } as any, create };
}

function projection(result: Awaited<ReturnType<typeof analyzeHighlightsV2>>) {
  return {
    highlights: result.highlights,
    noClipsReason: result.noClipsReason,
    usage: result.usage,
    telemetry: result.telemetry,
  };
}

describe("quality lane characterization", () => {
  it("keeps the current keep path byte-for-byte observable", async () => {
    const c = client([scan, critic(), finalizer]);
    const result = await analyzeHighlightsV2(transcript(), {
      client: c.client,
      cfg: loadAnalyzeConfig({}),
      transcriptPartial: false,
    });

    expect(projection(result)).toMatchInlineSnapshot(`
      {
        "highlights": [
          {
            "_boundaryConfidence": "word",
            "_descriptionEvidenceNodes": [
              13,
            ],
            "_endNode": 13,
            "_grounded": true,
            "_startNode": 10,
            "_titleEvidenceNodes": [
              13,
            ],
            "description": "Спикер называет номер предложения.",
            "end": 69.8,
            "hookEnd": 69.5,
            "hookStart": 60,
            "kind": "story",
            "language": "ru",
            "lowQuality": false,
            "payoffAt": 69.5,
            "score": 0.85,
            "shortMoment": false,
            "start": 49.85,
            "title": "Он назвал номер",
          },
        ],
        "noClipsReason": undefined,
        "telemetry": {
          "batchSplits": 0,
          "candidatesPerWindow": [
            1,
          ],
          "copyRegrounded": [],
          "copyRepairs": 0,
          "criticBudgetK": 8,
          "criticCandidates": 1,
          "criticUnjudgedPool": 0,
          "criticVerdicts": 1,
          "dropCapHits": 0,
          "droppedByNms": 0,
          "droppedVerdicts": [],
          "dropsProtected": [],
          "durations": [
            19.9,
          ],
          "endExtension": {
            "applied": 0,
            "contradicted": 0,
            "fallbackModelUsed": false,
            "offered": 0,
            "proposed": 0,
            "refused": 0,
            "refusedBy": {},
            "secondsGained": 0,
            "skipped": "disabled",
          },
          "evidenceDrops": 0,
          "evidenceOutOfRange": {},
          "evidenceWidened": 0,
          "fallbackModelUsed": false,
          "finalizerDrops": [],
          "finalizerSurvivors": 1,
          "gateDropReasons": {},
          "hookDedupDrops": [],
          "invariantDrops": 0,
          "kept": 1,
          "meanLexicalOverlap": 0.5,
          "mergedCandidates": 1,
          "omittedDrops": 0,
          "omittedFirstPass": 0,
          "omittedRecovered": 0,
          "omittedRetryFailed": 0,
          "openingTrims": [],
          "path": "full",
          "rawCandidates": 1,
          "refusalDrops": 0,
          "rewriteRejected": [],
          "selectedForFinalizer": 1,
          "semanticDedupDrops": [],
          "snapDrops": 0,
          "snippetFallbacks": 0,
          "snippetTitleRepairs": [],
          "snippetTitlesFlagged": 0,
          "snippetTitlesKept": 0,
          "snippetTitlesRepaired": 0,
          "sourceSec": 180,
          "speechSec": 180,
          "teaserDrops": [],
          "teaserRegion": null,
          "tier": "strong",
          "titleRewrites": [],
          "trimRejected": [],
          "truncatedDrops": 0,
          "verdictScores": [
            {
              "id": "c0",
              "keep": true,
              "score": 0.85,
            },
          ],
          "windowsFailed": 0,
          "windowsTotal": 1,
        },
        "usage": {
          "byModel": {
            "gpt-4o-mini": {
              "inputTokens": 100,
              "outputTokens": 30,
              "requests": 1,
            },
            "gpt-5.6-luna": {
              "inputTokens": 500,
              "outputTokens": 170,
              "requests": 2,
            },
          },
          "inputTokens": 600,
          "outputTokens": 200,
          "requests": 3,
        },
      }
    `);
  });

  it("keeps a critic rejection as an honest empty result", async () => {
    const c = client([scan, critic({ keep: false })]);
    const result = await analyzeHighlightsV2(transcript(), {
      client: c.client,
      cfg: loadAnalyzeConfig({}),
      transcriptPartial: false,
    });
    expect(result.highlights).toEqual([]);
    expect(result.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(result.telemetry).toMatchObject({
      criticVerdicts: 1,
      kept: 0,
      evidenceDrops: 0,
      snapDrops: 0,
      selectedForFinalizer: 0,
      finalizerSurvivors: 0,
    });
    expect(result.usage.requests).toBe(2);
  });

  it("records snap rejection and still returns the existing empty semantics", async () => {
    const c = client([scan, critic({ start_node: 39, end_node: 39, payoff_node: 39 })]);
    const result = await analyzeHighlightsV2(transcript(), {
      client: c.client,
      cfg: loadAnalyzeConfig({}),
      transcriptPartial: false,
    });
    expect(result.highlights).toEqual([]);
    expect(result.noClipsReason).toBe("NO_VIABLE_MOMENTS");
    expect(result.telemetry.snapDrops).toBe(1);
    expect(result.telemetry.droppedVerdicts).toEqual([
      { id: "c0", stage: "snap", reason: "invariant_violation", score: 0.85 },
    ]);
  });

  it("proves the enabled arc, standalone, and finalizer authorities are invoked", async () => {
    const arc = {
      results: [{ id: "c0", entry: { ok: true, defect: null, fix_start_node: null },
        exit: { ok: true, defect: null, fix_end_node: null },
        standalone: { ok: true, missing: null } }],
    };
    const c = client([scan, critic(), (body: any) => {
      expect(body.response_format.json_schema.name).toBe("arc_audit");
      return { choices: [{ message: { content: JSON.stringify(arc) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } };
    }, (body: any) => {
      expect(body.response_format.json_schema.name).toBe("clip_finalizer");
      return finalizer;
    }]);
    const result = await analyzeHighlightsV2(transcript(), {
      client: c.client,
      cfg: loadAnalyzeConfig({ ARC_AUDIT: "on", ANALYZE_STANDALONE_FILTER_V1: "on" }),
      transcriptPartial: false,
    });

    expect(result.highlights).toHaveLength(1);
    expect(c.create).toHaveBeenCalledTimes(4);
    expect(result.telemetry.arcAudit).toMatchObject({ audited: 1 });
    expect(result.telemetry.standaloneFilter).toMatchObject({ considered: 1, dropped: 0 });
    expect(result.telemetry.finalizerSurvivors).toBe(1);
  });
});
