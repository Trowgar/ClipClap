import { describe, expect, it } from "vitest";
import { resolveEngine, jobBucket } from "../analyze-v2/dispatch";

describe("jobBucket", () => {
  it("is deterministic and uniform-ish over 0..99", () => {
    expect(jobBucket("job-abc")).toBe(jobBucket("job-abc"));
    const buckets = new Set(
      Array.from({ length: 200 }, (_, i) => jobBucket(`job-${i}`))
    );
    expect(buckets.size).toBeGreaterThan(50);
    for (const b of buckets) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});

describe("resolveEngine", () => {
  it("honors explicit engine settings", () => {
    expect(resolveEngine("j1", { engine: "recall-critic", v2Pct: 0 })).toBe("recall-critic");
    expect(resolveEngine("j1", { engine: "shadow", v2Pct: 0 })).toBe("shadow");
  });
  it("buckets legacy jobs by pct", () => {
    expect(resolveEngine("j1", { engine: "legacy", v2Pct: 0 })).toBe("legacy");
    expect(resolveEngine("j1", { engine: "legacy", v2Pct: 100 })).toBe("recall-critic");
  });
});
