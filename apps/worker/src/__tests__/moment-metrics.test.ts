import { expect, it } from "vitest";
import { measureMomentQuality } from "../evaluation/moment-metrics";

it("counts missing setup/payoff as misses, deduplicates recall, and keeps unknown precision unknown", () => {
  const result = measureMomentQuality([
    { start: 10, end: 18 }, { start: 30, end: 45 }, { start: 30, end: 45 },
  ], [
    { id: "a", start: 10, end: 20, payoffAt: 19 },
    { id: "b", start: 30, end: 45, payoffAt: 40 },
  ], [{ index: 1, verdict: "publishable", momentId: "b", startOk: true, endOk: true, contextOk: true }]);
  expect(result).toMatchObject({ moments: 2, found: 1, missed: ["a"], recall: 0.5, publishableClips: 1, unknownClips: 2 });
  expect(result.top3).toMatchObject({ precision: null, lowerBound: 1 / 3, upperBound: 1, fixedKYield: null, fixedKYieldLowerBound: 1 / 3 });
});

it("includes empty sources and refuses invalid labels or duplicate reviews", () => {
  expect(measureMomentQuality([], [{ id: "a", start: 10, end: 20 }], [])).toMatchObject({ found: 0, recall: 0, empty: true, publishableClips: 0, top3: { fixedKYield: 0 } });
  expect(() => measureMomentQuality([], [{ id: "a", start: 20, end: 10 }], [])).toThrow();
  expect(() => measureMomentQuality([{ start: 0, end: 10 }], [], [{ index: 0, verdict: "boring" }, { index: 0, verdict: "publishable" }])).toThrow();
});


it("requires a moment identity and counts repeated publishable cuts once", () => {
  const clips = Array.from({ length: 3 }, () => ({ start: 10, end: 20 }));
  expect(() => measureMomentQuality(clips, [], [{ index: 0, verdict: "publishable" }])).toThrow("moment ID");
  const reviews = clips.map((_, index) => ({ index, verdict: "publishable" as const, momentId: "one-moment" }));
  expect(measureMomentQuality(clips, [], reviews)).toMatchObject({ publishableClips: 1, top3: { precision: 1, fixedKYield: 1 / 3 } });
});
