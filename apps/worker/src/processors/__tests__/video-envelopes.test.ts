import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

import { bucketVideoEnvelopesBySecond, videoEnvelopes, videoEnvelopesFromFd } from "../video-envelopes";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isolated video envelope parser", () => {
  it("is importable without constructing the transcription OpenAI client", () => {
    expect(bucketVideoEnvelopesBySecond([
      "frame:0 pts_time:0",
      "lavfi.signalstats.YAVG=10",
      "lavfi.signalstats.YDIF=1",
    ].join("\n"))).toEqual({ lumaEnvelope: [10], motionEnvelope: [1] });
  });

  it("rejects an extreme timestamp without an unbounded fill", () => {
    expect(bucketVideoEnvelopesBySecond([
      "frame:0 pts_time:999999999999",
      "lavfi.signalstats.YAVG=10",
      "lavfi.signalstats.YDIF=1",
    ].join("\n"))).toEqual({ lumaEnvelope: [], motionEnvelope: [] });
  });

  it("places a local-only protocol whitelist before the path input", async () => {
    mocks.execFile.mockImplementation((_command, _args, optionsOrCallback, maybeCallback) => {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      callback(null, { stderr: "frame:0 pts_time:0\nlavfi.signalstats.YAVG=10\nlavfi.signalstats.YDIF=1" });
    });

    await videoEnvelopes("/tmp/source.mp4");

    const args = mocks.execFile.mock.calls[0][1] as string[];
    const whitelistIndex = args.indexOf("-protocol_whitelist");
    const inputIndex = args.indexOf("-i");
    expect(args[whitelistIndex + 1]).toBe("file,pipe");
    expect(whitelistIndex).toBeGreaterThanOrEqual(0);
    expect(whitelistIndex).toBeLessThan(inputIndex);
    expect(args).not.toContain("http");
    expect(args).not.toContain("https");
    expect(args).not.toContain("concat");
  });

  it("uses the same local-only whitelist before the inherited-fd input", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    mocks.spawn.mockImplementation((_command, _args) => ({
      stderr: { on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        if (event === "data") queueMicrotask(() => listener("frame:0 pts_time:0\nlavfi.signalstats.YAVG=10\nlavfi.signalstats.YDIF=1"));
      } },
      once: (event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        if (event === "close") queueMicrotask(() => listener(0));
      },
      kill: vi.fn(),
    }));

    await videoEnvelopesFromFd(73);

    const args = mocks.spawn.mock.calls[0][1] as string[];
    const whitelistIndex = args.indexOf("-protocol_whitelist");
    const inputIndex = args.indexOf("-i");
    expect(args[whitelistIndex + 1]).toBe("file,pipe");
    expect(whitelistIndex).toBeGreaterThanOrEqual(0);
    expect(whitelistIndex).toBeLessThan(inputIndex);
    expect(args[inputIndex + 1]).toBe("/proc/self/fd/3");
    expect(args).not.toContain("http");
    expect(args).not.toContain("https");
    expect(args).not.toContain("concat");
  });
});
