import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Queue: vi.fn(),
  getJobs: vi.fn(),
}));

vi.mock("bullmq", () => ({ Queue: mocks.Queue }));
vi.mock("../redis", () => ({ getRedis: () => ({ host: "redis" }) }));

import {
  QUEUE_NAMES,
  getQueueNameForStage,
  parseWorkerRole,
  removeQueuedPipelineJobs,
} from "../queues";

describe("stage queue helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.Queue.mockImplementation((name: string) => ({
      getJobs: (states: string[]) => mocks.getJobs(name, states),
    }));
  });

  it("maps each pipeline stage to its own queue name", () => {
    expect(QUEUE_NAMES.download).toBe("video-download");
    expect(QUEUE_NAMES.transcribe).toBe("video-transcribe");
    expect(QUEUE_NAMES.analyze).toBe("video-analyze");
    expect(QUEUE_NAMES.render).toBe("video-render");
    expect(QUEUE_NAMES.finalize).toBe("video-finalize");
  });

  it("parses known worker roles and rejects unknown roles", () => {
    expect(parseWorkerRole("download")).toBe("download");
    expect(parseWorkerRole("render")).toBe("render");
    expect(() => parseWorkerRole("all")).toThrow(/unknown worker role/i);
  });

  it("returns queue name for stage", () => {
    expect(getQueueNameForStage("analyze")).toBe("video-analyze");
  });

  it("removes only this pipeline job from every removable queue state", async () => {
    const removeMatching = vi.fn(async () => undefined);
    const removeOther = vi.fn(async () => undefined);
    mocks.getJobs.mockImplementation(async (queueName: string, states: string[]) => {
      expect(states).toEqual(["waiting", "delayed", "prioritized", "paused"]);
      return queueName === "video-transcribe"
        ? [
            { id: "373", data: { jobId: "deleted-job" }, remove: removeMatching },
            { id: "374", data: { jobId: "other-job" }, remove: removeOther },
          ]
        : [];
    });

    await expect(removeQueuedPipelineJobs("deleted-job")).resolves.toBe(1);
    expect(removeMatching).toHaveBeenCalledOnce();
    expect(removeOther).not.toHaveBeenCalled();
    expect(mocks.getJobs).toHaveBeenCalledTimes(5);
  });

  it("continues cleaning other queues when a scan or remove races with a worker", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const removed = vi.fn(async () => undefined);
    mocks.getJobs.mockImplementation(async (queueName: string) => {
      if (queueName === "video-download") throw new Error("redis unavailable");
      if (queueName === "video-transcribe") {
        return [{
          id: "locked",
          data: { jobId: "deleted-job" },
          remove: vi.fn(async () => { throw new Error("locked by worker"); }),
        }];
      }
      if (queueName === "video-analyze") {
        return [{ id: "free", data: { jobId: "deleted-job" }, remove: removed }];
      }
      return [];
    });

    await expect(removeQueuedPipelineJobs("deleted-job")).resolves.toBe(1);
    expect(removed).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
