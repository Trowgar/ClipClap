import type OpenAI from "openai";
import type { LlmUsage, ModelUsage } from "./types";

export type SchemaCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "truncated" | "refusal" | "error"; error?: string };

export interface SchemaCallOptions {
  model: string;
  system: string;
  user: string;
  schema: { name: string; strict: boolean; schema: unknown };
  temperature?: number;
  maxOutputTokens?: number;
  /** Only sent to gpt-5* models. */
  reasoningEffort?: string;
  retryDelayMs?: number;
}

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
 */
function logCallFailure(
  model: string,
  attempt: number,
  attempts: number,
  outcome: "retrying" | "giving up",
  detail: string
): void {
  const line =
    `[analyze-v2] llm call failed: model=${model} attempt=${attempt}/${attempts} ` +
    `${detail} - ${outcome}`;
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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.chat.completions.create(
        body as Parameters<typeof client.chat.completions.create>[0] & {
          reasoning_effort?: string;
        }
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
        logCallFailure(opts.model, attempt + 1, 2, "giving up", noApiDetail("no choices"));
        return { ok: false, kind: "error", error: "no choices" };
      }
      if (choice.message.refusal) return { ok: false, kind: "refusal" };
      if (choice.finish_reason === "length") return { ok: false, kind: "truncated" };
      const content = choice.message.content;
      if (!content) {
        logCallFailure(opts.model, attempt + 1, 2, "giving up", noApiDetail("empty content"));
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
      if (attempt === 0) {
        logCallFailure(opts.model, 1, 2, "retrying", detail);
        await sleep(opts.retryDelayMs ?? 2000);
        continue;
      }
      logCallFailure(opts.model, 2, 2, "giving up", detail);
      return {
        ok: false,
        kind: "error",
        error: error instanceof Error ? error.message : String(error),
      };
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
