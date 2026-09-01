import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_QUALITY_ROOT } from "../feedback-quality/store";
import { observeQualitySet, type ObservationDependencies, type ObserveQualityOptions } from "../feedback-quality/observe";
import { loadPrivateCases, openQualityArtifact, type ObservationCaseRunner } from "../feedback-quality/observe";
import type { MaterializedCase } from "../feedback-quality/promote";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { observeSelectionCase, type SelectionResultPayload } from "../feedback-quality/selection-lane";
import { observeRenderCase } from "../feedback-quality/render-lane";
import { segmentsToCues } from "../processors/subtitles";
import { measureVisualReplay, type VisualProbeExec } from "../feedback-quality/visual-probe";
import type { Highlight, TranscriptionResult } from "@clipclap/shared";
import OpenAI from "openai";
import { analyzeHighlightsV2, type AnalyzeV2Options } from "../analyze-v2";

const execFileAsync = promisify(execFile);
const HEX40 = /^[0-9a-f]{40}$/;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

export type ObserveCliArgs = Readonly<{ set: "eval" | "holdout"; mode: "baseline" | "candidate"; commit: string; configFile: string; live: boolean }>;

export class ObserveCliError extends Error {
  constructor(readonly code: "unknown_flag" | "missing_flag" | "invalid_flag" | "insecure_config" | "dirty_tree" | "runtime_missing" | "fingerprint" | "corpus_mismatch" | "missing") {
    super(code);
    this.name = "ObserveCliError";
  }
}

export type ObservationConfig = Readonly<{
  schemaVersion: 1;
  runnerVersion: number;
  promptFingerprint: `sha256:${string}`;
  modelFingerprint: `sha256:${string}`;
  recorded?: Readonly<{ promptFingerprint: `sha256:${string}`; modelFingerprint: `sha256:${string}` }>;
  envAllowlist: readonly string[];
  engine: Readonly<Record<string, unknown>>;
}>;

function hash(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }

export function validateObservationConfig(value: unknown, live: boolean): ObservationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObserveCliError("invalid_flag");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  const allowed = ["schemaVersion", "runnerVersion", "promptFingerprint", "modelFingerprint", "recorded", "envAllowlist", "engine"];
  if (keys.some((key) => !allowed.includes(key)) || item.schemaVersion !== 1 || !Number.isSafeInteger(item.runnerVersion) || (item.runnerVersion as number) < 0 || !hash(item.promptFingerprint) || !hash(item.modelFingerprint) || !Array.isArray(item.envAllowlist) || item.envAllowlist.some((key) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) || !item.engine || typeof item.engine !== "object" || Array.isArray(item.engine)) throw new ObserveCliError("invalid_flag");
  const engine = item.engine as Record<string, unknown>;
  if (Object.keys(engine).some((key) => !["analyze", "reframe", "musicDirection", "blackTail"].includes(key)) || (engine.analyze !== undefined && (!engine.analyze || typeof engine.analyze !== "object" || Array.isArray(engine.analyze))) || (engine.reframe !== undefined && (!engine.reframe || typeof engine.reframe !== "object" || Array.isArray(engine.reframe))) || (engine.musicDirection !== undefined && (!engine.musicDirection || typeof engine.musicDirection !== "object" || Array.isArray(engine.musicDirection))) || (engine.blackTail !== undefined && (!engine.blackTail || typeof engine.blackTail !== "object" || Array.isArray(engine.blackTail)))) throw new ObserveCliError("invalid_flag");
  if (item.recorded !== undefined) {
    if (!item.recorded || typeof item.recorded !== "object" || Array.isArray(item.recorded)) throw new ObserveCliError("fingerprint");
    const recorded = item.recorded as Record<string, unknown>;
    if (Object.keys(recorded).some((key) => key !== "promptFingerprint" && key !== "modelFingerprint") || !hash(recorded.promptFingerprint) || !hash(recorded.modelFingerprint)) throw new ObserveCliError("fingerprint");
  }
  if (!live && item.recorded === undefined) throw new ObserveCliError("fingerprint");
  return item as ObservationConfig;
}

export function parseObserveArgs(argv: readonly string[]): ObserveCliArgs {
  let set: ObserveCliArgs["set"] | undefined;
  let mode: ObserveCliArgs["mode"] | undefined;
  let commit: string | undefined;
  let configFile: string | undefined;
  let live = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--live") { if (live) throw new ObserveCliError("invalid_flag"); live = true; continue; }
    if (flag !== "--set" && flag !== "--mode" && flag !== "--commit" && flag !== "--config-file") throw new ObserveCliError("unknown_flag");
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new ObserveCliError("missing_flag");
    if (flag === "--set") set = value as ObserveCliArgs["set"];
    else if (flag === "--mode") mode = value as ObserveCliArgs["mode"];
    else if (flag === "--commit") commit = value;
    else configFile = value;
  }
  if (!set || !["eval", "holdout"].includes(set) || !mode || !["baseline", "candidate"].includes(mode) || !commit || !HEX40.test(commit) || !configFile || configFile.includes("\0")) throw new ObserveCliError("invalid_flag");
  return { set, mode, commit, configFile, live };
}

export async function readSecureConfig(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > MAX_CONFIG_BYTES) throw new ObserveCliError("insecure_config");
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const final = await handle.stat();
    if (offset !== info.size || final.size !== info.size || final.nlink !== 1) throw new ObserveCliError("insecure_config");
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw new ObserveCliError("invalid_flag"); }
  } catch (error) {
    if (error instanceof ObserveCliError) throw error;
    throw new ObserveCliError("insecure_config");
  } finally { await handle?.close().catch(() => undefined); }
}

export async function assertTrackedTreeClean(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"]);
    if (stdout.trim()) throw new ObserveCliError("dirty_tree");
  } catch (error) {
    if (error instanceof ObserveCliError) throw error;
    throw new ObserveCliError("dirty_tree");
  }
}

async function readArtifactJson(kind: "case", id: string, name: string, root: string): Promise<unknown> {
  const opened = await openQualityArtifact(kind, id, name, root);
  try {
    const reader = opened.stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 16 * 1024 * 1024) throw new ObserveCliError("invalid_flag");
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks.map((item) => Buffer.from(item))).toString("utf8"));
  } finally { await opened.close(); }
}

async function materializeArtifact(id: string, name: string, root: string, directory: string, destinationName = name, expectedSha256?: string): Promise<string> {
  const opened = await openQualityArtifact("case", id, name, root);
  const path = `${directory}/${destinationName.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
    const reader = opened.stream.getReader();
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        let offset = 0;
        while (offset < item.value.byteLength) {
          const write = await handle.write(item.value, offset, item.value.byteLength - offset, null);
          if (!write.bytesWritten) throw new ObserveCliError("missing");
          offset += write.bytesWritten;
        }
      }
    } finally { reader.releaseLock(); }
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size !== opened.size) throw new ObserveCliError("missing");
    await handle.close(); handle = undefined;
    const digest = await opened.sha256;
    if (expectedSha256 && digest !== expectedSha256) throw new ObserveCliError("missing");
    return path;
  } finally {
    await handle?.close().catch(() => undefined);
    await opened.close();
  }
}

async function probeRenderedMedia(path: string, context: Readonly<{ cropPlan: import("../reframe/types").CropPlan | null; assPath?: string; cues: readonly unknown[]; samples: readonly import("../feedback-quality/promote").VisualSample[]; referencePath: string; immutableReferencePath: string; highlightStart: number; contentThreshold?: number }>): Promise<{
  width: number; height: number; sar: number; duration: number; frameCount: number;
  approvedMomentRetained: number; approvedWindowOverlap: number; contentMatch: number;
  blackTailSeconds: number; frozenTailSeconds: number; subtitleOverlap: number;
  requiredTextClipped: number; requiredSubjectClipped: number; focalFailures: number; visualMeasured: boolean;
}> {
  const probe = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio,nb_frames:format=duration", "-of", "json", path], { maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(probe.stdout) as { streams?: Array<{ width?: number; height?: number; sample_aspect_ratio?: string; nb_frames?: string }>; format?: { duration?: string } };
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream.height) throw new ObserveCliError("missing");
  const [sarNum, sarDen] = String(stream.sample_aspect_ratio ?? "1:1").split(":").map(Number);
  const duration = Number(parsed.format?.duration ?? 0);
  let diagnostics = "";
  try {
    const result = await execFileAsync("ffmpeg", ["-nostdin", "-v", "info", "-i", path, "-vf", "blackdetect=d=0.1,freezedetect=n=0.003:d=0.5", "-an", "-f", "null", "-"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    diagnostics = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  } catch (error) {
    // A failed/timed-out diagnostics probe cannot be interpreted as a clean
    // render. Let the observer publish an error result instead of turning an
    // unavailable black/freeze measurement into a zero.
    void error;
    throw new ObserveCliError("missing");
  }
  const blackTail = [...diagnostics.matchAll(/black_start:([\d.]+).*?black_end:([\d.]+).*?black_duration:([\d.]+)/g)]
    .map((match) => ({ end: Number(match[2]), duration: Number(match[3]) }))
    .filter((item) => duration - item.end <= 0.12)
    .reduce((max, item) => Math.max(max, item.duration), 0);
  const frozenTail = [...diagnostics.matchAll(/freeze_start:([\d.]+)/g)]
    .map((match) => Math.max(0, duration - Number(match[1])))
    .reduce((max, value) => Math.max(max, value), 0);
  const visualExec: VisualProbeExec = async (file, args, options) => {
    const result = await execFileAsync(file, [...args], { ...(options ?? {}) } as never);
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  };
  const visual = await measureVisualReplay(path, { referencePath: context.referencePath, immutableReferencePath: context.immutableReferencePath, highlightStart: context.highlightStart, cropPlan: context.cropPlan, assPath: context.assPath, cues: context.cues, samples: context.samples, contentThreshold: context.contentThreshold, exec: visualExec });
  return {
    width: stream.width, height: stream.height, sar: sarDen ? sarNum / sarDen : 0,
    duration, frameCount: Number(stream.nb_frames ?? 0),
    approvedMomentRetained: visual.approvedMomentRetained, approvedWindowOverlap: visual.approvedWindowOverlap, contentMatch: visual.contentMatch,
    blackTailSeconds: blackTail, frozenTailSeconds: frozenTail,
    subtitleOverlap: visual.subtitleOverlap, requiredTextClipped: visual.requiredTextClipped,
    requiredSubjectClipped: visual.requiredSubjectClipped, focalFailures: visual.focalFailures,
    visualMeasured: visual.visualMeasured,
  };
}

export function createProductionCaseRunner(root = DEFAULT_QUALITY_ROOT, live = false, config?: ObservationConfig, environment: Readonly<Record<string, string | undefined>> = {}): ObservationCaseRunner {
  return async (qualityCase, context) => {
    const loadStatus = (qualityCase as MaterializedCase & { loadStatus?: "missing" | "stale" }).loadStatus;
    if (loadStatus) return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: loadStatus, metrics: { hardInvariantFailures: 1 } };
    const bundle = await openQualityArtifact("case", qualityCase.caseVersion, "case.json", root).catch(() => undefined);
    if (!bundle) return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "missing", metrics: { hardInvariantFailures: 1 } };
    await bundle.close();
    const temp = await mkdtemp("/tmp/clipclap-quality-observe-");
    try {
      let transcript: TranscriptionResult | undefined;
      try { transcript = await readArtifactJson("case", qualityCase.caseVersion, "transcript.json", root) as TranscriptionResult; } catch { transcript = undefined; }
      if (qualityCase.subsystem === "selection" || qualityCase.subsystem === "boundary") {
        if (!transcript?.segments || !Array.isArray(transcript.segments)) return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "missing", metrics: { hardInvariantFailures: 1 } };
        if (!live) {
          let recording: unknown;
          try { recording = await readArtifactJson("case", qualityCase.caseVersion, "recorded-responses.json", root); } catch { return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "missing", metrics: { hardInvariantFailures: 1 } }; }
          const entry = recording as Record<string, unknown>;
          const recorded = entry.recorded as Record<string, unknown> | undefined;
          if (!config?.recorded || !recorded || recorded.promptFingerprint !== config.recorded.promptFingerprint || recorded.modelFingerprint !== config.recorded.modelFingerprint || !entry.result || typeof entry.result !== "object") return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "stale", metrics: { hardInvariantFailures: 1 } };
          return observeSelectionCase(qualityCase, { transcript, attempts: [context.attemptName ?? "recorded"], analyzeOptions: (config?.engine.analyze ?? {}) as AnalyzeV2Options, analyze: async () => entry.result as SelectionResultPayload });
        }
        const apiKey = environment.OPENAI_API_KEY;
        if (!apiKey) return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "error", metrics: { hardInvariantFailures: 1 } };
        const sourceDurationSec = qualityCase.inputs.sourceDurationSec ?? undefined;
        const sourceUrl = (qualityCase.replay as { sourceUrl?: string | null }).sourceUrl ?? undefined;
        const configuredAnalyze = (config?.engine.analyze ?? {}) as AnalyzeV2Options;
        const analyze = async (value: TranscriptionResult, options: AnalyzeV2Options) => analyzeHighlightsV2(value, { ...configuredAnalyze, ...options, client: new OpenAI({ apiKey }), sourceDurationSec, sourceUrl });
        return observeSelectionCase(qualityCase, { transcript, attempts: [context.attemptName ?? "live"], analyze, analyzeOptions: configuredAnalyze });
      }
      const replay = qualityCase.replay;
      const replayHighlight = replay?.highlight as (Highlight & { clipKind?: string | null }) | undefined;
      if (!replay || !replayHighlight || !Number.isFinite(replayHighlight.start) || !Number.isFinite(replayHighlight.end) || (!qualityCase.expected.referenceOnly && (!replay.reframeConfig || typeof replay.reframeConfig !== "object"))) return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "stale", metrics: { hardInvariantFailures: 1 } };
      if (qualityCase.expected.referenceOnly) {
        if (!["framing", "subtitles", "render"].includes(qualityCase.subsystem) || !qualityCase.replay.cropPlan || typeof qualityCase.replay.cropPlan !== "object") return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "stale", metrics: { hardInvariantFailures: 1 } };
        if (qualityCase.expected.visualSamples.some((sample) => sample.expectedSubtitleText.trim().length > 0)) return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "stale", metrics: { hardInvariantFailures: 1 } };
        const evidencePath = await materializeArtifact(qualityCase.caseVersion, "evidence.mp4", root, temp, "immutable-evidence.mp4", qualityCase.inputs.evidenceSha256);
        const cues = segmentsToCues(transcript?.segments ?? [], replayHighlight.start, replayHighlight.end, replayHighlight.language);
        const probe = await probeRenderedMedia(evidencePath, { cropPlan: qualityCase.replay.cropPlan as import("../reframe/types").CropPlan, cues, samples: qualityCase.expected.visualSamples, referencePath: evidencePath, immutableReferencePath: evidencePath, highlightStart: replayHighlight.start });
        const expectedDuration = Math.max(0.001, replayHighlight.end - replayHighlight.start);
        return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "ok", metrics: {
          referenceOnly: 1, approvedMomentRetained: qualityCase.expected.approvedMoment ? probe.approvedMomentRetained : 0, approvedWindowOverlap: qualityCase.expected.approvedMoment ? probe.approvedWindowOverlap : 0,
          hardInvariantFailures: probe.width === 1080 && probe.height === 1920 && probe.sar === 1 && probe.contentMatch === 1 && probe.requiredSubjectClipped === 0 && probe.requiredTextClipped === 0 ? 0 : 1,
          outputWidth: probe.width, outputHeight: probe.height, sar: probe.sar, durationDrift: Math.abs(probe.duration - expectedDuration), frameCount: probe.frameCount, blackTailSeconds: probe.blackTailSeconds, frozenTailSeconds: probe.frozenTailSeconds,
          subtitleOverlap: probe.subtitleOverlap, requiredTextClipped: probe.requiredTextClipped, requiredSubjectClipped: probe.requiredSubjectClipped, focalFailures: probe.focalFailures,
        } };
      }
      if (!qualityCase.inputs.sourceSha256) return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "stale", metrics: { hardInvariantFailures: 1 } };
      const immutableReferencePath = await materializeArtifact(qualityCase.caseVersion, "evidence.mp4", root, temp, "immutable-evidence.mp4", qualityCase.inputs.evidenceSha256);
      const source = await materializeArtifact(qualityCase.caseVersion, "source.mp4", root, temp, "source.mp4", qualityCase.inputs.sourceSha256);
      const musicDirection = (config?.engine.musicDirection ?? replay.musicDirection) && typeof (config?.engine.musicDirection ?? replay.musicDirection) === "object" ? (config?.engine.musicDirection ?? replay.musicDirection) as { topBar: number; bottomBar: number; punchIn: boolean; fades: boolean } : undefined;
      const blackTailValue = config?.engine.blackTail ?? replay.blackTail;
      const blackTailTrim = blackTailValue && typeof blackTailValue === "object" && (blackTailValue as { enabled?: unknown }).enabled === true ? { jobId: qualityCase.jobId, clipIndex: 0 } : undefined;
      const reframeConfig = config?.engine.reframe ?? replay.reframeConfig;
      return await observeRenderCase(qualityCase, { sourcePath: source, immutableReferencePath, highlight: replayHighlight, transcriptSegments: transcript?.segments ?? [], language: replayHighlight.language, subtitlesOn: replay.subtitleTrack !== null, reframeConfig: reframeConfig as never, musicDirection, musicFades: musicDirection?.fades, blackTailTrim, privateOutputPath: `${temp}/observed-output.mp4`, probe: (path, _case, context) => probeRenderedMedia(path, { ...context!, contentThreshold: qualityCase.disposition === "confirmed_negative" ? 0.9 : 0.98 }) });
    } finally { await rm(temp, { recursive: true, force: true }).catch(() => undefined); }
  };
}

/** CLI orchestration is injected at the corpus boundary so unit tests never
 * invoke ffmpeg/network. Production wiring supplies the materialized cases and
 * the adapters after the private store has been read. */
export async function runObservationCli(
  argv: readonly string[],
  input: Readonly<{ cases?: readonly MaterializedCase[]; dependencies?: ObservationDependencies; corpusSha256?: `sha256:${string}`; runnerVersion?: number; environment?: Readonly<Record<string, string | undefined>>; allowedEnvironment?: readonly string[]; root?: string }>,
): Promise<Awaited<ReturnType<typeof observeQualitySet>>> {
  const args = parseObserveArgs(argv);
  // The executable path always verifies tracked cleanliness. Injected
  // adapters are the bounded test seam and cannot publish to production.
  if (!input.dependencies) await assertTrackedTreeClean();
  const config = validateObservationConfig(await readSecureConfig(args.configFile), args.live);
  const root = input.root;
  const loaded = input.cases ? { cases: input.cases, corpusSha256: sha256(canonicalJson(input.cases)) } : await loadPrivateCases(args.set, root);
  if (input.corpusSha256 && input.corpusSha256 !== loaded.corpusSha256) throw new ObserveCliError("corpus_mismatch");
  if (input.runnerVersion !== undefined && input.runnerVersion !== config.runnerVersion) throw new ObserveCliError("invalid_flag");
  const environment = input.environment ?? Object.fromEntries(config.envAllowlist.map((key) => [key, process.env[key]]));
  const dependencies = input.dependencies ?? { runCase: createProductionCaseRunner(root ?? process.env.QUALITY_ROOT ?? DEFAULT_QUALITY_ROOT, args.live, config, environment) };
  const result = await observeQualitySet({
    set: args.set, mode: args.mode, commitSha: args.commit, config, corpusSha256: loaded.corpusSha256,
    runnerVersion: config.runnerVersion, cases: loaded.cases, dependencies, root,
    environment, allowedEnvironment: config.envAllowlist, live: args.live,
    promptFingerprint: config.promptFingerprint, modelFingerprint: config.modelFingerprint, recorded: config.recorded,
  } satisfies ObserveQualityOptions);
  console.log(JSON.stringify({ observationId: result.observationId, set: result.set, mode: result.mode, commitSha: result.commitSha, caseCount: result.cases.length }));
  return result;
}

async function main(): Promise<void> {
  await runObservationCli(process.argv.slice(2), { root: process.env.QUALITY_ROOT });
}

if (require.main === module) main().catch((error: unknown) => { console.error(error instanceof ObserveCliError ? error.code : "observe_failed"); process.exitCode = 1; });
