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

  it("orders candidates by window index even when a later window answers first", async () => {
    // 20 nodes at these window/overlap settings produce exactly 2 windows:
    // nodes 0-13 and nodes 10-19. Window 0 is deliberately the SLOW one.
    const resolved: number[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            const user: string = body.messages.find((m: any) => m.role === "user").content;
            const isFirstWindow = user.includes("#0 n0.");
            const w = isFirstWindow ? 0 : 1;
            await new Promise((r) => setTimeout(r, isFirstWindow ? 40 : 1));
            resolved.push(w);
            return ok(
              isFirstWindow
                ? [
                    { start_node: 12, end_node: 13, payoff_node: 12, interest: 0.9, type: "funny", thread: null },
                    { start_node: 13, end_node: 13, payoff_node: 13, interest: 0.8, type: "story", thread: null },
                  ]
                : [
                    { start_node: 10, end_node: 11, payoff_node: 10, interest: 0.7, type: "funny", thread: null },
                    { start_node: 11, end_node: 12, payoff_node: 11, interest: 0.6, type: "story", thread: null },
                  ]
            );
          }),
        },
      },
    } as any;

    const r = await runScanner(client, newUsage(), nodes(20), { ...cfg, maxConcurrency: 2 });

    // premise of the test: the API really did answer window 1 before window 0
    expect(resolved).toEqual([1, 0]);
    expect(r.telemetry.windowsTotal).toBe(2);
    expect(r.candidates.map((c) => c.windowIndex)).toEqual([0, 0, 1, 1]);
    expect(r.candidates.map((c) => c.startNode)).toEqual([12, 13, 10, 11]);
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i].windowIndex).toBeGreaterThanOrEqual(r.candidates[i - 1].windowIndex);
    }
    expect(r.telemetry.candidatesPerWindow).toEqual([2, 2]);
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
