import { describe, expect, it } from "vitest";
import {
  QUEUE_NAMES,
  getQueueNameForStage,
  parseWorkerRole,
} from "../queues";

describe("stage queue helpers", () => {
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
});
