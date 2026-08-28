import { describe, expect, it } from "vitest";
import filterStandaloneClips from "../analyze-v2/standalone-filter";
import type { ArcFlags, SnappedClip } from "../analyze-v2/types";

function clip(id: string, score: number): SnappedClip {
  return { verdict: { id, score } } as SnappedClip;
}

function flags(
  entryOk: boolean,
  exitOk: boolean,
  standaloneOk: boolean,
  repaired: { entry?: true; exit?: true } = {},
): ArcFlags {
  return {
    entry: { ok: entryOk, ...(repaired.entry ? { repaired: true } : {}) },
    exit: { ok: exitOk, ...(repaired.exit ? { repaired: true } : {}) },
    standalone: { ok: standaloneOk },
  };
}

function run(clips: SnappedClip[], rows: [string, ArcFlags][]) {
  return filterStandaloneClips(clips, new Map(rows), 0.6, 0.15);
}

describe("filterStandaloneClips", () => {
  it("drops a low-score standalone failure when a clean alternative exists", () => {
    const clean = clip("clean", 0.82);
    const rejected = clip("rejected", 0.67);
    expect(run([clean, rejected], [
      ["clean", flags(true, true, true)],
      ["rejected", flags(true, true, false)],
    ])).toEqual({
      clips: [clean],
      drops: [{ id: "rejected", score: 0.67 }],
      telemetry: { considered: 2, eligible: 1, dropped: 1, bypassedNoCleanAlternative: 0 },
    });
  });

  it("bypasses filtering when no fully clean alternative exists", () => {
    const rejected = clip("rejected", 0.67);
    const entryFailed = clip("entry-failed", 0.9);
    const input = [rejected, entryFailed];
    const result = run(input, [
      ["rejected", flags(true, true, false)],
      ["entry-failed", flags(false, true, true)],
    ]);
    expect(result.clips).toBe(input);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toEqual({ considered: 2, eligible: 1, dropped: 0, bypassedNoCleanAlternative: 1 });
  });

  it("keeps scores at and above the strict post-penalty threshold", () => {
    const clean = clip("clean", 0.82);
    const high = clip("high", 0.76);
    const equal = clip("equal", 0.75);
    expect(run([clean, high, equal], [
      ["clean", flags(true, true, true)],
      ["high", flags(true, true, false)],
      ["equal", flags(true, true, false)],
    ]).telemetry).toEqual({ considered: 3, eligible: 0, dropped: 0, bypassedNoCleanAlternative: 0 });
  });

  it("keeps entry-only and exit-only failures above the threshold", () => {
    const clean = clip("clean", 0.82);
    const entry = clip("entry", 0.67);
    const exit = clip("exit", 0.67);
    const result = run([clean, entry, exit], [
      ["clean", flags(true, true, true)],
      ["entry", flags(false, true, true)],
      ["exit", flags(true, false, true)],
    ]);
    expect(result.clips).toEqual([clean, entry, exit]);
    expect(result.telemetry).toEqual({ considered: 3, eligible: 0, dropped: 0, bypassedNoCleanAlternative: 0 });
  });

  it("treats missing flags as neither failure nor clean", () => {
    const missing = clip("missing", 0.9);
    const failed = clip("failed", 0.67);
    const input = [missing, failed];
    const result = run(input, [["failed", flags(true, true, false)]]);
    expect(result.clips).toBe(input);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toEqual({ considered: 2, eligible: 1, dropped: 0, bypassedNoCleanAlternative: 1 });
  });

  it("does not treat a repaired-only alternative as clean", () => {
    const repaired = clip("repaired", 0.9);
    const rejected = clip("rejected", 0.67);
    const input = [repaired, rejected];
    const result = run(input, [
      ["repaired", flags(false, true, true, { entry: true })],
      ["rejected", flags(true, true, false)],
    ]);
    expect(result.clips).toBe(input);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toEqual({ considered: 2, eligible: 1, dropped: 0, bypassedNoCleanAlternative: 1 });
  });

  it("preserves order, object identity, and original scores", () => {
    const first = clip("first", 0.81);
    const rejected = clip("rejected", 0.67);
    const last = clip("last", 0.79);
    const result = run([first, rejected, last], [
      ["first", flags(true, true, true)],
      ["rejected", flags(true, true, false)],
      ["last", flags(true, true, true)],
    ]);
    expect(result.clips).toEqual([first, last]);
    expect(result.clips[0]).toBe(first);
    expect(result.clips[1]).toBe(last);
    expect(rejected.verdict.score).toBe(0.67);
    expect(result.drops).toEqual([{ id: "rejected", score: 0.67 }]);
    expect(result.telemetry).toEqual({ considered: 3, eligible: 1, dropped: 1, bypassedNoCleanAlternative: 0 });
  });
});
