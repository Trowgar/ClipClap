import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  getRedis: vi.fn(() => ({ host: "redis" })),
  releaseNextQueued: vi.fn(async () => []),
  download: vi.fn(),
  transcribe: vi.fn(),
  analyze: vi.fn(),
  render: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Worker: mocks.Worker,
}));

vi.mock("@clipclap/shared", () => ({
  getRedis: mocks.getRedis,
  getQueueNameForStage: (role: string) => `video-${role}`,
  releaseNextQueued: mocks.releaseNextQueued,
  parseWorkerRole: (role: string | undefined) => {
    if (
      role === "download" ||
      role === "transcribe" ||
      role === "analyze" ||
      role === "render" ||
      role === "finalize"
    ) {
      return role;
    }
    throw new Error(`Unknown worker role: ${role ?? "(empty)"}`);
  },
}));

vi.mock("../stages/download", () => ({ runDownloadStage: mocks.download }));
vi.mock("../stages/transcribe", () => ({
  runTranscribeStage: mocks.transcribe,
}));
vi.mock("../stages/analyze", () => ({ runAnalyzeStage: mocks.analyze }));
vi.mock("../stages/render", () => ({ runRenderStage: mocks.render }));
vi.mock("../stages/finalize", () => ({ runFinalizeStage: mocks.finalize }));

import { Worker } from "bullmq";
import { createStageWorker, getWorkerConcurrency } from "../worker-app";

describe("worker role config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WORKER_CONCURRENCY;
    delete process.env.RENDER_CONCURRENCY;
    delete process.env.DOWNLOAD_CONCURRENCY;
  });

  it("uses CPU-safe concurrency for render", () => {
    expect(getWorkerConcurrency("render")).toBe(1);
  });

  it("uses higher concurrency for IO and API stages", () => {
    expect(getWorkerConcurrency("download")).toBe(4);
    expect(getWorkerConcurrency("analyze")).toBe(5);
    expect(getWorkerConcurrency("finalize")).toBe(3);
  });

  it("creates a BullMQ worker for the requested stage queue", () => {
    createStageWorker("render");

    expect(Worker).toHaveBeenCalledWith(
      "video-render",
      expect.any(Function),
      expect.objectContaining({
        concurrency: 1,
        lockDuration: 30 * 60 * 1000,
      })
    );
  });

  it("allows per-role concurrency overrides", () => {
    process.env.DOWNLOAD_CONCURRENCY = "8";

    expect(getWorkerConcurrency("download")).toBe(8);
  });

  it("does not release a pipeline slot for an internal quality canary", async () => {
    const worker = createStageWorker("finalize");
    const completed = (worker as unknown as { on: ReturnType<typeof vi.fn> }).on;
    const handler = completed.mock.calls.find((call: unknown[]) => call[0] === "completed")?.[1] as ((job: unknown) => void) | undefined;
    expect(handler).toBeDefined();
    await handler!({ data: { kind: "feedback-quality-canary", nonce: "n", decisionId: "d" } });
    expect(mocks.releaseNextQueued).not.toHaveBeenCalled();
  });
});
