import { describe, expect, it, vi } from "vitest";
import { callJsonSchema, newUsage } from "../analyze-v2/llm";
import { SCANNER_SCHEMA } from "../analyze-v2/schemas";

function fakeClient(responses: Array<() => any>) {
  let call = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const r = responses[Math.min(call, responses.length - 1)];
          call += 1;
          return r();
        }),
      },
    },
  } as any;
}

const okResponse = (content: unknown) => ({
  choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

describe("callJsonSchema", () => {
  it("parses a completed structured response and accumulates usage", async () => {
    const usage = newUsage();
    const client = fakeClient([() => okResponse({ candidates: [] })]);
    const r = await callJsonSchema(client, usage, {
      model: "gpt-4o-mini",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
    });
    expect(r).toEqual({ ok: true, data: { candidates: [] } });
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 20, requests: 1 });
  });

  it("reports truncation distinctly (finish_reason length)", async () => {
    const client = fakeClient([
      () => ({
        choices: [{ message: { content: "{\"cand" }, finish_reason: "length" }],
        usage: { prompt_tokens: 50, completion_tokens: 400 },
      }),
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.1",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      maxOutputTokens: 400,
    });
    expect(r).toEqual({ ok: false, kind: "truncated" });
  });

  it("reports refusal distinctly", async () => {
    const client = fakeClient([
      () => ({
        choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.1",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
    });
    expect(r).toEqual({ ok: false, kind: "refusal" });
  });

  it("retries once on a transient API error, then reports error", async () => {
    const client = fakeClient([
      () => { throw Object.assign(new Error("boom"), { status: 500 }); },
      () => { throw Object.assign(new Error("boom"), { status: 500 }); },
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-4o-mini",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("error");
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    const client = fakeClient([
      () => { throw Object.assign(new Error("boom"), { status: 429 }); },
      () => okResponse({ candidates: [] }),
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-4o-mini",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });
    expect(r.ok).toBe(true);
  });

  it("passes reasoning_effort only to gpt-5 models", async () => {
    const client = fakeClient([() => okResponse({ candidates: [] })]);
    await callJsonSchema(client, newUsage(), {
      model: "gpt-4o-mini",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      reasoningEffort: "low",
    });
    const bodyMini = client.chat.completions.create.mock.calls[0][0];
    expect("reasoning_effort" in bodyMini).toBe(false);

    await callJsonSchema(client, newUsage(), {
      model: "gpt-5.1",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      reasoningEffort: "low",
    });
    const body51 = client.chat.completions.create.mock.calls[1][0];
    expect(body51.reasoning_effort).toBe("low");
  });
});

describe("mapWithConcurrency", () => {
  it("processes all items preserving order with bounded concurrency", async () => {
    const { mapWithConcurrency } = await import("../analyze-v2/llm");
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(results).toEqual(items.map((n) => n * 2));
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});
