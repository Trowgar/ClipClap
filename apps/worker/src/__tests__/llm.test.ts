import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callJsonSchema,
  isRetryableFailure,
  newUsage,
  nextRetryDelayMs,
} from "../analyze-v2/llm";
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
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      requests: 1,
      byModel: { "gpt-4o-mini": { inputTokens: 100, outputTokens: 20, requests: 1 } },
    });
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

  it("retries a transient API error to the bound, then reports error", async () => {
    const client = fakeClient([
      () => { throw Object.assign(new Error("boom"), { status: 500 }); },
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
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
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

  it("still passes reasoning_effort to gpt-5.6-luna", async () => {
    // The critic's whole token-budget table was measured with this parameter
    // set. If the gate ever stops matching the default model's name, every
    // number in that table describes a request the engine no longer makes -
    // and reasoning tokens are the dominant term the budget is sized for.
    const client = fakeClient([() => okResponse({ candidates: [] })]);
    await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      reasoningEffort: "low",
    });
    expect(client.chat.completions.create.mock.calls[0][0]).toMatchObject({
      reasoning_effort: "low",
    });
  });
});

/**
 * The failure log is the only record that exists of WHY a call died.
 *
 * Before it, callJsonSchema returned the message in a field nothing reads:
 * critic.ts counts a `kind` and moves on, so job cmscht6rp001xq41s5rhjx6q0 had
 * every critic batch fail on gpt-5.6-luna, silently re-judged all 22 candidates
 * on the fallback model, and left no way to learn what the API had said. These
 * tests pin the three facts an investigation needs (which model, which attempt,
 * what the API said) and the distinction that makes the log worth reading at all
 * - an absorbed blip must not look like a hard failure.
 */
describe("callJsonSchema failure logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the model, status, code and message of a failed attempt", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient([
      () => {
        throw Object.assign(new Error("Connection error."), {
          status: 500,
          code: "server_error",
          type: "api_error",
        });
      },
    ]);
    await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });

    const line = error.mock.calls.at(-1)?.[0] as string;
    expect(line).toContain("model=gpt-5.6-luna");
    expect(line).toContain("status=500");
    expect(line).toContain("code=server_error");
    expect(line).toContain("type=api_error");
    expect(line).toContain("Connection error.");
  });

  it("distinguishes the absorbed retry from the final give-up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient([
      () => {
        throw Object.assign(new Error("boom"), { status: 429 });
      },
      () => okResponse({ candidates: [] }),
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });

    // The call SUCCEEDED. One warning, no error: an operator scanning for
    // errors must not be paged by a blip the retry already absorbed.
    expect(r.ok).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("attempt=1/3");
    expect(warn.mock.calls[0][0]).toContain("retrying");
    expect(error).not.toHaveBeenCalled();
  });

  it("raises the level and the wording when every retry fails too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient([
      () => {
        throw Object.assign(new Error("boom"), { status: 503 });
      },
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });

    expect(r.ok).toBe(false);
    // Two absorbed-and-retried warnings, then one give-up error - never two
    // errors, or an operator counting alerts would read one outage as several.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("attempt=3/3");
    expect(error.mock.calls[0][0]).toContain("giving up");
  });

  it("survives an error that is not an API error and still names the model", async () => {
    // The catch sees aborts, TypeErrors and plain strings too. A logger that
    // assumed the SDK's shape would throw INSIDE the failure path.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient([
      () => {
        throw "just a string";
      },
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5-mini",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });
    expect(r.ok).toBe(false);
    const line = error.mock.calls.at(-1)?.[0] as string;
    expect(line).toContain("model=gpt-5-mini");
    expect(line).toContain("status=- code=- type=-");
    expect(line).toContain("just a string");
  });

  it("logs a successful-looking response that carries no usable content", async () => {
    // Same {kind:"error"} as a thrown failure, same fallback downstream, and
    // before this it was even quieter - nothing threw at all.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient([
      () => ({
        choices: [{ message: { content: null, refusal: null }, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 0 },
      }),
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
    });
    expect(r.ok).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("empty content");
  });
});

/**
 * Per-model attribution. The totals cannot be priced: a job that degrades pays
 * two providers' rates, and pricing the sum at the configured model's rate
 * understated job cmscht6rp001xq41s5rhjx6q0 by ~48% - the figure the free-tier
 * ledger is settled against.
 */
describe("usage attribution", () => {
  it("attributes tokens to the model that answered, not to the first one asked", async () => {
    const usage = newUsage();
    const client = fakeClient([
      () => ({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9000, completion_tokens: 1500 },
      }),
      () => ({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 400, completion_tokens: 60 },
      }),
    ]);
    const call = (model: string) =>
      callJsonSchema(client, usage, { model, system: "s", user: "u", schema: SCANNER_SCHEMA });

    await call("gpt-5-mini");
    await call("gpt-4o-mini");

    expect(usage.byModel).toEqual({
      "gpt-5-mini": { inputTokens: 9000, outputTokens: 1500, requests: 1 },
      "gpt-4o-mini": { inputTokens: 400, outputTokens: 60, requests: 1 },
    });
    // The buckets sum to the totals, always - the whole point of writing both
    // in one place. cost-telemetry relies on this to price a job.
    expect(usage.inputTokens).toBe(9400);
    expect(usage.outputTokens).toBe(1560);
    expect(usage.requests).toBe(2);
  });

  it("charges a truncated response to the model that produced it", async () => {
    // max_completion_tokens is a cap, not a reservation, and a completion that
    // dies at the cap is billed in full. Dropping it would under-report exactly
    // the calls that cost the most.
    const usage = newUsage();
    const client = fakeClient([
      () => ({
        choices: [{ message: { content: null }, finish_reason: "length" }],
        usage: { prompt_tokens: 9300, completion_tokens: 6000 },
      }),
    ]);
    const r = await callJsonSchema(client, usage, {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      maxOutputTokens: 6000,
    });
    expect(r.ok).toBe(false);
    expect(usage.byModel["gpt-5.6-luna"]).toEqual({
      inputTokens: 9300,
      outputTokens: 6000,
      requests: 1,
    });
  });

  it("records a thrown attempt as a request with no tokens, against the model that failed", async () => {
    // The SDK throws before any usage object exists. The provider may have
    // billed tokens anyway; we cannot see them, and a made-up figure would be
    // worse than a known-low one. The REQUEST is still attributed, which is how
    // "18 requests where earlier jobs made 8" stays legible per model.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const usage = newUsage();
    const client = fakeClient([
      () => {
        throw Object.assign(new Error("down"), { status: 500 });
      },
    ]);
    await callJsonSchema(client, usage, {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });
    vi.restoreAllMocks();

    expect(usage.byModel["gpt-5.6-luna"]).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      requests: 3,
    });
    expect(usage.requests).toBe(3);
  });
});

/**
 * WHICH failures are worth trying again, and how hard.
 *
 * Job cmscht6rp001xq41s5rhjx6q0 conceded the critic AND the finalizer to the
 * fallback model after two attempts each. Two is not "the model is down", it is
 * one bad minute - and the SDK underneath is itself retrying (openai@4.104.0
 * defaults maxRetries to 2), so the shape of the fix is not "retry at all", it
 * is "spend the effort where it can pay, and none at all where it cannot".
 *
 * The delay POLICY is asserted directly against nextRetryDelayMs rather than by
 * timing callJsonSchema: through the loop the suite must pass retryDelayMs: 1,
 * and at that base a honoured Retry-After and a computed backoff are
 * milliseconds apart. Timing tests would be measuring the scheduler.
 */
describe("retry classification", () => {
  afterEach(() => vi.restoreAllMocks());

  const apiError = (status: number, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`http ${status}`), { status, ...extra });

  it("treats a request-shaped failure as hopeless and a provider-shaped one as retryable", () => {
    for (const status of [400, 401, 403, 404, 405, 413, 422]) {
      expect(isRetryableFailure(apiError(status))).toBe(false);
    }
    for (const status of [408, 409, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableFailure(apiError(status))).toBe(true);
    }
  });

  it("retries a failure that carries no status at all", () => {
    // APIConnectionError / APIConnectionTimeoutError - status undefined - are
    // the exact population retrying exists for.
    expect(isRetryableFailure(new Error("Connection error."))).toBe(true);
    expect(isRetryableFailure("just a string")).toBe(true);
    expect(isRetryableFailure(undefined)).toBe(true);
  });

  it("reads a stringified status, and one hidden on the response", () => {
    expect(isRetryableFailure({ status: "429" })).toBe(true);
    expect(isRetryableFailure({ status: "404" })).toBe(false);
    expect(isRetryableFailure({ response: { status: 503 } })).toBe(true);
  });

  it("fails a non-retryable status immediately, with no retry and no sleep", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient([
      () => {
        throw apiError(400, { code: "invalid_request_error" });
      },
    ]);
    // A base big enough that ONE sleep would dominate the assertion below. The
    // test stays fast precisely because the sleep must not happen.
    const started = Date.now();
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 5000,
    });

    expect(r.ok).toBe(false);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
    // Never a "retrying" line: an operator must be able to tell a hopeless
    // request from an outage we fought.
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("not retryable");
    expect(error.mock.calls[0][0]).toContain("status=400");
  });

  it("retries a retryable status up to the bound, then concedes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient([
      () => {
        throw apiError(429);
      },
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("error");
    // The bound, stated once: three attempts here, each of which is itself up
    // to three HTTP requests inside the SDK.
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(error.mock.calls[0][0]).toContain("attempt=3/3");
    // The fallback still happens. Conceding is the point of the bound existing.
    expect(error.mock.calls[0][0]).toContain("giving up");
  });

  it("returns normally when a later attempt succeeds, and logs no give-up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let call = 0;
    const client = fakeClient([
      () => {
        call += 1;
        if (call <= 2) throw apiError(503);
        return okResponse({ candidates: [] });
      },
    ]);
    const r = await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });

    // The third attempt is the one the old two-attempt bound never made. This
    // is the whole behaviour change, in one assertion.
    expect(r).toEqual({ ok: true, data: { candidates: [] } });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the suite fast under retryDelayMs: 1, Retry-After included", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A server asking for ten minutes. Honoured in production, clamped to the
    // ceiling - which is a MULTIPLE of the base, so under the hook it is 4ms.
    const client = fakeClient([
      () => {
        throw apiError(429, { headers: { "retry-after": "600" } });
      },
    ]);
    const started = Date.now();
    await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });
    const elapsed = Date.now() - started;

    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
    // Two sleeps of at most 4ms each; 500ms is pure scheduler headroom.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("retry backoff", () => {
  const err = (headers?: Record<string, string>) =>
    Object.assign(new Error("boom"), { status: 429, ...(headers ? { headers } : {}) });

  it("honours Retry-After over the computed backoff", () => {
    // Backoff for attempt 1 at base 2000 is 1500-2000ms. The server said 3s, so
    // 3s it is - it knows when its rate window reopens and we do not.
    expect(nextRetryDelayMs(1, err({ "retry-after": "3" }), 2000)).toBe(3000);
    // Milliseconds header preferred where present, as the SDK prefers it.
    expect(nextRetryDelayMs(1, err({ "retry-after-ms": "2500" }), 2000)).toBe(2500);
  });

  it("clamps a Retry-After that would park a waiting user", () => {
    // Ceiling is 4x the base. Ten minutes becomes eight seconds.
    expect(nextRetryDelayMs(1, err({ "retry-after": "600" }), 2000)).toBe(8000);
  });

  it("ignores an unusable Retry-After and falls back to the backoff", () => {
    const garbage = nextRetryDelayMs(1, err({ "retry-after": "soon" }), 2000);
    expect(garbage).toBeGreaterThanOrEqual(1500);
    expect(garbage).toBeLessThanOrEqual(2000);
  });

  it("grows between attempts and carries jitter", () => {
    const first = Array.from({ length: 40 }, () => nextRetryDelayMs(1, err(), 2000));
    const second = Array.from({ length: 40 }, () => nextRetryDelayMs(2, err(), 2000));

    // Jitter: 40 draws of a deterministic function would all be identical.
    expect(new Set(first).size).toBeGreaterThan(1);
    expect(new Set(second).size).toBeGreaterThan(1);

    // Bounded: 75-100% of the computed value, never above it and never zero.
    expect(Math.min(...first)).toBeGreaterThanOrEqual(1500);
    expect(Math.max(...first)).toBeLessThanOrEqual(2000);
    expect(Math.min(...second)).toBeGreaterThanOrEqual(3000);
    expect(Math.max(...second)).toBeLessThanOrEqual(4000);

    // Growth that the jitter can never undo: the slowest first sleep is still
    // shorter than the fastest second one.
    expect(Math.max(...first)).toBeLessThan(Math.min(...second));
  });

  it("scales the whole policy off the base, which is what makes the test hook work", () => {
    // Every sleep the loop can take at base 1, summed: still under 10ms.
    const worst = nextRetryDelayMs(1, err({ "retry-after": "600" }), 1) +
      nextRetryDelayMs(2, err({ "retry-after": "600" }), 1);
    expect(worst).toBeLessThanOrEqual(8);
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
