import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  getRedis: vi.fn(() => ({ host: "redis" })),
  download: vi.fn(),
  transcribe: vi.fn(),
  analyze: vi.fn(),
  render: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Worker: mocks.Worker,
}));

vi.mock("@clipfast/shared", () => ({
  getRedis: mocks.getRedis,
  getQueueNameForStage: (role: string) => `video-${role}`,
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
});
