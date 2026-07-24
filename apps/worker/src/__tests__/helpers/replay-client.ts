import { createHash } from "crypto";
import type OpenAI from "openai";

export interface RequestShape {
  model: string;
  system: string;
  user: string;
}

/** Order-independent identity of an LLM request. The scanner runs windows
 *  concurrently, so replay can never rely on call order. A prompt edit changes
 *  the key on purpose: stale recordings must fail loudly, not silently pass. */
export function requestKey(req: RequestShape): string {
  return createHash("sha256")
    .update(`${req.model}\0${req.system}\0${req.user}`)
    .digest("hex")
    .slice(0, 16);
}

export interface ReplayClient {
  served: string[];
  missing: string[];
}

/** Minimal stand-in for the OpenAI client covering exactly what
 *  callJsonSchema uses. Responses are raw JSON strings, as the API returns. */
export function createReplayClient(
  responses: Record<string, string>,
  options: { onMissing?: (key: string, req: RequestShape) => string | undefined } = {}
): OpenAI & ReplayClient {
  const served: string[] = [];
  const missing: string[] = [];
  const create = async (body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }) => {
    const req: RequestShape = {
      model: body.model,
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    };
    const key = requestKey(req);
    const recorded = responses[key] ?? options.onMissing?.(key, req);
    if (recorded === undefined) {
      missing.push(key);
      throw new Error(
        `replay: unrecorded request ${key} (model=${req.model}, user starts "${req.user.slice(0, 60)}")`
      );
    }
    served.push(key);
    return {
      choices: [{ message: { content: recorded, refusal: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
  };
  return {
    served,
    missing,
    chat: { completions: { create } },
  } as unknown as OpenAI & ReplayClient;
}
