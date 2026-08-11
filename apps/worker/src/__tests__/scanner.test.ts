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

  it("skips a window whose call fails every attempt and keeps going", async () => {
    // Keyed on WHICH window is being scanned, not on a call count: the point is
    // that one window is unreachable however many times llm.ts asks, and a test
    // that counted calls would silently change meaning the next time the retry
    // bound moves.
    let deadWindowPrompt: string | undefined;
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            const prompt = body.messages[1].content;
            deadWindowPrompt ??= prompt;
            if (prompt === deadWindowPrompt) {
              throw Object.assign(new Error("boom"), { status: 500 });
            }
            return ok([{ start_node: 12, end_node: 14, payoff_node: 13, interest: 0.6, type: "story", thread: null }]);
          }),
        },
      },
    } as any;
    const r = await runScanner(client, newUsage(), nodes(30), { ...cfg, maxConcurrency: 1 }, { retryDelayMs: 1 });
    expect(r.telemetry.windowsFailed).toBe(1);
    expect(r.candidates.length).toBeGreaterThan(0); // later windows survived
  });

  // ---------------------------------------------------------------------
  // scanPasses (spec 2026-08-11 "Scan recall remedy", Phase B)
  // ---------------------------------------------------------------------

  it("stamps passIndex 0 on every candidate at the default scanPasses of 1", async () => {
    // The byte-identity claim, at the unit level: nothing about a single-pass
    // run should look any different than before this field existed.
    expect(cfg.scanPasses).toBe(1);
    const client = clientReturning([
      () => ok([{ start_node: 0, end_node: 2, payoff_node: 1, interest: 0.7, type: "funny", thread: null }]),
    ]);
    const r = await runScanner(client, newUsage(), nodes(30), cfg);
    expect(r.candidates.every((c) => c.passIndex === 0)).toBe(true);
  });

  it("unions passes per window, flattening candidates in (window, pass) order, stably across invocations", async () => {
    // 20 nodes at these window/overlap settings produce exactly 2 windows
    // (see the completion-order test above): nodes 0-13 and nodes 10-19.
    // clientReturning serves responses in CALL order, and the task list is
    // built (window, pass) nested - so the 4 responses below line up with
    // (w0,p0), (w0,p1), (w1,p0), (w1,p1) if and only if the mechanism
    // actually flattens in that order rather than window-then-all-passes-
    // interleaved-by-completion-time.
    const responses = [
      () => ok([{ start_node: 0, end_node: 1, payoff_node: 0, interest: 0.9, type: "funny", thread: null }]),
      () => ok([{ start_node: 1, end_node: 2, payoff_node: 1, interest: 0.5, type: "funny", thread: null }]),
      () => ok([{ start_node: 10, end_node: 11, payoff_node: 10, interest: 0.7, type: "story", thread: null }]),
      () => ok([{ start_node: 11, end_node: 12, payoff_node: 11, interest: 0.3, type: "story", thread: null }]),
    ];
    const passCfg = { ...cfg, scanPasses: 2 };

    const shape = (candidates: { windowIndex: number; passIndex?: number; interest: number }[]) =>
      candidates.map((c) => ({ windowIndex: c.windowIndex, passIndex: c.passIndex, interest: c.interest }));

    const r1 = await runScanner(clientReturning(responses), newUsage(), nodes(20), passCfg);
    expect(shape(r1.candidates)).toEqual([
      { windowIndex: 0, passIndex: 0, interest: 0.9 },
      { windowIndex: 0, passIndex: 1, interest: 0.5 },
      { windowIndex: 1, passIndex: 0, interest: 0.7 },
      { windowIndex: 1, passIndex: 1, interest: 0.3 },
    ]);
    expect(r1.telemetry.windowsTotal).toBe(2);
    expect(r1.telemetry.windowsFailed).toBe(0);

    // stable across a second, independent invocation of the same stub - not
    // a lucky ordering from one run
    const r2 = await runScanner(clientReturning(responses), newUsage(), nodes(20), passCfg);
    expect(shape(r2.candidates)).toEqual(shape(r1.candidates));
  });

  it("a failed pass leaves the OTHER pass's candidates for that window intact, and does not fail the window", async () => {
    // window 0's pass 0 succeeds; pass 1 (and its retries) fail every time.
    // window 1's both passes succeed. The window must survive on its live
    // pass alone, and must NOT count toward windowsFailed - index.ts's
    // "every window failed" hard-failure check reads windowsFailed ===
    // windowsTotal, and a window with one live pass out of two produced real
    // candidates, so it did not fail.
    let window0Calls = 0;
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            const prompt = body.messages[1].content;
            const isWindow0 = prompt.includes("#0 n0.");
            if (!isWindow0) {
              return ok([{ start_node: 10, end_node: 11, payoff_node: 10, interest: 0.6, type: "story", thread: null }]);
            }
            window0Calls += 1;
            if (window0Calls === 1) {
              return ok([{ start_node: 0, end_node: 1, payoff_node: 0, interest: 0.9, type: "funny", thread: null }]);
            }
            throw Object.assign(new Error("boom"), { status: 500 });
          }),
        },
      },
    } as any;

    const passCfg = { ...cfg, scanPasses: 2, maxConcurrency: 1 };
    const r = await runScanner(client, newUsage(), nodes(20), passCfg, { retryDelayMs: 1 });

    const window0Candidates = r.candidates.filter((c) => c.windowIndex === 0);
    expect(window0Candidates).toHaveLength(1);
    expect(window0Candidates[0].interest).toBe(0.9);
    expect(r.candidates.filter((c) => c.windowIndex === 1)).toHaveLength(2);
    expect(r.telemetry.windowsFailed).toBe(0);
    expect(r.telemetry.windowsTotal).toBe(2);
  });

  it("counts a window as failed only when EVERY one of its passes failed", async () => {
    // Both passes of window 0 die; window 1 is healthy throughout - the
    // control that proves the ALL-passes-failed condition is reachable at
    // passes>1, not just vacuously true because nothing ever fails twice.
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (body: any) => {
            const prompt = body.messages[1].content;
            if (prompt.includes("#0 n0.")) {
              throw Object.assign(new Error("boom"), { status: 500 });
            }
            return ok([{ start_node: 10, end_node: 11, payoff_node: 10, interest: 0.6, type: "story", thread: null }]);
          }),
        },
      },
    } as any;

    const passCfg = { ...cfg, scanPasses: 2, maxConcurrency: 1 };
    const r = await runScanner(client, newUsage(), nodes(20), passCfg, { retryDelayMs: 1 });

    expect(r.candidates.filter((c) => c.windowIndex === 0)).toHaveLength(0);
    expect(r.candidates.filter((c) => c.windowIndex === 1)).toHaveLength(2);
    expect(r.telemetry.windowsFailed).toBe(1);
    expect(r.telemetry.windowsTotal).toBe(2);
  });
});
