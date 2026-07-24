import { describe, expect, it } from "vitest";
import { requestKey, createReplayClient } from "./helpers/replay-client";
import { callJsonSchema, newUsage } from "../analyze-v2/llm";
import { SCANNER_SCHEMA } from "../analyze-v2/schemas";

describe("requestKey", () => {
  it("is stable for the same model/system/user and differs otherwise", () => {
    const a = requestKey({ model: "m", system: "s", user: "u" });
    expect(requestKey({ model: "m", system: "s", user: "u" })).toBe(a);
    expect(requestKey({ model: "m", system: "s", user: "u2" })).not.toBe(a);
    expect(requestKey({ model: "m2", system: "s", user: "u" })).not.toBe(a);
  });
});

describe("createReplayClient", () => {
  const key = requestKey({ model: "m", system: "s", user: "u" });
  const call = (client: ReturnType<typeof createReplayClient>) =>
    (client as unknown as {
      chat: { completions: { create: (b: unknown) => Promise<unknown> } };
    }).chat.completions.create({
      model: "m",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
    });

  it("returns the recorded response regardless of call order", async () => {
    const client = createReplayClient({ [key]: '{"hello":1}' });
    const res = (await call(client)) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(JSON.parse(res.choices[0].message.content)).toEqual({ hello: 1 });
    expect(res.choices[0].finish_reason).toBe("stop");
  });

  it("throws a diagnosable error on an unrecorded request", async () => {
    const client = createReplayClient({});
    await expect(call(client)).rejects.toThrow(/unrecorded request/i);
  });

  it("records every request it served", async () => {
    const client = createReplayClient({ [key]: "{}" });
    await call(client);
    expect(client.served).toEqual([key]);
  });
});

/** Driven through the real callJsonSchema, not the stub's shape: the critic
 *  branches on these kinds (split on truncated, retry on refusal), so replaying
 *  a recorded run has to reproduce them, not just look plausible. */
describe("createReplayClient outcome markers", () => {
  const replay = (recorded: string) => {
    const key = requestKey({ model: "gpt-5.1", system: "s", user: "u" });
    const client = createReplayClient({ [key]: recorded });
    return callJsonSchema(client, newUsage(), {
      model: "gpt-5.1",
      system: "s",
      user: "u",
      schema: SCANNER_SCHEMA,
      retryDelayMs: 1,
    });
  };

  it("replays a recorded truncated outcome as kind truncated", async () => {
    expect(await replay(JSON.stringify({ __outcome: "truncated" }))).toEqual({
      ok: false,
      kind: "truncated",
    });
  });

  it("replays a recorded refusal outcome as kind refusal", async () => {
    expect(await replay(JSON.stringify({ __outcome: "refusal" }))).toEqual({
      ok: false,
      kind: "refusal",
    });
  });

  it("still replays a normal recorded response as content", async () => {
    expect(await replay(JSON.stringify({ candidates: [] }))).toEqual({
      ok: true,
      data: { candidates: [] },
    });
  });
});
