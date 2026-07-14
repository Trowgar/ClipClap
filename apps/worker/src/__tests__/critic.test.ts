import { describe, expect, it, vi } from "vitest";
import { runCritic, repairCopy, AnalyzeTechnicalError } from "../analyze-v2/critic";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import type { CriticVerdict, MergedCandidate, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ CRITIC_BATCH_SIZE: "2" });

function nodes(count: number): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text: `узел ${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function cand(id: string, startNode: number): MergedCandidate {
  return {
    id,
    startNode,
    endNode: startNode + 3,
    payoffNode: startNode + 2,
    interest: 0.6,
    type: "story",
    windowIndex: 0,
  };
}

const verdictRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  keep: true,
  score: 0.8,
  grounded: true,
  self_contained: true,
  start_node: 0,
  payoff_node: 2,
  end_node: 3,
  hook_start_node: 1,
  hook_end_node: 2,
  title: "Заголовок",
  description: "Описание момента.",
  title_evidence_nodes: [2],
  description_evidence_nodes: [2],
  language: "ru",
  ...over,
});

const ok = (results: unknown[]) => ({
  choices: [{ message: { content: JSON.stringify({ results }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
});

function seqClient(handlers: Array<(body: any) => any>) {
  let n = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async (body: any) => {
          const h = handlers[Math.min(n, handlers.length - 1)];
          n += 1;
          return h(body);
        }),
      },
    },
  } as any;
}

describe("runCritic", () => {
  it("returns camelCase verdicts for every candidate id, kind from candidate type", async () => {
    const client = seqClient([() => ok([verdictRow("a"), verdictRow("b", { id: "b" })])]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts).toHaveLength(2);
    expect(r.verdicts[0]).toMatchObject({ id: "a", selfContained: true, titleEvidenceNodes: [2], kind: "story" });
  });

  it("drops rows with unknown or duplicate ids and invalid fields (business invariants)", async () => {
    const client = seqClient([
      () => ok([
        verdictRow("a"),
        verdictRow("a"),
        verdictRow("ghost", { id: "ghost" }),
        verdictRow("b", { id: "b", score: 7 }),
      ]),
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts).toHaveLength(1);
    expect(r.telemetry.invariantDrops).toBe(3);
  });

  it("splits the batch on truncation down to singles", async () => {
    const truncated = () => ({
      choices: [{ message: { content: "{" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 512 },
    });
    const client = seqClient([
      truncated,                                 // batch of 2 -> truncated
      () => ok([verdictRow("a")]),               // single a
      () => ok([verdictRow("b", { id: "b" })]),  // single b
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts).toHaveLength(2);
    expect(r.telemetry.batchSplits).toBe(1);
  });

  it("doubles the output cap once for a truncated single", async () => {
    const truncated = () => ({
      choices: [{ message: { content: "{" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 512 },
    });
    const caps: number[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            caps.push(body.max_completion_tokens);
            if (caps.length === 1) return truncated();
            return ok([verdictRow("a")]);
          }),
        },
      },
    } as any;
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 });
    expect(r.verdicts).toHaveLength(1);
    expect(caps[1]).toBe(caps[0] * 2);
  });

  it("drops the batch's candidates after two refusals", async () => {
    const refusal = () => ({
      choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const client = seqClient([refusal]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 });
    expect(r.verdicts).toHaveLength(0);
    expect(r.telemetry.refusalDrops).toBe(1);
  });

  it("falls back to the fallback model on persistent API errors", async () => {
    const models: string[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            models.push(body.model);
            if (models.length <= 2) throw Object.assign(new Error("down"), { status: 500 });
            return ok([verdictRow("a")]);
          }),
        },
      },
    } as any;
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 }, { retryDelayMs: 1 });
    expect(r.verdicts).toHaveLength(1);
    expect(r.telemetry.fallbackModelUsed).toBe(true);
    expect(models[2]).toBe(cfg.criticModelFallback);
  });

  it("throws AnalyzeTechnicalError when both models are down", async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => { throw Object.assign(new Error("down"), { status: 500 }); }),
        },
      },
    } as any;
    await expect(
      runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 }, { retryDelayMs: 1 })
    ).rejects.toBeInstanceOf(AnalyzeTechnicalError);
  });
});

describe("repairCopy", () => {
  it("returns repaired title/description, null on failure", async () => {
    const client = seqClient([
      () => ({
        choices: [{ message: { content: JSON.stringify({ title: "Он рискнул всем", description: "Описание." }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
      () => { throw Object.assign(new Error("down"), { status: 500 }); },
    ]);
    const v: CriticVerdict = {
      id: "a", keep: true, score: 0.8, grounded: true, selfContained: true,
      startNode: 0, payoffNode: 2, endNode: 3, hookStartNode: 1, hookEndNode: 2,
      title: "Wrong language title", description: "Wrong language description.",
      titleEvidenceNodes: [2], descriptionEvidenceNodes: [2], language: "ru",
    };
    const r = await repairCopy(client, newUsage(), nodes(10), v, "ru", cfg);
    expect(r).toEqual({ title: "Он рискнул всем", description: "Описание." });
    const r2 = await repairCopy(client, newUsage(), nodes(10), v, "ru", { ...cfg }, { retryDelayMs: 1 });
    expect(r2).toBeNull();
  });
});
