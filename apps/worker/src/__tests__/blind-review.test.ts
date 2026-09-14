import { expect, it } from "vitest";
import { buildBlindReviewSet } from "../evaluation/blind-review";

it("deduplicates equivalent clips while sealing version and rank", () => {
  const result = buildBlindReviewSet([
    { sourceId: "source-a", version: "baseline", rank: 0, start: 10, end: 30, title: "old" },
    { sourceId: "source-a", version: "candidate", rank: 0, start: 10.2, end: 30.1, title: "new" },
    { sourceId: "source-a", version: "candidate", rank: 1, start: 40, end: 50, title: "extra" },
  ], "frozen-salt");

  expect(result.review).toHaveLength(3);
  expect(result.review[0]).not.toHaveProperty("sourceId");
  expect(result.review[0]).not.toHaveProperty("version");
  expect(result.review[0]).not.toHaveProperty("rank");
  expect(result.mapping.flatMap(item => item.placements)).toHaveLength(3);
  expect(result.mapping.filter(item => item.placements.some(p => p.rank === 0))).toHaveLength(2);
});

it("deduplicates equivalent clips when their delivered copy is also equal", () => {
  const result = buildBlindReviewSet([
    { sourceId: "source-a", version: "baseline", rank: 0, start: 10, end: 30, title: "same", description: "same" },
    { sourceId: "source-a", version: "candidate", rank: 0, start: 10.2, end: 30.1, title: "same", description: "same" },
  ], "frozen-salt");
  expect(result.review).toHaveLength(1);
  expect(result.mapping[0].placements).toHaveLength(2);
});

it("keeps meaningfully different boundaries as separate review items", () => {
  const result = buildBlindReviewSet([
    { sourceId: "source-a", version: "baseline", rank: 0, start: 10, end: 30 },
    { sourceId: "source-a", version: "candidate", rank: 0, start: 10, end: 27 },
  ], "frozen-salt");
  expect(result.review).toHaveLength(2);
});

it("keeps near-identical intervals separate when the delivered transcript differs", () => {
  const result = buildBlindReviewSet([
    { sourceId: "source-a", version: "baseline", rank: 0, start: 10, end: 30, title: "same", description: "same", transcript: "Question?" },
    { sourceId: "source-a", version: "candidate", rank: 0, start: 10, end: 30.5, title: "same", description: "same", transcript: "Question? No." },
  ], "frozen-salt");
  expect(result.review).toHaveLength(2);
});

it("is independent of input order", () => {
  const rows = [
    { sourceId: "source-a", version: "candidate" as const, rank: 1, start: 10.4, end: 30.2, title: "same" },
    { sourceId: "source-a", version: "baseline" as const, rank: 0, start: 10, end: 30, title: "same" },
    { sourceId: "source-a", version: "candidate" as const, rank: 0, start: 40, end: 50, title: "extra" },
  ];
  expect(buildBlindReviewSet(rows, "frozen-salt")).toEqual(
    buildBlindReviewSet([...rows].reverse(), "frozen-salt")
  );
});

it("keeps blind identities independent of version and rank assignments", () => {
  const rows = [
    { sourceId: "source-a", version: "baseline" as const, rank: 0, start: 10, end: 30, title: "same" },
    { sourceId: "source-a", version: "candidate" as const, rank: 1, start: 10.4, end: 30.2, title: "same" },
    { sourceId: "source-a", version: "candidate" as const, rank: 0, start: 10.8, end: 30.4, title: "same" },
  ];
  const swapped = rows.map((row, index) => ({
    ...row,
    version: (row.version === "baseline" ? "candidate" : "baseline") as "baseline" | "candidate",
    rank: 2 - index,
  }));
  const first = buildBlindReviewSet(rows, "frozen-salt").review.map(row => row.blindId);
  const second = buildBlindReviewSet(swapped, "frozen-salt").review.map(row => row.blindId);
  expect(second).toEqual(first);
});

it("keeps the full review payload independent of version when context differs", () => {
  const rows = [
    { sourceId: "source-a", version: "baseline" as const, rank: 0, start: 10, end: 30, title: "same", transcript: "same", before: "Zulu", after: "Beta" },
    { sourceId: "source-a", version: "candidate" as const, rank: 0, start: 10, end: 30, title: "same", transcript: "same", before: "Alpha", after: "Omega" },
  ];
  const swapped = rows.map(row => ({
    ...row,
    version: (row.version === "baseline" ? "candidate" : "baseline") as "baseline" | "candidate",
  }));
  expect(buildBlindReviewSet(swapped, "frozen-salt").review).toEqual(
    buildBlindReviewSet(rows, "frozen-salt").review
  );
});
