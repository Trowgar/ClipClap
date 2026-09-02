import { describe, expect, it } from "vitest";
import {
  partitionCriticCandidates,
  selectCriticCandidates,
} from "../analyze-v2/candidates";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { AnalyzeConfig } from "../analyze-v2/config";
import type { MergedCandidate, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

function nodes(count: number, secEach = 5): SentenceNode[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    start: index * secEach,
    end: index * secEach + secEach,
    text: `node-${index}`,
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
  }));
}

function candidate(
  id: string,
  input: Partial<MergedCandidate> = {}
): MergedCandidate {
  return {
    id,
    startNode: 0,
    endNode: 0,
    payoffNode: 0,
    interest: 0.5,
    type: "other",
    windowIndex: 0,
    ...input,
  };
}

function expectLosslessPartition(
  merged: MergedCandidate[],
  options: { nodes?: SentenceNode[]; config?: AnalyzeConfig; mode?: "standard" | "stream" } = {}
): void {
  const partition = partitionCriticCandidates(
    merged,
    options.nodes ?? nodes(200),
    options.config ?? cfg,
    options.mode ?? "standard"
  );
  const all = [...partition.selected, ...partition.unselected];
  expect(all).toHaveLength(merged.length);
  expect(new Set(all.map((item) => item.id)).size).toBe(merged.length);
  expect(all.map((item) => item.id).sort()).toEqual(merged.map((item) => item.id).sort());
  expect(partition.selected).toEqual(
    selectCriticCandidates(
      merged,
      options.nodes ?? nodes(200),
      options.config ?? cfg,
      options.mode ?? "standard"
    )
  );
}

describe("partitionCriticCandidates", () => {
  it("preserves exact selector ordering, including equal-interest ties", () => {
    const merged = [
      candidate("w0-first", { windowIndex: 0, interest: 0.8 }),
      candidate("w0-second", { windowIndex: 0, interest: 0.8 }),
      candidate("w1-first", { windowIndex: 1, interest: 0.8 }),
      candidate("w1-second", { windowIndex: 1, interest: 0.8 }),
      candidate("global-first", { windowIndex: 2, interest: 0.7 }),
    ];
    const config = { ...cfg, criticMaxCandidates: 5, perWindowMinCandidates: 1 };
    const partition = partitionCriticCandidates(merged, nodes(200), config);

    expect(partition.selected.map((item) => item.id)).toEqual([
      "w0-first",
      "w1-first",
      "global-first",
      "w0-second",
      "w1-second",
    ]);
    expectLosslessPartition(merged, { config });
  });

  it("keeps per-window quota picks selected even when quota exceeds K", () => {
    const merged = Array.from({ length: 3 }, (_, windowIndex) =>
      Array.from({ length: 3 }, (_, rank) =>
        candidate(`w${windowIndex}-${rank}`, {
          windowIndex,
          interest: 0.9 - rank * 0.1,
        })
      )
    ).flat();
    const config = {
      ...cfg,
      criticMaxCandidates: 2,
      perWindowMinCandidates: 2,
    };
    const partition = partitionCriticCandidates(merged, nodes(200), config);

    expect(partition.selected.map((item) => item.id)).toEqual([
      "w0-0",
      "w0-1",
      "w1-0",
      "w1-1",
      "w2-0",
      "w2-1",
    ]);
    expectLosslessPartition(merged, { config });
  });

  it("retains candidates excluded by the regional cap in input order", () => {
    const merged = [
      candidate("region0-quota", { windowIndex: 0, payoffNode: 0, interest: 0.8 }),
      candidate("region0-extra-a", { windowIndex: 0, payoffNode: 1, interest: 0.7 }),
      candidate("region0-extra-b", { windowIndex: 0, payoffNode: 2, interest: 0.6 }),
      candidate("region1-quota", { windowIndex: 1, payoffNode: 120, interest: 0.5 }),
    ];
    const config = {
      ...cfg,
      criticMaxCandidates: 10,
      perWindowMinCandidates: 1,
      regionMaxCandidates: 1,
    };
    const partition = partitionCriticCandidates(merged, nodes(200), config);

    expect(partition.selected.map((item) => item.id)).toEqual([
      "region0-quota",
      "region1-quota",
    ]);
    expect(partition.unselected.map((item) => item.id)).toEqual([
      "region0-extra-a",
      "region0-extra-b",
    ]);
    expectLosslessPartition(merged, { config });
  });

  it("uses stream quota and budget rules while preserving a lossless partition", () => {
    const merged = Array.from({ length: 4 }, (_, windowIndex) =>
      Array.from({ length: 3 }, (_, rank) =>
        candidate(`w${windowIndex}-${rank}`, {
          windowIndex,
          interest: 0.9 - rank * 0.1,
        })
      )
    ).flat();
    const config = {
      ...cfg,
      criticMaxCandidates: 2,
      streamCriticMaxCandidates: 4,
      perWindowMinCandidates: 2,
      regionMaxCandidates: 99,
    };
    const partition = partitionCriticCandidates(merged, nodes(200), config, "stream");

    expect(partition.selected.map((item) => item.id)).toEqual([
      "w0-0",
      "w1-0",
      "w2-0",
      "w3-0",
    ]);
    expectLosslessPartition(merged, { config, mode: "stream" });
  });

  it("does not mutate the input array or candidate objects", () => {
    const merged = [
      candidate("first", { windowIndex: 0, interest: 0.2 }),
      candidate("second", { windowIndex: 0, interest: 0.9 }),
      candidate("third", { windowIndex: 1, interest: 0.8 }),
    ];
    const before = structuredClone(merged);
    const originalArray = [...merged];

    partitionCriticCandidates(merged, nodes(200), cfg);

    expect(merged).toEqual(before);
    expect(merged).toEqual(originalArray);
  });
});
