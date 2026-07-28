import { describe, it, expect } from "vitest";
import { sourceArtifactKey, normalizedArtifactKey } from "../stages/artifact-keys";

describe("artifact keys", () => {
  it("is stable across retries of the same job", () => {
    expect(sourceArtifactKey("u1", "job1")).toBe("work/u1/job1/source.mp4");
    expect(sourceArtifactKey("u1", "job1")).toBe(sourceArtifactKey("u1", "job1"));
  });

  it("separates the normalized file from the raw one", () => {
    expect(normalizedArtifactKey("u1", "job1")).toBe("work/u1/job1/normalized.mp4");
    expect(normalizedArtifactKey("u1", "job1")).not.toBe(sourceArtifactKey("u1", "job1"));
  });

  it("keeps both under the job's own prefix", () => {
    for (const key of [sourceArtifactKey("u9", "j9"), normalizedArtifactKey("u9", "j9")]) {
      expect(key.startsWith("work/u9/j9/")).toBe(true);
    }
  });
});
