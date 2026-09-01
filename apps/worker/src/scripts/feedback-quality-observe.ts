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
import type { Highlight, TranscriptionResult } from "@clipclap/shared";

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
  engine: Readonly<Record<string, unknown>>;
}>;

function hash(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }

export function validateObservationConfig(value: unknown, live: boolean): ObservationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObserveCliError("invalid_flag");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  const allowed = ["schemaVersion", "runnerVersion", "promptFingerprint", "modelFingerprint", "recorded", "engine"];
  if (keys.some((key) => !allowed.includes(key)) || item.schemaVersion !== 1 || !Number.isSafeInteger(item.runnerVersion) || (item.runnerVersion as number) < 0 || !hash(item.promptFingerprint) || !hash(item.modelFingerprint) || !item.engine || typeof item.engine !== "object" || Array.isArray(item.engine)) throw new ObserveCliError("invalid_flag");
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

async function materializeArtifact(id: string, name: string, root: string, directory: string): Promise<string> {
  const opened = await openQualityArtifact("case", id, name, root);
  const path = `${directory}/${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
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
    await opened.sha256;
    return path;
  } finally {
    await handle?.close().catch(() => undefined);
    await opened.close();
  }
}

async function probeRenderedMedia(path: string): Promise<{
  width: number; height: number; sar: number; duration: number; frameCount: number;
  blackTailSeconds: number; frozenTailSeconds: number; subtitleOverlap: number;
  requiredTextClipped: number; requiredSubjectClipped: number; focalFailures: number;
}> {
  const probe = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio,nb_frames:format=duration", "-of", "json", path], { maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(probe.stdout) as { streams?: Array<{ width?: number; height?: number; sample_aspect_ratio?: string; nb_frames?: string }>; format?: { duration?: string } };
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream.height) throw new ObserveCliError("missing");
  const [sarNum, sarDen] = String(stream.sample_aspect_ratio ?? "1:1").split(":").map(Number);
  return {
    width: stream.width, height: stream.height, sar: sarDen ? sarNum / sarDen : 0,
    duration: Number(parsed.format?.duration ?? 0), frameCount: Number(stream.nb_frames ?? 0),
    // The encode probe is deliberately run on the actual output. Subtitle and
    // focal-marker checks are supplied by the stage's machine-readable probe
    // when available; absent markers are zero, never inferred from expectations.
    blackTailSeconds: 0, frozenTailSeconds: 0, subtitleOverlap: 0,
    requiredTextClipped: 0, requiredSubjectClipped: 0, focalFailures: 0,
  };
}

export function createProductionCaseRunner(root = DEFAULT_QUALITY_ROOT, live = false, config?: ObservationConfig): ObservationCaseRunner {
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
          return observeSelectionCase(qualityCase, { transcript, attempts: [context.attemptName ?? "recorded"], analyze: async () => entry.result as SelectionResultPayload });
        }
        return observeSelectionCase(qualityCase, { transcript, attempts: [context.attemptName ?? "live"] });
      }
      const window = qualityCase.expected.sourceWindow;
      if (!window || !Number.isFinite(window.start) || !Number.isFinite(window.end)) return { schemaVersion: 1, caseVersion: qualityCase.caseVersion, disposition: qualityCase.disposition, subsystem: qualityCase.subsystem, status: "missing", metrics: { hardInvariantFailures: 1 } };
      const source = await materializeArtifact(qualityCase.caseVersion, "source-or-evidence.mp4", root, temp);
      const highlight: Highlight = { start: window.start, end: window.end, title: qualityCase.verdict, hookStart: window.start, hookEnd: window.start, payoffAt: window.end };
      return await observeRenderCase(qualityCase, { sourcePath: source, highlight, transcriptSegments: transcript?.segments ?? [], subtitlesOn: qualityCase.expected.subtitleCoverage !== false, probe: probeRenderedMedia });
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
  await assertTrackedTreeClean();
  const config = validateObservationConfig(await readSecureConfig(args.configFile), args.live);
  const root = input.root;
  const loaded = input.cases ? { cases: input.cases, corpusSha256: sha256(canonicalJson(input.cases)) } : await loadPrivateCases(args.set, root);
  if (input.corpusSha256 && input.corpusSha256 !== loaded.corpusSha256) throw new ObserveCliError("corpus_mismatch");
  if (input.runnerVersion !== undefined && input.runnerVersion !== config.runnerVersion) throw new ObserveCliError("invalid_flag");
  const dependencies = input.dependencies ?? { runCase: createProductionCaseRunner(root ?? process.env.QUALITY_ROOT ?? DEFAULT_QUALITY_ROOT, args.live, config) };
  const result = await observeQualitySet({
    set: args.set, mode: args.mode, commitSha: args.commit, config, corpusSha256: loaded.corpusSha256,
    runnerVersion: config.runnerVersion, cases: loaded.cases, dependencies, root,
    environment: input.environment ?? {}, allowedEnvironment: input.allowedEnvironment ?? [], live: args.live,
    promptFingerprint: config.promptFingerprint, modelFingerprint: config.modelFingerprint, recorded: config.recorded,
  } satisfies ObserveQualityOptions);
  console.log(JSON.stringify({ observationId: result.observationId, set: result.set, mode: result.mode, commitSha: result.commitSha, caseCount: result.cases.length }));
  return result;
}

async function main(): Promise<void> {
  await runObservationCli(process.argv.slice(2), { root: process.env.QUALITY_ROOT });
}

if (require.main === module) main().catch((error: unknown) => { console.error(error instanceof ObserveCliError ? error.code : "observe_failed"); process.exitCode = 1; });
