import { describe, expect, it } from "vitest";
import { rescueShortSource } from "../analyze-v2/rescue";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

/** 20 nodes x 2s each, all strong sentence boundaries - snap.test.ts's own
 *  fixture, duplicated deliberately: these tests must keep passing even if
 *  that file's fixture evolves with snap's needs. */
function strongNodes(): SentenceNode[] {
  return Array.from({ length: 20 }, (_, i) => ({
    index: i,
    start: i * 2,
    end: i * 2 + 1.8,
    text: `Sentence ${i}.`,
    hasWords: true,
    trailingStrength: 1.0,
    leadingStrength: 1.0,
  }));
}

function verdict(p: Partial<CriticVerdict>): CriticVerdict {
  return {
    id: "c0",
    keep: false, // the rescue's expected common case
    score: 0.2,
    grounded: true,
    selfContained: true,
    startNode: 2,
    payoffNode: 6,
    endNode: 7,
    hookStartNode: 5,
    hookEndNode: 6,
    title: "A latin title",
    description: "A latin description.",
    titleEvidenceNodes: [6],
    descriptionEvidenceNodes: [6],
    language: "en",
    ...p,
  };
}

describe("rescueShortSource", () => {
  it("ships the highest-scoring verdict even when the critic said keep:false", () => {
    const r = rescueShortSource(
      [
        verdict({ id: "low", score: 0.1, startNode: 10, payoffNode: 13, endNode: 14, hookStartNode: 12, hookEndNode: 13 }),
        verdict({ id: "high", score: 0.3 }),
      ],
      strongNodes(),
      cfg
    );
    expect(r.clip).not.toBeNull();
    expect(r.clip!.verdict.id).toBe("high");
    expect(r.clip!.verdict.lowQuality).toBe(true);
    expect(r.telemetry).toMatchObject({
      attempted: 1,
      snapFailures: 0,
      compressFailures: 0,
      shipped: true,
      verdictId: "high",
      score: 0.3,
      keptByCritic: false,
    });
  });

  it("breaks score ties by id so a re-rolled critic set ships deterministically", () => {
    const a = verdict({ id: "a", score: 0.2 });
    const b = verdict({ id: "b", score: 0.2, startNode: 10, payoffNode: 13, endNode: 14, hookStartNode: 12, hookEndNode: 13 });
    expect(rescueShortSource([b, a], strongNodes(), cfg).clip!.verdict.id).toBe("a");
    expect(rescueShortSource([a, b], strongNodes(), cfg).clip!.verdict.id).toBe("a");
  });

  it("skips an unsnappable verdict, counts it, and ships the next one", () => {
    const r = rescueShortSource(
      [
        verdict({ id: "broken", score: 0.9, startNode: 99 }), // invariant_violation
        verdict({ id: "ok", score: 0.2 }),
      ],
      strongNodes(),
      cfg
    );
    expect(r.clip!.verdict.id).toBe("ok");
    expect(r.telemetry).toMatchObject({ attempted: 2, snapFailures: 1, shipped: true });
  });

  it("returns null with honest telemetry when nothing can be snapped", () => {
    const r = rescueShortSource(
      [verdict({ id: "b1", startNode: 99 }), verdict({ id: "b2", payoffNode: -1 })],
      strongNodes(),
      cfg
    );
    expect(r.clip).toBeNull();
    expect(r.telemetry).toEqual({ attempted: 2, snapFailures: 2, compressFailures: 0, shipped: false });
  });

  it("returns null for an empty verdict list", () => {
    const r = rescueShortSource([], strongNodes(), cfg);
    expect(r.clip).toBeNull();
    expect(r.telemetry).toEqual({ attempted: 0, snapFailures: 0, compressFailures: 0, shipped: false });
  });

  it("keeps the critic's own copy when it matches the clip's script", () => {
    const r = rescueShortSource([verdict({})], strongNodes(), cfg);
    expect(r.clip!.verdict.title).toBe("A latin title");
    expect(r.telemetry.copySource).toBe("model");
  });

  it("replaces an empty title with the verbatim snippet", () => {
    const r = rescueShortSource([verdict({ title: "  " })], strongNodes(), cfg);
    expect(r.clip!.verdict.title).toMatch(/^Sentence \d+\./);
    expect(r.telemetry.copySource).toBe("snippet");
  });

  it("replaces copy whose script does not match the speech", () => {
    const r = rescueShortSource(
      [verdict({ title: "Кириллический заголовок", description: "Кириллическое описание." })],
      strongNodes(),
      cfg
    );
    expect(r.clip!.verdict.title).toMatch(/^Sentence \d+\./);
    expect(r.telemetry.copySource).toBe("snippet");
  });

  it("regrounds copy whose evidence lies outside the shipped range", () => {
    // Evidence node 19 is far outside the 2..7 clip - regroundCopy replaces
    // the copy with the in-range snippet and the telemetry says so.
    const r = rescueShortSource(
      [verdict({ titleEvidenceNodes: [19], descriptionEvidenceNodes: [19] })],
      strongNodes(),
      cfg
    );
    expect(r.clip!.verdict.title).toMatch(/^Sentence \d+\./);
    expect(r.telemetry.copySource).toBe("reground");
    const from = r.clip!.finalStartNode;
    const to = r.clip!.finalEndNode;
    for (const i of r.clip!.verdict.titleEvidenceNodes) {
      expect(i).toBeGreaterThanOrEqual(from);
      expect(i).toBeLessThanOrEqual(to);
    }
  });

  it("skips an overLength clip that cannot be compressed - counted apart from snap failures", () => {
    // LONG_CLIPS on, ~110s span, hook right after the start: the compression
    // walk has only node 1 to try and the span from there is still over
    // maxSec. The clip must be SKIPPED and counted as a compressFailure -
    // shipping it wide would bypass the long-clip policy's whole contract.
    const longCfg = loadAnalyzeConfig({ LONG_CLIPS: "on" });
    const nodes: SentenceNode[] = Array.from({ length: 60 }, (_, i) => ({
      index: i,
      start: i * 2,
      end: i * 2 + 1.8,
      text: `Sentence ${i}.`,
      hasWords: true,
      trailingStrength: 1.0,
      leadingStrength: 1.0,
    }));
    const r = rescueShortSource(
      [
        verdict({
          startNode: 0,
          payoffNode: 54,
          endNode: 55,
          hookStartNode: 1,
          hookEndNode: 2,
          titleEvidenceNodes: [54],
          descriptionEvidenceNodes: [54],
        }),
      ],
      nodes,
      longCfg
    );
    expect(r.clip).toBeNull();
    expect(r.telemetry).toEqual({
      attempted: 1,
      snapFailures: 0,
      compressFailures: 1,
      shipped: false,
    });
  });

  it("never ships an overLength clip wide - compresses it like an unblessed clip", () => {
    // 60 nodes x 2s. Verdict spans 0..55 (~112s) - over maxSec 90, under
    // longClipMaxSec 150, so with LONG_CLIPS on snap DEFERS compression and
    // marks overLength. No blessing exists in a rescue, so the clip must come
    // out compressed under maxSec, never wide.
    const longCfg = loadAnalyzeConfig({ LONG_CLIPS: "on" });
    const nodes: SentenceNode[] = Array.from({ length: 60 }, (_, i) => ({
      index: i,
      start: i * 2,
      end: i * 2 + 1.8,
      text: `Sentence ${i}.`,
      hasWords: true,
      trailingStrength: 1.0,
      leadingStrength: 1.0,
    }));
    const r = rescueShortSource(
      [
        verdict({
          startNode: 0,
          payoffNode: 54,
          endNode: 55,
          hookStartNode: 52,
          hookEndNode: 53,
          titleEvidenceNodes: [54],
          descriptionEvidenceNodes: [54],
        }),
      ],
      nodes,
      longCfg
    );
    expect(r.clip).not.toBeNull();
    expect(r.clip!.overLength).toBe(false);
    expect(r.clip!.endSec - r.clip!.startSec).toBeLessThanOrEqual(longCfg.maxSec);
    expect(r.telemetry.shipped).toBe(true);
  });
});
