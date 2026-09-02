import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedCase } from "../feedback-quality/promote";
import {
  observeQualitySet,
  readObservationAttempts,
  type ObservationCaseRunner,
  type ObservationDependencies,
} from "../feedback-quality/observe";
import { observeRenderCase } from "../feedback-quality/render-lane";
import { observeSelectionCase } from "../feedback-quality/selection-lane";
import { deriveQualityCorpusDigest, loadPrivateCases, loadQualityCorpusSnapshot } from "../feedback-quality/observe";
import { appendLabelEvent, contentId, publishBundle, readBundle, readLabelEvents } from "../feedback-quality/store";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { parseObserveArgs, readSecureConfig, runObservationCli, validateObservationConfig } from "../scripts/feedback-quality-observe";
import { measureVisualReplay, type VisualProbeExec } from "../feedback-quality/visual-probe";

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
  expected: { approvedMoment: true, completeBoundary: true, visualSamples: [] },
  inputs: { transcriptSha256: hash("d"), evidenceSha256: hash("e"), sourceSha256: null, sourceDurationSec: 30, recordedResponsesSha256: null },
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
const observationConfig = { schemaVersion: 1 as const, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), envAllowlist: [] as string[], engine: {} };

describe("feedback quality observation runner", () => {
  it("rejects ambient environment and only accepts the explicit allowlist", async () => {
    const runCase: ObservationCaseRunner = vi.fn(async () => result);
    const deps: ObservationDependencies = { runCase };
    await expect(observeQualitySet({
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: observationConfig,
      corpusSha256: hash("f"), runnerVersion: 2, cases: [sampleCase()], dependencies: deps,
      environment: { OPENAI_API_KEY: "secret", QUALITY_ALLOWED: "yes" },
      allowedEnvironment: ["QUALITY_ALLOWED"], promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"),
      recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c") },
    })).rejects.toThrow("environment");
    expect(runCase).not.toHaveBeenCalled();
  });

  it("does not allow eval and holdout cases to cross the observation boundary", async () => {
    const runCase: ObservationCaseRunner = vi.fn(async () => result);
    await expect(observeQualitySet({
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: observationConfig,
      corpusSha256: hash("f"), runnerVersion: 2, cases: [sampleCase("holdout")],
      dependencies: { runCase }, environment: {}, allowedEnvironment: [], promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"),
      recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c") },
    })).rejects.toThrow("set");
  });

  it("fails recorded replay on a fingerprint mismatch and requires live for a changed prompt/model", async () => {
    const runCase: ObservationCaseRunner = vi.fn(async () => result);
    const base = {
      set: "eval" as const, mode: "candidate" as const, commitSha: "a".repeat(40), config: observationConfig,
      corpusSha256: hash("f"), runnerVersion: 2, cases: [sampleCase()], dependencies: { runCase },
      environment: {}, allowedEnvironment: [], promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"),
    };
    await expect(observeQualitySet({ ...base, recorded: { promptFingerprint: hash("c"), modelFingerprint: hash("b"), requestFingerprint: hash("c") } }))
      .rejects.toThrow("live");
    await expect(observeQualitySet({ ...base, recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c") }, promptFingerprint: hash("d") }))
      .rejects.toThrow("live");
    await expect(observeQualitySet({ ...base, recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("d") } }))
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
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: observationConfig,
      corpusSha256: hash("f"), runnerVersion: 2, cases: [sampleCase()], dependencies: { runCase, publish },
      environment: {}, allowedEnvironment: [], live: true, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"),
    });
    expect(names).toEqual(["live-1", "live-2", "live-3"]);
    expect(observation.cases[0].metrics).toEqual(result.metrics);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it("publishes and reads all named attempts with a verified artifact digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-attempts-"));
    const observation = await observeQualitySet({
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: observationConfig, corpusSha256: hash("f"), runnerVersion: 2,
      cases: [sampleCase()], root, live: true, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), environment: {}, allowedEnvironment: [],
      dependencies: { runCase: vi.fn(async () => result) },
    });
    const attempts = await readObservationAttempts(observation.observationId, root);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((item) => item.attemptName)).toEqual(["live-1", "live-2", "live-3"]);
    expect(JSON.parse(Buffer.from((await readBundle("observation", observation.observationId, root)).get("manifest.json")!).toString("utf8"))).toMatchObject({ live: true, mode: "baseline", caseVersions: [sampleCase().caseVersion], attemptCount: 3 });
  });

  it("rejects an observation result for a case outside the manifest membership set", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-membership-"));
    const id = `observation:sha256:${"a".repeat(64)}`;
    const line = canonicalJson({ caseVersion: "case:unknown", attemptName: "recorded", result: { schemaVersion: 1, caseVersion: "case:unknown", disposition: "positive", subsystem: "selection", status: "ok", metrics: { approvedMomentRetained: 1 } } });
    const results = `${line}\n`;
    const manifest = { schemaVersion: 1, observationId: id, set: "eval", mode: "baseline", live: false, caseVersions: [sampleCase().caseVersion], commitSha: "a".repeat(40), configSha256: hash("a"), corpusSha256: hash("b"), runnerVersion: 2, createdAt: "2026-08-31T00:00:00.000Z", attemptCount: 1, attemptsSha256: sha256(results) };
    await publishBundle({ kind: "observation", id, files: { "manifest.json": Buffer.from(`${canonicalJson(manifest)}\n`), "results.jsonl": Buffer.from(results) } }, root);
    await expect(readObservationAttempts(id, root)).rejects.toThrow("invalid_input");
  });

  it("rejects an incomplete manifest before consuming its attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-manifest-"));
    const id = `observation:sha256:${"b".repeat(64)}`;
    const results = `${canonicalJson({ caseVersion: sampleCase().caseVersion, attemptName: "recorded", result: { schemaVersion: 1, caseVersion: sampleCase().caseVersion, disposition: "positive", subsystem: "selection", status: "ok", metrics: { approvedMomentRetained: 1 } } })}\n`;
    const manifest = { schemaVersion: 1, observationId: id, set: "eval", mode: "baseline", live: false, caseVersions: [sampleCase().caseVersion], commitSha: "a".repeat(40), configSha256: hash("a"), corpusSha256: hash("b"), runnerVersion: 2, attemptCount: 1, attemptsSha256: sha256(results) };
    await publishBundle({ kind: "observation", id, files: { "manifest.json": Buffer.from(canonicalJson(manifest)), "results.jsonl": Buffer.from(results) } }, root);
    await expect(readObservationAttempts(id, root)).rejects.toThrow("invalid_input");
  });

  it("rejects an observation attempt wrapper with extra enumerable data", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-wrapper-"));
    const id = `observation:sha256:${"a".repeat(64)}`;
    const result = { schemaVersion: 1, caseVersion: sampleCase().caseVersion, disposition: "positive", subsystem: "selection", status: "ok", metrics: { approvedMomentRetained: 1 } };
    const results = `${canonicalJson({ caseVersion: sampleCase().caseVersion, attemptName: "recorded", result, extra: "reject" })}\n`;
    const manifest = { schemaVersion: 1, observationId: id, set: "eval", mode: "baseline", live: false, caseVersions: [sampleCase().caseVersion], commitSha: "a".repeat(40), configSha256: hash("a"), corpusSha256: hash("b"), runnerVersion: 2, createdAt: "2026-08-31T00:00:00.000Z", attemptCount: 1, attemptsSha256: sha256(results) };
    await publishBundle({ kind: "observation", id, files: { "manifest.json": Buffer.from(`${canonicalJson(manifest)}\n`), "results.jsonl": Buffer.from(results) } }, root);
    await expect(readObservationAttempts(id, root)).rejects.toThrow("invalid_input");
  });

  it("publishes missing input as an error result instead of silently skipping the case", async () => {
    const publish = vi.fn(async () => ({ status: "committed" as const }));
    const observation = await observeQualitySet({
      set: "eval", mode: "baseline", commitSha: "a".repeat(40), config: observationConfig,
      corpusSha256: hash("f"), runnerVersion: 2, cases: [sampleCase()], dependencies: {
        publish, runCase: vi.fn(async () => { throw new Error("input missing"); }),
      }, environment: {}, allowedEnvironment: [], promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"),
      recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c") },
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
    await writeFile(path, JSON.stringify({ schemaVersion: 1, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c") }, envAllowlist: [], engine: {} }), { mode: 0o600 });
    expect(await readSecureConfig(path)).toMatchObject({ schemaVersion: 1, runnerVersion: 2 });
    expect(() => validateObservationConfig({ schemaVersion: 1, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), envAllowlist: [], engine: {} }, false)).toThrow("invalid_flag");
    expect(() => validateObservationConfig({ schemaVersion: 1, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), envAllowlist: [], engine: {} }, true)).not.toThrow();
    expect(() => validateObservationConfig({ schemaVersion: 1, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), envAllowlist: [], engine: {} }, true)).toThrow("invalid_flag");
    expect(() => validateObservationConfig({ schemaVersion: 1, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), recorded: { promptFingerprint: hash("a"), modelFingerprint: hash("b") }, envAllowlist: [], engine: {} }, false)).toThrow("fingerprint");
  });

  it("loads only active, committed case bundles for the requested set and derives their digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-corpus-"));
    const { caseVersion: _ignored, ...body } = sampleCase();
    const id = contentId("case", body);
    await publishBundle({ kind: "case", id, files: { "case.json": Buffer.from(JSON.stringify({ ...body, caseVersion: id }) + "\n"), "evidence.mp4": Buffer.from("video") } }, root);
    await appendLabelEvent({ schemaVersion: 1, eventId: "event-1", action: "label", caseVersion: id, set: "eval", disposition: "positive" }, root);
    const loaded = await loadPrivateCases("eval", root);
    expect(loaded.cases.map((item) => item.caseVersion)).toEqual([id]);
    expect(loaded.corpusSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const holdout = await loadPrivateCases("holdout", root);
    expect(holdout.cases).toHaveLength(0);
    expect(holdout.corpusSha256).toBe(loaded.corpusSha256);
    expect(await deriveQualityCorpusDigest(root)).toBe(loaded.corpusSha256);
  });

  it("takes one ledger snapshot for both sets before a concurrent mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-atomic-corpus-"));
    const ids: Record<"eval" | "holdout", string> = { eval: "", holdout: "" };
    for (const set of ["eval", "holdout"] as const) {
      const { caseVersion: _ignored, ...body } = sampleCase(set);
      ids[set] = contentId("case", body);
      await publishBundle({ kind: "case", id: ids[set], files: { "case.json": Buffer.from(JSON.stringify({ ...body, caseVersion: ids[set] }) + "\n"), "evidence.mp4": Buffer.from("video") } }, root);
      await appendLabelEvent({ schemaVersion: 1, eventId: `event-${set}`, action: "label", caseVersion: ids[set], set, disposition: "positive" }, root);
    }
    const mutableLedger = [...await readLabelEvents(root)];
    let reads = 0;
    const readOnce = async () => {
      reads += 1;
      const snapshot = [...mutableLedger];
      mutableLedger.splice(0, mutableLedger.length);
      return snapshot;
    };
    const snapshot = await loadQualityCorpusSnapshot(root, readOnce);
    expect(reads).toBe(1);
    expect(snapshot.evalCases.map((item) => item.caseVersion)).toEqual([ids.eval]);
    expect(snapshot.holdoutCases.map((item) => item.caseVersion)).toEqual([ids.holdout]);
    expect(snapshot.corpusSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails the production loader closed when a labelled case bundle is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-missing-"));
    await appendLabelEvent({ schemaVersion: 1, eventId: "event-1", action: "label", caseVersion: `case:${hash("a")}`, set: "eval", disposition: "positive" }, root);
    const loaded = await loadPrivateCases("eval", root);
    expect(loaded.cases).toHaveLength(1);
    expect((loaded.cases[0] as { loadStatus?: string }).loadStatus).toBe("missing");
  });

  it("marks legacy overloaded source-or-evidence bundles stale instead of guessing its role", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-legacy-artifact-"));
    const { caseVersion: _ignored, ...body } = sampleCase();
    const id = contentId("case", body);
    await publishBundle({ kind: "case", id, files: { "case.json": Buffer.from(JSON.stringify({ ...body, caseVersion: id }) + "\n"), "source-or-evidence.mp4": Buffer.from("legacy") } }, root);
    await appendLabelEvent({ schemaVersion: 1, eventId: "event-legacy", action: "label", caseVersion: id, set: "eval", disposition: "positive" }, root);
    expect((await loadPrivateCases("eval", root)).cases[0]).toMatchObject({ caseVersion: id, loadStatus: "stale" });
  });

  it("marks a content-tampered case stale even when its directory name is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-tampered-"));
    const { caseVersion: _ignored, ...body } = sampleCase();
    const id = contentId("case", body);
    await publishBundle({ kind: "case", id, files: { "case.json": Buffer.from(JSON.stringify({ ...body, feedbackId: "tampered", caseVersion: id }) + "\n") } }, root);
    await appendLabelEvent({ schemaVersion: 1, eventId: "event-tampered", action: "label", caseVersion: id, set: "eval", disposition: "positive" }, root);
    expect((await loadPrivateCases("eval", root)).cases[0]).toMatchObject({ caseVersion: id, loadStatus: "stale" });
  });

  it("runs the real CLI loader and persists three independent live records", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-observe-cli-"));
    const { caseVersion: _ignored, ...body } = sampleCase();
    const id = contentId("case", body);
    await publishBundle({ kind: "case", id, files: { "case.json": Buffer.from(JSON.stringify({ ...body, caseVersion: id }) + "\n"), "evidence.mp4": Buffer.from("video") } }, root);
    await appendLabelEvent({ schemaVersion: 1, eventId: "event-cli", action: "label", caseVersion: id, set: "eval", disposition: "positive" }, root);
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), envAllowlist: [], engine: {} }), { mode: 0o600 });
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
        approvedMomentRetained: 1, approvedWindowOverlap: 1, contentMatch: 1,
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
        return { approvedMomentRetained: 1, approvedWindowOverlap: 0.8, contentMatch: 1, width: 1080, height: 1920, sar: 1, duration: 8, frameCount: 200, blackTailSeconds: 0, frozenTailSeconds: 0, subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, visualMeasured: true };
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

  it("renders the visual reference with the same crop plan but without ASS", async () => {
    const graphs: Array<string | undefined> = [];
    let cuts = 0;
    const { sourceWindow: _sourceWindow, ...visualExpected } = sampleCase().expected;
    const qualityCase = { ...sampleCase(), subsystem: "render" as const, expected: { ...visualExpected, visualSamples: [{ timestamp: 1, expectedSubtitleText: "", requiredSubjectBoxes: [], requiredTextBoxes: [], protectedExistingCaptionBoxes: [] }] } };
    await observeRenderCase(qualityCase, {
      sourcePath: "/private/source.mp4", immutableReferencePath: "/private/evidence.mp4", highlight: { start: 0, end: 2, title: "x" } as never, transcriptSegments: [],
      segmentsToCues: (() => [{ start: 0, end: 2, text: "hello" }]) as never,
      createAssFilter: (async () => ({ filter: "ass-filter", assPath: "/tmp/a.ass" })) as never,
      computeCropPlan: (async () => ({ plan: { version: 1, engine: "faces", source: { width: 1920, height: 1080 }, shots: [{ start: 0, end: 2, layout: "single", x: 420 }] }, shotCount: 1, detectMs: 1 })) as never,
      buildFiltergraph: ((_: unknown, ass: string | undefined) => { graphs.push(ass); return { graph: ass ?? "no-ass" }; }) as never,
      cutClips: (async () => { cuts += 1; return [{ clipPath: `/tmp/out-${cuts}.mp4`, highlight: { start: 0, end: 2, title: "x" } }]; }) as never,
      probe: async (_path, _case, context) => { expect(context?.referencePath).toBe("/tmp/out-2.mp4"); return { approvedMomentRetained: 1, approvedWindowOverlap: 1, contentMatch: 1, width: 1080, height: 1920, sar: 1, duration: 2, frameCount: 60, blackTailSeconds: 0, frozenTailSeconds: 0, subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, focalFailures: 0, visualMeasured: true }; },
    });
    expect(graphs).toEqual(["ass-filter", undefined]);
    expect(cuts).toBe(2);
  });

  it("fails the render gate for wrong content even when duration and geometry match", async () => {
    const qualityCase = { ...sampleCase(), subsystem: "render" as const, expected: { ...sampleCase().expected, visualSamples: [{ timestamp: 1, expectedSubtitleText: "", requiredSubjectBoxes: [], requiredTextBoxes: [], protectedExistingCaptionBoxes: [] }] } };
    const result = await observeRenderCase(qualityCase, {
      sourcePath: "/private/source.mp4", immutableReferencePath: "/private/evidence.mp4", highlight: { start: 0, end: 2, title: "x" } as never, transcriptSegments: [],
      segmentsToCues: (() => []) as never,
      computeCropPlan: (async () => ({ plan: null, shotCount: 0, detectMs: 0 })) as never,
      cutClips: (async () => [{ clipPath: "/tmp/wrong-content.mp4", highlight: { start: 0, end: 2, title: "x" } }]) as never,
      probe: async () => ({ approvedMomentRetained: 0, approvedWindowOverlap: 1, contentMatch: 0, width: 1080, height: 1920, sar: 1, duration: 2, frameCount: 60, blackTailSeconds: 0, frozenTailSeconds: 0, subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, focalFailures: 0, visualMeasured: true }),
    });
    expect(result.metrics).toMatchObject({ approvedMomentRetained: 0, hardInvariantFailures: 1 });
  });

  it("uses actual selected highlight metrics and rejects missing production telemetry", async () => {
    const qualityCase = sampleCase();
    const transcript = { text: "hello world", segments: [{ start: 0, end: 10, text: "hello world", words: [] }] } as never;
    await expect(observeSelectionCase(qualityCase, { transcript, analyze: async () => ({ highlights: [{ start: 1, end: 8, hookStart: 3, payoffAt: 6, score: 0.7 }], telemetry: {} }) })).rejects.toThrow("telemetry");
    const selected = await observeSelectionCase(qualityCase, { transcript, analyze: async () => ({ highlights: [{ start: 1, end: 8, hookStart: 3, payoffAt: 6, score: 0.7, lowQuality: true }], telemetry: { kept: 1, criticVerdicts: 1, omittedDrops: 0, truncatedDrops: 0, refusalDrops: 0, invariantDrops: 0 } }) });
    expect(selected.metrics).toMatchObject({ hookDelay: 2, payoffContainment: 1, score: 0.7, lowQuality: 1 });
    expect(selected.metrics.boundaryErrors).toBe(0);
    expect(selected.metrics).not.toHaveProperty("focalFailures");
    expect(selected.metrics).not.toHaveProperty("subtitleFailures");
    await expect(observeSelectionCase(qualityCase, { transcript, analyze: async () => ({ highlights: [{ start: 1, end: 8, hookStart: 3 }], telemetry: { kept: 1, criticVerdicts: 1, omittedDrops: 0, truncatedDrops: 0, refusalDrops: 0, invariantDrops: 0, boundaryErrors: 0 } }) })).rejects.toThrow("highlight fields");
    const boundary = await observeSelectionCase(qualityCase, { transcript, analyze: async () => ({ highlights: [{ start: 1, end: 12, hookStart: 3, payoffAt: 6, score: 0.7 }], telemetry: { kept: 1, criticVerdicts: 1, omittedDrops: 0, truncatedDrops: 0, refusalDrops: 0, invariantDrops: 0 } }) });
    expect(boundary.metrics.boundaryErrors).toBeGreaterThan(0);
  });

  it("fails closed when visual probe annotations are unavailable", async () => {
    const clip = { start: 0, end: 10, title: "x" } as never;
    await expect(observeRenderCase({ ...sampleCase(), subsystem: "render" }, {
      sourcePath: "/private/source.mp4", highlight: clip, transcriptSegments: [], probe: async () => ({
        approvedMomentRetained: 1, approvedWindowOverlap: 1, contentMatch: 1,
        width: 1080, height: 1920, sar: 1, duration: 10, frameCount: 250, blackTailSeconds: 0, frozenTailSeconds: 0, subtitleOverlap: 0, requiredTextClipped: 0, requiredSubjectClipped: 0, visualMeasured: false,
      }), segmentsToCues: (() => []) as never, computeCropPlan: (async () => ({ plan: null, shotCount: 0, detectMs: 0 })) as never, cutClips: (async () => [{ clipPath: "/tmp/out.mp4", highlight: clip }]) as never,
    })).rejects.toThrow("visual probe unavailable");
  });

  it("measures annotated subject/text boxes and subtitle overlap from sampled frames", async () => {
    const calls: string[][] = [];
    const options: Array<Readonly<Record<string, unknown>> | undefined> = [];
    const exec: VisualProbeExec = vi.fn(async (_file: string, args: readonly string[], requestOptions) => {
      calls.push([...args]);
      options.push(requestOptions);
      if (args[0] === "-show_entries") return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920, nb_read_frames: "1" }] }), stderr: "" };
      if (args.some((arg) => arg.includes("ssim="))) return { stdout: "SSIM Y:1.000000 (inf)\n", stderr: "" };
      if (args.some((arg) => arg.includes("blend="))) return { stdout: "", stderr: "n:0 x1:600 x2:800 y1:192 y2:384\n" };
      return { stdout: "", stderr: "" };
    });
    const result = await measureVisualReplay("/tmp/render.mp4", {
      cropPlan: { version: 1, engine: "faces", source: { width: 1920, height: 1080 }, shots: [{ start: 0, end: 2, layout: "single", x: 420 }] },
      referencePath: "/tmp/reference.mp4",
      immutableReferencePath: "/tmp/evidence.mp4",
      highlightStart: 0,
      cues: [{ start: 0, end: 2, text: "hello" }],
      assPath: "/tmp/subtitles.ass",
      samples: [{ timestamp: 1, expectedSubtitleText: "hello", expectedSubtitleBox: { x: .5, y: .08, w: .3, h: .15 }, requiredSubjectBoxes: [{ x: .4, y: .2, w: .1, h: .1 }], requiredTextBoxes: [{ x: .4, y: .1, w: .1, h: .1 }], protectedExistingCaptionBoxes: [] }],
      exec,
    });
    expect(result.visualMeasured).toBe(true);
    expect(result.requiredSubjectClipped).toBe(0);
    expect(result.requiredTextClipped).toBe(0);
    expect(result.focalFailures).toBe(0);
    expect(result.subtitleOverlap).toBe(0);
    expect(calls.some((args) => args.includes("/tmp/render.mp4"))).toBe(true);
    expect(calls.some((args) => args.some((arg) => arg.includes("blend=all_mode=difference")))).toBe(true);
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((item) => item?.timeout === 15_000 && item.maxBuffer === 2 * 1024 * 1024)).toBe(true);
  });

  it("reports each annotated visual violation instead of defaulting it to zero", async () => {
    const exec: VisualProbeExec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === "-show_entries") return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920, nb_read_frames: "1" }] }), stderr: "" };
      if (args.some((arg) => arg.includes("ssim="))) return { stdout: "SSIM Y:0.100000 (0.1)\n", stderr: "" };
      if (args.some((arg) => arg.includes("blend="))) return { stdout: "", stderr: "n:0 x1:0 x2:1000 y1:0 y2:1000\n" };
      return { stdout: "", stderr: "" };
    });
    const result = await measureVisualReplay("/tmp/render.mp4", {
      cropPlan: { version: 1, engine: "faces", source: { width: 1920, height: 1080 }, shots: [{ start: 0, end: 2, layout: "single", x: 0 }] },
      referencePath: "/tmp/reference.mp4",
      immutableReferencePath: "/tmp/evidence.mp4",
      highlightStart: 0,
      assPath: "/tmp/subtitles.ass",
      samples: [{ timestamp: 1, expectedSubtitleText: "", requiredSubjectBoxes: [{ x: .9, y: .2, w: .1, h: .1 }], requiredTextBoxes: [{ x: .9, y: .2, w: .1, h: .1 }], protectedExistingCaptionBoxes: [{ x: .1, y: .1, w: .2, h: .2 }] }],
      exec,
    });
    expect(result.requiredSubjectClipped).toBeGreaterThan(0);
    expect(result.requiredTextClipped).toBeGreaterThan(0);
    expect(result.focalFailures).toBeGreaterThan(0);
    expect(result.contentMatch).toBe(0);
    expect(result.approvedMomentRetained).toBe(0);
    expect(result.subtitleOverlap).toBeGreaterThan(0);
  });

  it("fails when a required visual annotation or probe is unavailable", async () => {
    await expect(measureVisualReplay("/tmp/render.mp4", { referencePath: "/tmp/reference.mp4", immutableReferencePath: "/tmp/evidence.mp4", highlightStart: 0, cropPlan: null, samples: [], exec: vi.fn() })).rejects.toThrow("visual annotation");
    await expect(measureVisualReplay("/tmp/render.mp4", { referencePath: "/tmp/reference.mp4", immutableReferencePath: "/tmp/evidence.mp4", highlightStart: 0, cropPlan: null, samples: [{ timestamp: 0, expectedSubtitleText: "", requiredSubjectBoxes: [], requiredTextBoxes: [], protectedExistingCaptionBoxes: [] }], exec: vi.fn(async () => { throw new Error("ffmpeg missing"); }) })).rejects.toThrow("visual probe");
  });

  it("anchors retained content to immutable evidence, not the generated no-ASS reference", async () => {
    let comparisons = 0;
    const calls: Array<[string, readonly string[]]> = [];
    const exec: VisualProbeExec = vi.fn(async (_file: string, args: readonly string[]) => {
      calls.push([_file, args]);
      if (args[0] === "-show_entries") return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920, nb_read_frames: "1" }] }), stderr: "" };
      if (args.some((arg) => arg.includes("ssim="))) {
        comparisons += 1;
        return { stdout: `SSIM Y:${comparisons === 1 ? "0.100000" : "1.000000"}`, stderr: "" };
      }
      if (args.some((arg) => arg.includes("blend="))) return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const result = await measureVisualReplay("/tmp/candidate.mp4", {
      referencePath: "/tmp/generated-no-ass.mp4", immutableReferencePath: "/tmp/immutable-evidence.mp4", highlightStart: 0, cropPlan: null,
      samples: [{ timestamp: 0, expectedSubtitleText: "", requiredSubjectBoxes: [], requiredTextBoxes: [], protectedExistingCaptionBoxes: [] }], exec,
    });
    expect(result.contentMatch).toBe(0);
    expect(calls.some(([file, args]) => file === "ffmpeg" && args.includes("/tmp/immutable-evidence.mp4"))).toBe(true);
  });

  it("rejects a rendered cue whose text differs from frozen review text", async () => {
    const exec: VisualProbeExec = vi.fn(async (_file: string, args: readonly string[]) => args[0] === "-show_entries"
      ? { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920, nb_read_frames: "1" }] }), stderr: "" }
      : args.some((arg) => arg.includes("ssim=")) ? { stdout: "SSIM Y:1.000000", stderr: "" } : { stdout: "", stderr: "n:0 x1:500 x2:700 y1:300 y2:400" });
    await expect(measureVisualReplay("/tmp/candidate.mp4", {
      referencePath: "/tmp/no-ass.mp4", immutableReferencePath: "/tmp/evidence.mp4", highlightStart: 0, cropPlan: null, assPath: "/tmp/candidate.ass",
      cues: [{ start: 0, end: 1, text: "wrong" }], samples: [{ timestamp: 0, expectedSubtitleText: "expected", requiredSubjectBoxes: [], requiredTextBoxes: [], protectedExistingCaptionBoxes: [] }], exec,
    })).rejects.toThrow("subtitle text mismatch");
  });

  it("accepts correctly placed frozen subtitle text with content matching evidence", async () => {
    let comparisons = 0;
    const exec: VisualProbeExec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === "-show_entries") return { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920, nb_read_frames: "1" }] }), stderr: "" };
      if (args.some((arg) => arg.includes("ssim="))) { comparisons += 1; return { stdout: "SSIM Y:0.990000", stderr: "" }; }
      return { stdout: "", stderr: comparisons === 2 ? "n:0 x1:500 x2:700 y1:300 y2:400" : "" };
    });
    const result = await measureVisualReplay("/tmp/candidate.mp4", {
      referencePath: "/tmp/no-ass.mp4", immutableReferencePath: "/tmp/evidence.mp4", highlightStart: 0, cropPlan: null, assPath: "/tmp/candidate.ass",
      cues: [{ start: 0, end: 1, text: "{\\b1}Expected" }], samples: [{ timestamp: 0, expectedSubtitleText: "expected", expectedSubtitleBox: { x: .4, y: .1, w: .3, h: .2 }, requiredSubjectBoxes: [], requiredTextBoxes: [], protectedExistingCaptionBoxes: [] }], exec,
    });
    expect(result.visualMeasured).toBe(true);
    expect(result.contentMatch).toBe(1);
  });
});
