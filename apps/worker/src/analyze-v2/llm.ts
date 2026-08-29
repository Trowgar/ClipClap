import type OpenAI from "openai";
import type { LlmUsage, ModelUsage } from "./types";

export type SchemaCallResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: "truncated" | "refusal" | "error";
      error?: string;
      /** Closed transport code where the SDK exposed one (for callers that
       * need to distinguish an errno without altering its human message). */
      errorCode?: string;
    };

export interface SchemaCallOptions {
  model: string;
  system: string;
  user: string;
  schema: { name: string; strict: boolean; schema: unknown };
  temperature?: number;
  maxOutputTokens?: number;
  /** Only sent to gpt-5* models. */
  reasoningEffort?: string;
  /**
   * BASE of the retry backoff, not a flat delay - the first retry waits about
   * this long, the second about twice it, and every sleep is capped at
   * RETRY_DELAY_CEILING_MULTIPLE times it. Defaults to DEFAULT_RETRY_BASE_MS.
   *
   * Still the test hook it has always been, and still honoured the same way:
   * because the ceiling is a multiple of the base rather than a constant, a
   * suite passing `1` bounds the whole retry sequence - including a
   * server-supplied `Retry-After` - to a handful of milliseconds.
   */
  retryDelayMs?: number;
  /** Make exactly one SDK request: no outer retry and `maxRetries: 0` on the
   * OpenAI request. Used by observation-only callers that must fail open
   * without adding user-facing latency. */
  noRetry?: boolean;
}

/**
 * Attempts callJsonSchema makes AT THIS LAYER, per call.
 *
 * It is not the number of HTTP requests. The client is built as
 * `new OpenAI({ apiKey })` (analyze-v2/index.ts) with no `maxRetries`, and the
 * SDK's default is 2 (openai@4.104.0, core.js: `constructor({ maxRetries = 2 })`).
 * The SDK retries 408, 409, 429 and every 5xx, plus connection and timeout
 * errors, on its own 0.5s/1s backoff. So one attempt here is up to THREE HTTP
 * requests, and this bound of 3 buys up to NINE - about eleven seconds of
 * backoff between the first request and the concession.
 *
 * Why 3 and not more. The user is waiting: the job this exists for
 * (cmscht6rp001xq41s5rhjx6q0) spent 62s in ANALYZE, and the critic's batches run
 * concurrently while the finalizer runs after them, so a stage that exhausts the
 * bound costs the job that wall clock twice over. A fourth attempt would add
 * another 8s sleep for a request the previous nine already argue is not coming
 * back - and on that job it would have bought nothing, because the primary model
 * failed 10 times out of 10 across the job's whole 62-second span while the
 * fallback succeeded 5 times out of 5. Nothing bounded by tens of seconds
 * rescues a failure that shaped. Three attempts is the point where more effort
 * stops buying a different answer and starts only delaying the fallback.
 */
const MAX_ATTEMPTS = 3;

/** First retry's sleep, and the unit every later one is a multiple of. Matches
 *  the flat 2000ms this file used before there was a backoff at all. */
const DEFAULT_RETRY_BASE_MS = 2000;

/**
 * Hard ceiling on ONE sleep, as a multiple of the base - 8s in production.
 *
 * With MAX_ATTEMPTS at 3 the computed backoff (base, then 2x base) never reaches
 * it; the ceiling exists for `Retry-After`, which the server controls and could
 * name as ten minutes. Expressing it as a multiple of the base rather than a
 * constant is what keeps `retryDelayMs: 1` fast: under the test hook the ceiling
 * is 4ms, so a fixture that hands back `Retry-After: 600` still sleeps 4ms.
 */
const RETRY_DELAY_CEILING_MULTIPLE = 4;

export function newUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, requests: 0, byModel: {} };
}

/**
 * The ONE place usage is written. Totals and the per-model bucket move together,
 * so "the buckets sum to the totals" cannot drift into being false - which is
 * what makes the breakdown safe to price a job from (cost-telemetry.ts).
 */
function recordUsage(
  usage: LlmUsage,
  model: string,
  inputTokens: number,
  outputTokens: number
): void {
  usage.requests += 1;
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  // Defensive: usage objects cross a JSON boundary (JobStep.outputJson) and a
  // replayed/legacy one may arrive without the map.
  if (!usage.byModel) usage.byModel = {};
  const bucket: ModelUsage = (usage.byModel[model] ??= {
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
  });
  bucket.requests += 1;
  bucket.inputTokens += inputTokens;
  bucket.outputTokens += outputTokens;
}

/** Whatever the OpenAI SDK exposes about a failure, or "-" where it exposes
 *  nothing. The catch also sees plain Errors, aborts and TypeErrors, so every
 *  field is read defensively and nothing here may throw. */
function errorFacts(error: unknown): {
  status: string;
  code: string;
  type: string;
  message: string;
} {
  const e = (typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  // APIError puts status/code/type on the error; the raw response body repeats
  // code/type one level down, and only one of the two is populated per SDK
  // version, so both are read.
  const body = (typeof e.error === "object" && e.error !== null
    ? (e.error as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const scalar = (...values: unknown[]): string => {
    for (const v of values) {
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
    return "-";
  };
  const raw = error instanceof Error ? error.message : String(error);
  return {
    status: scalar(e.status, (e.response as Record<string, unknown> | undefined)?.status),
    code: scalar(e.code, body.code),
    type: scalar(e.type, body.type),
    // One line, bounded: this runs per call and a stack-shaped message would
    // bury the fields above.
    message: raw.replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

/** The HTTP status a failure carries, as a number, or undefined when it carries
 *  none. Same defensive reading as errorFacts and for the same reason - the
 *  catch sees APIErrors, APIConnectionErrors, TypeErrors and bare strings - but
 *  a number, because the retry decision is arithmetic and "404" is not 404. */
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as Record<string, unknown>;
  const response =
    typeof e.response === "object" && e.response !== null
      ? (e.response as Record<string, unknown>)
      : undefined;
  for (const raw of [e.status, response?.status]) {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Whether trying the SAME request again could plausibly produce a different
 * answer. The whole point of the split: retrying a 400 spends a user's wall
 * clock on a request whose outcome is already decided, while conceding a 429
 * after two attempts hands a paying user's clips to a model nobody selected.
 *
 * Retryable: 408 and 409 (the SDK's own list - request timeout, lock timeout),
 * 429 (rate limit) and every 5xx (the provider, not us).
 *
 * NOT retryable: every other 4xx. A 400, 401, 403, 404 or 422 is a statement
 * about the request or the credentials - a malformed body, a revoked key, a
 * model this account cannot reach - and none of those heal in six seconds.
 *
 * An error with NO status is retryable, deliberately. That population is
 * dominated by exactly what retrying is for: APIConnectionError and
 * APIConnectionTimeoutError, which the SDK raises with `status: undefined` when
 * the socket died or the 10-minute request timeout fired. It also catches the
 * odd TypeError from a defect in this file, which will then be attempted three
 * times - cheap, bounded, and logged three times, which is if anything the
 * faster way to notice it.
 */
export function isRetryableFailure(error: unknown): boolean {
  const status = httpStatus(error);
  if (status === undefined) return true;
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

/** `Retry-After` / `retry-after-ms` off the failing response, in milliseconds,
 *  or undefined when the response said nothing usable. Never throws: `headers`
 *  is a Proxy in the SDK, a plain object in tests and absent on a connection
 *  error, and a retry path that dies reading a header is worse than one that
 *  ignores it. */
function retryAfterMs(error: unknown): number | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const headers = (error as Record<string, unknown>).headers;
    if (typeof headers !== "object" || headers === null) return undefined;
    const bag = headers as Record<string, unknown> & {
      get?: (name: string) => unknown;
    };
    const read = (name: string): string | undefined => {
      const value =
        typeof bag.get === "function" ? bag.get(name) : bag[name] ?? bag[name.toUpperCase()];
      if (typeof value === "string") return value;
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      return undefined;
    };

    // Non-standard but preferred where present, exactly as the SDK prefers it:
    // milliseconds need no unit guess.
    const ms = read("retry-after-ms");
    if (ms !== undefined) {
      const parsed = Number.parseFloat(ms);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }

    const after = read("retry-after");
    if (after === undefined) return undefined;
    // RFC 9110 allows either delta-seconds or an HTTP-date.
    const seconds = Number.parseFloat(after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const until = Date.parse(after) - Date.now();
    if (Number.isFinite(until) && until >= 0) return until;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long to wait before attempt `attempt + 1`, in milliseconds.
 *
 * Exported because it is the retry POLICY and deserves to be asserted directly:
 * driving it through callJsonSchema would mean either a slow suite or a base so
 * small that "honoured Retry-After" and "computed backoff" are milliseconds
 * apart and indistinguishable.
 *
 *  - `Retry-After` wins outright when the response carried one. The server knows
 *    when its rate window reopens and we do not. Un-jittered, like the SDK: it
 *    is an instruction with a number in it, and the only herd that could
 *    synchronise on it is the critic's handful of concurrent batches.
 *  - Otherwise base * 2^(attempt-1), so 2s then 4s in production.
 *  - Jitter is the SDK's shape - 75-100% of the computed value - which spreads
 *    concurrent batches without ever letting a later attempt's sleep fall below
 *    an earlier one's.
 *  - Everything is clamped to the ceiling, which is what stops a server-named
 *    delay from parking a waiting user for ten minutes.
 */
export function nextRetryDelayMs(
  attempt: number,
  error: unknown,
  baseMs: number
): number {
  const ceiling = baseMs * RETRY_DELAY_CEILING_MULTIPLE;
  const asked = retryAfterMs(error);
  if (asked !== undefined) return Math.min(asked, ceiling);
  const backoff = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), ceiling);
  return backoff * (1 - Math.random() * 0.25);
}

/**
 * Every failed attempt, at the point of failure.
 *
 * Nothing downstream logs the `error` string callJsonSchema returns - critic.ts
 * counts a kind and moves on - so before this existed the most quality-critical
 * stage in the product ran blind: worker-analyze had written 245 log lines in its
 * life, all tsx banners, while job cmscht6rp001xq41s5rhjx6q0 silently re-judged
 * every batch on the fallback model. A retry and a give-up are logged with
 * different words and different levels on purpose: a transient blip that the
 * retry absorbed must be distinguishable from a hard failure that reached the
 * caller, and the second one is the one that changes which model judged the job.
 *
 * Three outcomes, not two, since the classification exists: "we gave up after
 * nine HTTP requests and eleven seconds" and "we gave up instantly because the
 * API said 404" are the same `{ok:false}` to every caller and the same fallback
 * downstream, but they are opposite findings for whoever reads the log. The
 * first is an outage; the second is a broken request, a dead key or a model this
 * account cannot reach, and no amount of retrying was ever going to help. Both
 * still say "giving up", so one grep still finds every hard failure.
 */
function logCallFailure(
  model: string,
  attempt: number,
  attempts: number,
  outcome: "retrying" | "giving up" | "not retryable",
  detail: string
): void {
  const verdict =
    outcome === "not retryable" ? "not retryable - giving up without retrying" : outcome;
  const line =
    `[analyze-v2] llm call failed: model=${model} attempt=${attempt}/${attempts} ` +
    `${detail} - ${verdict}`;
  if (outcome === "retrying") console.warn(line);
  else console.error(line);
}

/** Detail line for a failure the API reported as a SUCCESS - there is no status,
 *  code or type to quote, and the dashes say so rather than omitting the fields
 *  and making the two kinds of line unparseable together. */
function noApiDetail(message: string): string {
  return `status=- code=- type=- message=${JSON.stringify(message)}`;
}

export async function callJsonSchema<T>(
  client: OpenAI,
  usage: LlmUsage,
  opts: SchemaCallOptions
): Promise<SchemaCallResult<T>> {
  const body = {
    model: opts.model,
    messages: [
      { role: "system" as const, content: opts.system },
      { role: "user" as const, content: opts.user },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: opts.schema as never,
    },
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxOutputTokens !== undefined
      ? { max_completion_tokens: opts.maxOutputTokens }
      : {}),
    ...(opts.reasoningEffort && opts.model.startsWith("gpt-5")
      ? { reasoning_effort: opts.reasoningEffort }
      : {}),
  };

  const maxAttempts = opts.noRetry ? 1 : MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.chat.completions.create(
        body as Parameters<typeof client.chat.completions.create>[0] & {
          reasoning_effort?: string;
        },
        ...(opts.noRetry ? ([{ maxRetries: 0 }] as const) : [])
      );
      const completion = response as OpenAI.Chat.Completions.ChatCompletion;
      // Attributed to the model this request NAMED, which on a fallback call is
      // not the configured one. Truncated and refused completions are billed in
      // full and are recorded here too - the early returns below are after this.
      recordUsage(
        usage,
        opts.model,
        completion.usage?.prompt_tokens ?? 0,
        completion.usage?.completion_tokens ?? 0
      );

      const choice = completion.choices[0];
      if (!choice) {
        // Same class as a thrown API error - it degrades the batch to the
        // fallback model - and just as invisible until it is logged.
        logCallFailure(opts.model, attempt, maxAttempts, "giving up", noApiDetail("no choices"));
        return { ok: false, kind: "error", error: "no choices" };
      }
      if (choice.message.refusal) return { ok: false, kind: "refusal" };
      if (choice.finish_reason === "length") return { ok: false, kind: "truncated" };
      const content = choice.message.content;
      if (!content) {
        logCallFailure(opts.model, attempt, maxAttempts, "giving up", noApiDetail("empty content"));
        return { ok: false, kind: "error", error: "empty content" };
      }
      try {
        return { ok: true, data: JSON.parse(content) as T };
      } catch {
        // strict schema makes this near-impossible; treat as truncation-like
        return { ok: false, kind: "truncated" };
      }
    } catch (error) {
      // A throw carries no usage object, so the attempt costs a request and zero
      // recorded tokens against the model that failed it. The provider may well
      // have billed tokens it generated before dying; we cannot see them, and
      // inventing a figure would be worse than under-reporting one.
      recordUsage(usage, opts.model, 0, 0);
      const facts = errorFacts(error);
      const detail =
        `status=${facts.status} code=${facts.code} type=${facts.type} ` +
        `message=${JSON.stringify(facts.message)}`;
      const give = (
        outcome: "giving up" | "not retryable"
      ): SchemaCallResult<T> => {
        logCallFailure(opts.model, attempt, maxAttempts, outcome, detail);
        return {
          ok: false,
          kind: "error",
          error: error instanceof Error ? error.message : String(error),
          ...(facts.code !== "-" ? { errorCode: facts.code } : {}),
        };
      };

      // Fail fast on a request that cannot succeed. The fallback model is a
      // worse judge but a real one, and reaching it a few seconds sooner is
      // strictly better than sleeping first - the user is waiting.
      if (!isRetryableFailure(error)) return give("not retryable");
      if (attempt === maxAttempts) return give("giving up");

      logCallFailure(opts.model, attempt, maxAttempts, "retrying", detail);
      await sleep(
        nextRetryDelayMs(attempt, error, opts.retryDelayMs ?? DEFAULT_RETRY_BASE_MS)
      );
    }
  }
  return { ok: false, kind: "error", error: "unreachable" };
}

/**
 * The job is now being judged by a model nobody chose. Say so, once per stage,
 * where an operator will actually see it.
 *
 * `fallbackModelUsed: true` already existed - as one boolean among ~thirty fields
 * of a JSON blob on a JobStep row. It was read by a human investigating that very
 * job and missed, which is the whole argument: a degradation that only reports
 * into telemetry is a degradation nobody notices. This is an OPERATIONAL event -
 * the clips shipped to a paying user were judged by the fallback - so it is
 * console.error, it names both models, and it names the stage, because "the
 * critic fell back" and "the finalizer fell back" need different responses.
 *
 * Once per stage, not once per batch: the critic runs four concurrent batches and
 * an outage takes all of them, so per-batch lines would be four copies of the
 * same news. The per-CALL detail (status, code, message, which attempt) is
 * logCallFailure's job and is already on the line above this one.
 */
export function logModelFallback(stage: string, from: string, to: string): void {
  console.error(
    `[analyze-v2] !! FALLBACK MODEL IN USE (${stage}): ${from} failed, continuing on ${to} ` +
      `- this job's ${stage} output was judged by a model nobody selected`
  );
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
