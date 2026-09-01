import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedCase } from "../feedback-quality/promote";
import {
  observeQualitySet,
  type ObservationCaseRunner,
  type ObservationDependencies,
} from "../feedback-quality/observe";
import { observeRenderCase } from "../feedback-quality/render-lane";
import { parseObserveArgs, readSecureConfig } from "../scripts/feedback-quality-observe";

const hash = (n: string) => `sha256:${n.repeat(64).slice(0, 64)}` as `sha256:${string}`;
const sampleCase = (set: "eval" | "holdout" = "eval"): MaterializedCase => ({
  schemaVersion: 1,
  caseVersion: `case:${hash("a")}`,
  feedbackId: "feedback-1",
  clipId: "clip-1",
  jobId: "job-1",
  userId: "user-1",
  feedbackUpdatedAt: "2026-08-31T00:00:00.000Z",
  snapshotSha256: hash("b"),
  candidateVersion: hash("c"),
  set,
  disposition: "positive",
  verdict: "AS_IS",
  subsystem: "selection",
  confidence: "high",
  expected: { approvedMoment: true, completeBoundary: true },
  inputs: { transcriptSha256: hash("d"), evidenceSha256: hash("e"), sourceSha256: null, sourceDurationSec: 30 },
});

const result = {
  status: "ok" as const,
  metrics: {
    approvedMomentRetained: 1,
    approvedWindowOverlap: 1,
    emptyResult: 0,
    zeroClipFalseNegative: 0,
  },
};

describe("feedback quality observation runner", () => {
  it("rejects ambient environment and only accepts the explicit allowlist", async () => {
    const runCase: ObservationCaseRunner = vi.fn(async () => result);
    const deps: ObservationDependencies = { runCase };
    await expect(observeQualitySet({
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: {},
      corpusSha256: hash("f"), runnerVersion: 1, cases: [sampleCase()], dependencies: deps,
      environment: { OPENAI_API_KEY: "secret", QUALITY_ALLOWED: "yes" },
      allowedEnvironment: ["QUALITY_ALLOWED"],
    })).rejects.toThrow("environment");
    expect(runCase).not.toHaveBeenCalled();
  });

  it("does not allow eval and holdout cases to cross the observation boundary", async () => {
    const runCase: ObservationCaseRunner = vi.fn(async () => result);
    await expect(observeQualitySet({
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: {},
      corpusSha256: hash("f"), runnerVersion: 1, cases: [sampleCase("holdout")],
      dependencies: { runCase }, environment: {}, allowedEnvironment: [],
    })).rejects.toThrow("set");
  });

  it("fails recorded replay on a fingerprint mismatch and requires live for a changed prompt/model", async () => {
    const runCase: ObservationCaseRunner = vi.fn(async () => result);
    const base = {
      set: "eval" as const, mode: "candidate" as const, commitSha: "a".repeat(40), config: {},
      corpusSha256: hash("f"), runnerVersion: 1, cases: [sampleCase()], dependencies: { runCase },
      environment: {}, allowedEnvironment: [], promptFingerprint: hash("a"), modelFingerprint: hash("b"),
    };
    await expect(observeQualitySet({ ...base, recorded: { promptFingerprint: hash("c"), modelFingerprint: hash("b") } }))
      .rejects.toThrow("live");
    await expect(observeQualitySet({ ...base, recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b") }, promptFingerprint: hash("d") }))
      .rejects.toThrow("live");
  });

  it("stores three named live outcomes independently and publishes an immutable observation", async () => {
    const names: string[] = [];
    const publish = vi.fn(async (observation: unknown) => {
      expect(observation).toMatchObject({ mode: "baseline", set: "eval" });
      return { status: "committed" as const };
    });
    const runCase: ObservationCaseRunner = vi.fn(async (_item, context) => {
      names.push(context.attemptName ?? "missing");
      return result;
    });
    const observation = await observeQualitySet({
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: {},
      corpusSha256: hash("f"), runnerVersion: 1, cases: [sampleCase()], dependencies: { runCase, publish },
      environment: {}, allowedEnvironment: [], live: true, promptFingerprint: hash("a"), modelFingerprint: hash("b"),
    });
    expect(names).toEqual(["live-1", "live-2", "live-3"]);
    expect(observation.cases[0].metrics).toEqual(result.metrics);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it("publishes missing input as an error result instead of silently skipping the case", async () => {
    const publish = vi.fn(async () => ({ status: "committed" as const }));
    const observation = await observeQualitySet({
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: {},
      corpusSha256: hash("f"), runnerVersion: 1, cases: [sampleCase()], dependencies: {
        publish, runCase: vi.fn(async () => { throw new Error("input missing"); }),
      }, environment: {}, allowedEnvironment: [],
    });
    expect(observation.cases[0].status).toBe("error");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("accepts only the documented CLI flags and requires a private 0600 config", async () => {
    expect(parseObserveArgs(["--set", "eval", "--mode", "baseline", "--commit", "a".repeat(40), "--config-file", "/tmp/config.json", "--live"]))
      .toMatchObject({ set: "eval", mode: "baseline", live: true });
    expect(() => parseObserveArgs(["--set", "eval", "--unknown", "x"])).toThrow("unknown_flag");
    const root = await mkdtemp(join(tmpdir(), "quality-observe-test-"));
    const path = join(root, "config.json");
    await writeFile(path, "{}", { mode: 0o600 });
    expect(await readSecureConfig(path)).toEqual({});
    await chmod(path, 0o644);
    await expect(readSecureConfig(path)).rejects.toThrow("insecure_config");
  });

  it("keeps the render lane stage-equivalent and records hard media metrics", async () => {
    const order: string[] = [];
    const clip = { start: 0, end: 10, title: "x", description: "x", hookStart: 0, hookEnd: 1, payoffAt: 5 } as never;
    const lane = await observeRenderCase(sampleCase(), {
      sourcePath: "/private/source.mp4", highlight: clip, transcriptSegments: [], probe: async () => ({
        width: 1080, height: 1920, sar: 1, duration: 10, frameCount: 250, blackTailSeconds: 0, frozenTailSeconds: 0,
        subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, focalFailures: 0,
      }),
      segmentsToCues: (() => { order.push("cues"); return []; }) as never,
      createAssFilter: (async () => { order.push("ass"); return { filter: "ass", assPath: "/private/a.ass" }; }) as never,
      computeCropPlan: (async () => { order.push("crop"); return { plan: null, shotCount: 0, detectMs: 1 }; }) as never,
      buildFiltergraph: (() => { order.push("graph"); return { graph: "x" }; }) as never,
      cutClips: (async () => { order.push("cut"); return [{ clipPath: "/private/out.mp4", highlight: clip }]; }) as never,
    });
    expect(order).toEqual(["cues", "crop", "cut"]);
    expect(lane.metrics).toMatchObject({ outputWidth: 1080, outputHeight: 1920, sar: 1, frameCount: 250, hardInvariantFailures: 0 });
  });
});
