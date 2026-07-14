import { describe, expect, it } from "vitest";
import { selectAndOrder } from "../analyze-v2/select";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SnappedClip } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

function clip(startSec: number, endSec: number, score: number, extra?: Partial<CriticVerdict>): SnappedClip {
  return {
    verdict: {
      id: `c-${startSec}-${score}`,
      keep: true,
      score,
      grounded: true,
      selfContained: true,
      startNode: 0,
      payoffNode: 1,
      endNode: 2,
      hookStartNode: 0,
      hookEndNode: 1,
      title: "t",
      description: "d",
      titleEvidenceNodes: [1],
      descriptionEvidenceNodes: [1],
      language: "ru",
      ...extra,
    },
    startSec,
    endSec,
    hookStartSec: startSec + 1,
    hookEndSec: startSec + 3,
    payoffSec: endSec - 2,
    shortMoment: false,
  };
}

describe("selectAndOrder", () => {
  it("returns strong-tier clips sorted by score desc, capped at softCap", () => {
    const clips = Array.from({ length: 15 }, (_, i) => clip(i * 100, i * 100 + 30, 0.6 + (i % 10) * 0.04));
    const r = selectAndOrder(clips, cfg);
    expect(r.tier).toBe("strong");
    expect(r.selected.length).toBe(cfg.softCap);
    for (let i = 1; i < r.selected.length; i++) {
      expect(r.selected[i].verdict.score).toBeLessThanOrEqual(r.selected[i - 1].verdict.score!);
    }
  });

  it("falls back to top-2 weak tier above the absolute floor when nothing is strong", () => {
    const clips = [clip(0, 30, 0.5), clip(100, 130, 0.45), clip(200, 230, 0.4)];
    const r = selectAndOrder(clips, cfg);
    expect(r.tier).toBe("weak");
    expect(r.selected).toHaveLength(2);
    expect(r.selected.every((c) => c.verdict.score >= cfg.weakFallbackMinScore)).toBe(true);
    expect(r.selected.every((c) => c.verdict.lowQuality === true)).toBe(true);
  });

  it("returns empty when nothing clears even the weak floor", () => {
    const r = selectAndOrder([clip(0, 30, 0.2)], cfg);
    expect(r.tier).toBe("none");
    expect(r.selected).toHaveLength(0);
  });

  it("NMS is keep-or-drop: the lower-scored clip overlapping >30% of the shorter disappears whole", () => {
    const a = clip(0, 60, 0.9);
    const b = clip(30, 80, 0.7); // 30s overlap of a 50s clip -> 60% of shorter
    const r = selectAndOrder([a, b], cfg);
    expect(r.selected).toHaveLength(1);
    expect(r.selected[0].verdict.score).toBe(0.9);
    // no boundary edits happened
    expect(r.selected[0].startSec).toBe(0);
    expect(r.selected[0].endSec).toBe(60);
  });

  it("keeps small overlaps (<30% of shorter)", () => {
    const a = clip(0, 60, 0.9);
    const b = clip(55, 120, 0.7); // 5s overlap of a 65s clip
    const r = selectAndOrder([a, b], cfg);
    expect(r.selected).toHaveLength(2);
  });
});
