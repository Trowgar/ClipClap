import type OpenAI from "openai";
import type { LlmUsage } from "./types";

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
  return { inputTokens: 0, outputTokens: 0, requests: 0 };
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
      usage.requests += 1;
      usage.inputTokens += completion.usage?.prompt_tokens ?? 0;
      usage.outputTokens += completion.usage?.completion_tokens ?? 0;

      const choice = completion.choices[0];
      if (!choice) return { ok: false, kind: "error", error: "no choices" };
      if (choice.message.refusal) return { ok: false, kind: "refusal" };
      if (choice.finish_reason === "length") return { ok: false, kind: "truncated" };
      const content = choice.message.content;
      if (!content) return { ok: false, kind: "error", error: "empty content" };
      try {
        return { ok: true, data: JSON.parse(content) as T };
      } catch {
        // strict schema makes this near-impossible; treat as truncation-like
        return { ok: false, kind: "truncated" };
      }
    } catch (error) {
      usage.requests += 1;
      if (attempt === 0) {
        await sleep(opts.retryDelayMs ?? 2000);
        continue;
      }
      return {
        ok: false,
        kind: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: false, kind: "error", error: "unreachable" };
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
