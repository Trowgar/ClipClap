import { describe, expect, it } from "vitest";
import { requestKey, createReplayClient } from "./helpers/replay-client";

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
