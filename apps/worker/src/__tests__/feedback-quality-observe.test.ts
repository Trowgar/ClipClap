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
import { observeSelectionCase } from "../feedback-quality/selection-lane";
import { loadPrivateCases } from "../feedback-quality/observe";
import { appendLabelEvent, publishBundle } from "../feedback-quality/store";
import { parseObserveArgs, readSecureConfig, runObservationCli, validateObservationConfig } from "../scripts/feedback-quality-observe";

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
  replay: { highlight: { start: 0, end: 10, title: "sample", hookStart: 1, hookEnd: 2, payoffAt: 5, language: "en", clipKind: "speech" }, subtitleTrack: null, cropPlan: null, renderManifest: null, reframeConfig: null, musicDirection: null, blackTail: null, sourceUrl: null },
});

const result = {
  status: "ok" as const,
  metrics: {
    approvedMomentRetained: 1,
    approvedWindowOverlap: 1,
    emptyResult: 0,
    zeroClipFalseNegative: 0,
  },
  telemetry: { kept: 1, criticVerdicts: 1, omittedDrops: 0, truncatedDrops: 0, refusalDrops: 0, invariantDrops: 0 },
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
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, runnerVersion: 1, promptFingerprint: hash("a"), modelFingerprint: hash("b"), recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b") }, envAllowlist: [], engine: {} }), { mode: 0o600 });
    expect(await readSecureConfig(path)).toMatchObject({ schemaVersion: 1, runnerVersion: 1 });
    expect(() => validateObservationConfig({ schemaVersion: 1, runnerVersion: 1, promptFingerprint: hash("a"), modelFingerprint: hash("b"), envAllowlist: [], engine: {} }, false)).toThrow("fingerprint");
    expect(() => validateObservationConfig({ schemaVersion: 1, runnerVersion: 1, promptFingerprint: hash("a"), modelFingerprint: hash("b"), envAllowlist: [], engine: {} }, true)).not.toThrow();
  });

  it("loads only active, committed case bundles for the requested set and derives their digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-corpus-"));
    const id = `case:${hash("a")}`;
    await publishBundle({ kind: "case", id, files: { "case.json": Buffer.from(JSON.stringify({ ...sampleCase(), caseVersion: id }) + "\n"), "source-or-evidence.mp4": Buffer.from("video") } }, root);
    await appendLabelEvent({ schemaVersion: 1, eventId: "event-1", action: "label", caseVersion: id, set: "eval", disposition: "positive" }, root);
    const loaded = await loadPrivateCases("eval", root);
    expect(loaded.cases.map((item) => item.caseVersion)).toEqual([id]);
    expect(loaded.corpusSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await loadPrivateCases("holdout", root)).cases).toHaveLength(0);
  });

  it("fails the production loader closed when a labelled case bundle is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-missing-"));
    await appendLabelEvent({ schemaVersion: 1, eventId: "event-1", action: "label", caseVersion: `case:${hash("a")}`, set: "eval", disposition: "positive" }, root);
    const loaded = await loadPrivateCases("eval", root);
    expect(loaded.cases).toHaveLength(1);
    expect((loaded.cases[0] as { loadStatus?: string }).loadStatus).toBe("missing");
  });

  it("runs the real CLI loader and persists three independent live records", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-cli-"));
    const id = `case:${hash("a")}`;
    await publishBundle({ kind: "case", id, files: { "case.json": Buffer.from(JSON.stringify({ ...sampleCase(), caseVersion: id }) + "\n"), "source-or-evidence.mp4": Buffer.from("video") } }, root);
    await appendLabelEvent({ schemaVersion: 1, eventId: "event-cli", action: "label", caseVersion: id, set: "eval", disposition: "positive" }, root);
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, runnerVersion: 1, promptFingerprint: hash("a"), modelFingerprint: hash("b"), envAllowlist: [], engine: {} }), { mode: 0o600 });
    const attemptNames: string[] = [];
    let publishedAttempts: readonly unknown[] = [];
    const observation = await runObservationCli(["--set", "eval", "--mode", "baseline", "--commit", "a".repeat(40), "--config-file", configPath, "--live"], {
      root,
      dependencies: { runCase: vi.fn(async (_case, context) => { attemptNames.push(context.attemptName ?? ""); return result; }), publish: vi.fn(async (_observation, attempts) => { publishedAttempts = attempts; return { status: "committed" as const }; }) },
    });
    expect(observation.cases).toHaveLength(1);
    expect(attemptNames).toEqual(["live-1", "live-2", "live-3"]);
    expect(publishedAttempts.map((item) => (item as { attemptName: string }).attemptName)).toEqual(["live-1", "live-2", "live-3"]);
  });

  it("keeps the render lane stage-equivalent and records hard media metrics", async () => {
    const order: string[] = [];
    const clip = { start: 0, end: 10, title: "x", description: "x", hookStart: 0, hookEnd: 1, payoffAt: 5 } as never;
    const lane = await observeRenderCase(sampleCase(), {
      sourcePath: "/private/source.mp4", highlight: clip, transcriptSegments: [], probe: async () => ({
        width: 1080, height: 1920, sar: 1, duration: 10, frameCount: 250, blackTailSeconds: 0, frozenTailSeconds: 0,
        subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, focalFailures: 0,
        visualMeasured: true,
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

  it("retries a failed filtered encode with legacy crop and probes the private output", async () => {
    const calls: Array<string | null> = [];
    let attempt = 0;
    const copied: string[] = [];
    const clip = { start: 0, end: 10, title: "x" } as never;
    const lane = await observeRenderCase({ ...sampleCase(), subsystem: "render" }, {
      sourcePath: "/private/source.mp4", highlight: clip, transcriptSegments: [], probe: async (path) => {
        expect(path).toBe("/private/observed.mp4");
        return { width: 1080, height: 1920, sar: 1, duration: 8, frameCount: 200, blackTailSeconds: 0, frozenTailSeconds: 0, subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, visualMeasured: true };
      }, privateOutputPath: "/private/observed.mp4", copyOutput: async (_source, destination) => { copied.push(destination); },
      segmentsToCues: (() => []) as never,
      computeCropPlan: (async () => ({ plan: { shots: [] } as never, shotCount: 1, detectMs: 1 })) as never,
      buildFiltergraph: (() => ({ graph: "filtered" })) as never,
      cutClips: (async (_source: string, _highlights: unknown[], _extra: string | undefined, graph: unknown) => { calls.push(graph ? "filtered" : null); attempt += 1; if (attempt === 1) throw new Error("encode"); return [{ clipPath: "/private/clip.mp4", highlight: clip }]; }) as never,
    });
    expect(calls).toEqual(["filtered", null]);
    expect(copied).toEqual(["/private/observed.mp4"]);
    expect(lane.metrics).toMatchObject({ durationDrift: 2, approvedWindowOverlap: 0.8 });
  });

  it("uses actual selected highlight metrics and rejects missing production telemetry", async () => {
    const qualityCase = sampleCase();
    const transcript = { text: "hello world", segments: [{ start: 0, end: 10, text: "hello world", words: [] }] } as never;
    await expect(observeSelectionCase(qualityCase, { transcript, analyze: async () => ({ highlights: [{ start: 1, end: 8, hookStart: 3, payoffAt: 6, score: 0.7 }], telemetry: {} }) })).rejects.toThrow("telemetry");
    const selected = await observeSelectionCase(qualityCase, { transcript, analyze: async () => ({ highlights: [{ start: 1, end: 8, hookStart: 3, payoffAt: 6, score: 0.7, lowQuality: true }], telemetry: { kept: 1, criticVerdicts: 1, omittedDrops: 0, truncatedDrops: 0, refusalDrops: 0, invariantDrops: 0 } }) });
    expect(selected.metrics).toMatchObject({ hookDelay: 2, payoffContainment: 1, score: 0.7, lowQuality: 1 });
  });

  it("fails closed when visual probe annotations are unavailable", async () => {
    const clip = { start: 0, end: 10, title: "x" } as never;
    await expect(observeRenderCase({ ...sampleCase(), subsystem: "render" }, {
      sourcePath: "/private/source.mp4", highlight: clip, transcriptSegments: [], probe: async () => ({
        width: 1080, height: 1920, sar: 1, duration: 10, frameCount: 250, blackTailSeconds: 0, frozenTailSeconds: 0, subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, visualMeasured: false,
      }), segmentsToCues: (() => []) as never, computeCropPlan: (async () => ({ plan: null, shotCount: 0, detectMs: 0 })) as never, cutClips: (async () => [{ clipPath: "/tmp/out.mp4", highlight: clip }]) as never,
    })).rejects.toThrow("visual probe unavailable");
  });
});
