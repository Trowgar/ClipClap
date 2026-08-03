import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCritic,
  repairCopy,
  criticMaxOutputTokens,
  AnalyzeTechnicalError,
} from "../analyze-v2/critic";
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

describe("criticMaxOutputTokens", () => {
  // gpt-5.1 spends the cap on reasoning before emitting JSON. Live measurements
  // on the podcast-ecology critic prompts (reasoning_effort "low") - worst
  // completion_tokens observed per batch size: 1 -> 762, 3 -> 1931, 6 -> 3506.
  it("clears the worst measured completion at every production batch size", () => {
    expect(criticMaxOutputTokens(1)).toBe(2000);
    expect(criticMaxOutputTokens(3)).toBe(3600);
    expect(criticMaxOutputTokens(6)).toBe(6000);
    expect(criticMaxOutputTokens(1)).toBeGreaterThan(762);
    expect(criticMaxOutputTokens(3)).toBeGreaterThan(1931);
    expect(criticMaxOutputTokens(6)).toBeGreaterThan(3506);
  });

  it("scales per candidate - reasoning cost is per candidate, not fixed", () => {
    const perCandidate = criticMaxOutputTokens(6) - criticMaxOutputTokens(5);
    expect(perCandidate).toBe(800);
    // every split child must still clear the ~330-450 reasoning tokens per
    // candidate that made the old flat 400/candidate starve at every size
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(criticMaxOutputTokens(n) / n).toBeGreaterThan(450 + 150);
    }
  });

  it("keeps the capMultiplier escape hatch multiplicative", () => {
    expect(criticMaxOutputTokens(1, 2)).toBe(criticMaxOutputTokens(1) * 2);
    expect(criticMaxOutputTokens(6, 2)).toBe(criticMaxOutputTokens(6) * 2);
  });
});

describe("runCritic", () => {
  it("sends the sized budget as max_completion_tokens for a full batch", async () => {
    const caps: number[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            caps.push(body.max_completion_tokens);
            // Answers about ALL THREE deliberately: an incomplete answer now
            // buys a second, smaller call (the silent-omission retry), and this
            // test is about the budget a full batch is given. Asserting the
            // whole array therefore also pins "one batch, one call".
            return ok([verdictRow("a"), verdictRow("b", { id: "b" }), verdictRow("c", { id: "c" })]);
          }),
        },
      },
    } as any;
    const batch = [cand("a", 0), cand("b", 4), cand("c", 8)];
    await runCritic(client, newUsage(), nodes(20), batch, "ru", { ...cfg, criticBatchSize: 3 });
    expect(caps).toEqual([criticMaxOutputTokens(3)]);
  });

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

  it("keeps a rejection that carries no copy - blank title is the live reject shape", async () => {
    // There is no title to write for a clip you are killing, and the real model
    // says so: all three rejections in the podcast-answer-arc eval fixture came
    // back with title:"" description:"". The orchestrator never reads copy off a
    // keep:false verdict, so demanding it here silently converted the critic's
    // "no" into "the critic never answered".
    const client = seqClient([
      () => ok([
        verdictRow("a", { keep: false, score: 0.5, grounded: false, self_contained: false, title: "", description: "" }),
        verdictRow("b", { id: "b" }),
      ]),
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts).toHaveLength(2);
    expect(r.verdicts[0]).toMatchObject({ id: "a", keep: false, title: "", description: "" });
    expect(r.telemetry.invariantDrops).toBe(0);
    expect(r.telemetry.omittedDrops).toBe(0);
  });

  it("still drops a KEEP whose copy is blank - a clip we would ship needs a name", async () => {
    const client = seqClient([
      () => ok([verdictRow("a", { title: "  ", description: "ok" }), verdictRow("b", { id: "b" })]),
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts.map((v) => v.id)).toEqual(["b"]);
    expect(r.telemetry.invariantDrops).toBe(1);
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

  it("drops a single candidate that is still truncated after the doubled cap", async () => {
    const truncated = () => ({
      choices: [{ message: { content: "{" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 512 },
    });
    const client = seqClient([truncated, truncated]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 });
    expect(r.verdicts).toHaveLength(0);
    expect(r.telemetry.truncatedDrops).toBe(1);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
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

  it("validates ids per batch - a batch cannot steal another batch's id", async () => {
    const client = seqClient([
      () => ok([verdictRow("a"), verdictRow("b", { id: "b", title: "STOLEN" })]),
      () => ok([verdictRow("b", { id: "b", title: "REAL" })]),
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", { ...cfg, criticBatchSize: 1 });
    expect(r.verdicts).toHaveLength(2);
    expect(r.verdicts.find((v) => v.id === "b")?.title).toBe("REAL");
    expect(r.telemetry.invariantDrops).toBe(1);
  });

  it("counts candidates silently omitted from a successful batch", async () => {
    // The retry below cannot help here: this stub answers about "a" whatever it
    // is asked, so the re-ask comes back with a row for an id that is not in the
    // retried batch and dies on the per-batch id guard.
    const client = seqClient([() => ok([verdictRow("a")])]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts).toHaveLength(1);
    expect(r.telemetry.omittedDrops).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Silent-omission retry. Measured once on gpt-5.6-luna (podcast-ecology: 24
  // verdicts for 25 candidates, c8 unanswered, no marker of any kind).
  // ---------------------------------------------------------------------------

  it("re-asks exactly the omitted ids in one follow-up call", async () => {
    const asked: string[][] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            const ids = [...user.matchAll(/CANDIDATE (\w+)/g)].map((m) => m[1]);
            asked.push(ids);
            // first ask: answer about "a" only, say nothing about "b" or "c"
            if (asked.length === 1) return ok([verdictRow("a")]);
            return ok(ids.map((id) => verdictRow(id, { id })));
          }),
        },
      },
    } as any;
    const batch = [cand("a", 0), cand("b", 4), cand("c", 8)];
    const r = await runCritic(client, newUsage(), nodes(20), batch, "ru", {
      ...cfg,
      criticBatchSize: 3,
    });

    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    // exactly the missing ids, in candidate order - not the whole batch again
    expect(asked[1]).toEqual(["b", "c"]);
    expect(r.verdicts.map((v) => v.id).sort()).toEqual(["a", "b", "c"]);
    expect(r.telemetry.omittedFirstPass).toBe(2);
    expect(r.telemetry.omittedRecovered).toBe(2);
    expect(r.telemetry.omittedRetryFailed).toBe(0);
    expect(r.telemetry.omittedDrops).toBe(0);
  });

  it("makes no follow-up call when the batch answered about every candidate", async () => {
    const client = seqClient([
      () => ok([verdictRow("a"), verdictRow("b", { id: "b" }), verdictRow("c", { id: "c" })]),
    ]);
    const batch = [cand("a", 0), cand("b", 4), cand("c", 8)];
    const r = await runCritic(client, newUsage(), nodes(20), batch, "ru", {
      ...cfg,
      criticBatchSize: 3,
    });

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(r.verdicts).toHaveLength(3);
    expect(r.telemetry.omittedFirstPass).toBe(0);
    expect(r.telemetry.omittedRecovered).toBe(0);
    expect(r.telemetry.omittedRetryFailed).toBe(0);
  });

  it("drops a candidate the retry omits too - one pass, never a loop", async () => {
    // "b" is never mentioned, no matter how often it is asked about. Without the
    // one-pass bound this recurses until the stack or the bill runs out.
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => ok([verdictRow("a")])),
        },
      },
    } as any;
    const batch = [cand("a", 0), cand("b", 4)];
    const r = await runCritic(client, newUsage(), nodes(10), batch, "ru", {
      ...cfg,
      criticBatchSize: 2,
    });

    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(r.verdicts.map((v) => v.id)).toEqual(["a"]);
    expect(r.telemetry.omittedFirstPass).toBe(1);
    expect(r.telemetry.omittedRecovered).toBe(0);
    expect(r.telemetry.omittedRetryFailed).toBe(1);
    // the candidate is still an unattributed loss, which is what index.ts reads
    expect(r.telemetry.omittedDrops).toBe(1);
  });

  it("counts a rescued row that fails a business invariant as NOT recovered", async () => {
    // Recovery is measured against verdicts that survived every check, not
    // against rows the retry returned - otherwise a run could report a rescue
    // and still ship the thinner set.
    const client = seqClient([
      () => ok([verdictRow("a")]),
      () => ok([verdictRow("b", { id: "b", start_node: -1 })]),
    ]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0), cand("b", 4)], "ru", cfg);
    expect(r.verdicts.map((v) => v.id)).toEqual(["a"]);
    expect(r.telemetry.omittedFirstPass).toBe(1);
    expect(r.telemetry.omittedRecovered).toBe(0);
    expect(r.telemetry.omittedRetryFailed).toBe(1);
    expect(r.telemetry.invariantDrops).toBe(1);
  });

  it("degrades gracefully when the fallback model result is truncated", async () => {
    const boom = () => { throw Object.assign(new Error("down"), { status: 500 }); };
    const truncated = () => ({
      choices: [{ message: { content: "{" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 512 },
    });
    const client = seqClient([boom, boom, truncated]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 }, { retryDelayMs: 1 });
    expect(r.verdicts).toHaveLength(0);
    expect(r.telemetry.truncatedDrops).toBe(1);
    expect(r.telemetry.fallbackModelUsed).toBe(true);
  });

  it("flags verdicts produced by the fallback model as lowQuality", async () => {
    const boom = () => { throw Object.assign(new Error("down"), { status: 500 }); };
    const client = seqClient([boom, boom, () => ok([verdictRow("a")])]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 }, { retryDelayMs: 1 });
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0].lowQuality).toBe(true);
  });

  it("truncates titles on code points, never splitting a surrogate pair", async () => {
    const long = "x".repeat(68) + "😀" + "yyyy";
    const client = seqClient([() => ok([verdictRow("a", { title: long })])]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 });
    const title = r.verdicts[0]?.title ?? "";
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false);
    expect(title.endsWith("…")).toBe(true);
    expect(Array.from(title)).toHaveLength(70);
  });

  it("drops rows whose node indices are out of range", async () => {
    const client = seqClient([() => ok([verdictRow("a", { start_node: -1 })])]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", { ...cfg, criticBatchSize: 1 });
    expect(r.verdicts).toHaveLength(0);
    expect(r.telemetry.invariantDrops).toBe(1);
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

  it("returns null when the repaired copy is blank", async () => {
    const client = seqClient([
      () => ({
        choices: [{ message: { content: JSON.stringify({ title: "  ", description: "" }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    ]);
    const v: CriticVerdict = {
      id: "a", keep: true, score: 0.8, grounded: true, selfContained: true,
      startNode: 0, payoffNode: 2, endNode: 3, hookStartNode: 1, hookEndNode: 2,
      title: "Wrong language title", description: "Wrong language description.",
      titleEvidenceNodes: [2], descriptionEvidenceNodes: [2], language: "ru",
    };
    const r = await repairCopy(client, newUsage(), nodes(10), v, "ru", cfg);
    expect(r).toBeNull();
  });
});

/**
 * The fallback is an OPERATIONAL event: the clips this job ships were judged by
 * a model nobody selected. It has always been recorded - as one boolean among
 * ~thirty fields of a JSON blob - and on job cmscht6rp001xq41s5rhjx6q0 the
 * person investigating that very job read the blob and missed it. So it is a log
 * line, and these tests pin the two properties that make it useful: it names
 * both models and the stage, and it fires once per stage rather than once per
 * batch (four concurrent batches die together in an outage; four identical lines
 * teach nothing and bury the rest of the log).
 */
describe("critic fallback announcement", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Fails every call on the primary model, answers on any other. */
  function fallbackOnlyClient() {
    return {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            if (body.model === cfg.criticModel) {
              throw Object.assign(new Error("upstream down"), { status: 503 });
            }
            // Answer about exactly the candidates this batch was handed, so the
            // per-batch id guard has nothing to drop.
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            const ids = [...user.matchAll(/CANDIDATE (\w+) /g)].map((m) => m[1]);
            return ok(ids.map((id) => verdictRow(id)));
          }),
        },
      },
    } as any;
  }

  it("announces the fallback once, naming both models and the stage", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runCritic(
      fallbackOnlyClient(),
      newUsage(),
      nodes(20),
      [cand("a", 0), cand("b", 4), cand("c", 8), cand("d", 12)],
      "ru",
      { ...cfg, criticBatchSize: 1 },
      { retryDelayMs: 1 }
    );

    // four batches, every one of them degraded...
    expect(r.verdicts).toHaveLength(4);
    expect(r.telemetry.fallbackModelUsed).toBe(true);
    // ...and exactly one announcement about it
    const announcements = error.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("FALLBACK MODEL IN USE"));
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toContain("critic");
    expect(announcements[0]).toContain(cfg.criticModel);
    expect(announcements[0]).toContain(cfg.criticModelFallback);
  });

  it("says nothing when nothing falls back", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = seqClient([() => ok([verdictRow("a")])]);
    const r = await runCritic(client, newUsage(), nodes(10), [cand("a", 0)], "ru", {
      ...cfg,
      criticBatchSize: 1,
    });
    expect(r.telemetry.fallbackModelUsed).toBe(false);
    expect(
      error.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("FALLBACK"))
    ).toHaveLength(0);
  });
});
