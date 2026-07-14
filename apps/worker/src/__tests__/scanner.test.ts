import { describe, expect, it, vi } from "vitest";
import { runScanner } from "../analyze-v2/scanner";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { newUsage } from "../analyze-v2/llm";
import type { SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCAN_WINDOW_SEC: "60", SCAN_OVERLAP_SEC: "10" });

function nodes(count: number): SentenceNode[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text: `n${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function clientReturning(perCall: Array<() => any>) {
  let n = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const f = perCall[Math.min(n, perCall.length - 1)];
          n += 1;
          return f();
        }),
      },
    },
  } as any;
}

const ok = (candidates: unknown[]) => ({
  choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
});

describe("runScanner", () => {
  it("collects candidates across windows and stamps windowIndex", async () => {
    const client = clientReturning([
      () => ok([{ start_node: 0, end_node: 2, payoff_node: 1, interest: 0.7, type: "funny", thread: null }]),
    ]);
    const r = await runScanner(client, newUsage(), nodes(30), cfg);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]).toMatchObject({ startNode: 0, endNode: 2, payoffNode: 1, interest: 0.7, windowIndex: 0 });
    expect(r.telemetry.windowsTotal).toBeGreaterThan(1);
    expect(r.telemetry.windowsFailed).toBe(0);
  });

  it("drops index-invalid rows and clamps interest", async () => {
    const client = clientReturning([
      () => ok([
        { start_node: -5, end_node: 2, payoff_node: 1, interest: 0.5, type: "funny", thread: null },
        { start_node: 0, end_node: 2, payoff_node: 99, interest: 7, type: "funny", thread: null },
      ]),
    ]);
    const r = await runScanner(client, newUsage(), nodes(10), cfg);
    // first row invalid (start_node<0) -> dropped; second row: payoff out of range -> coerced to start
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].payoffNode).toBe(0);
    expect(r.candidates[0].interest).toBe(1);
  });

  it("skips a window whose call fails twice and keeps going", async () => {
    let call = 0;
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            call += 1;
            if (call <= 2) throw Object.assign(new Error("boom"), { status: 500 });
            return ok([{ start_node: 12, end_node: 14, payoff_node: 13, interest: 0.6, type: "story", thread: null }]);
          }),
        },
      },
    } as any;
    const r = await runScanner(client, newUsage(), nodes(30), { ...cfg, maxConcurrency: 1 }, { retryDelayMs: 1 });
    expect(r.telemetry.windowsFailed).toBe(1);
    expect(r.candidates.length).toBeGreaterThan(0); // later windows survived
  });
});
