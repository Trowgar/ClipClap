import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { loadAnalyzeConfig, type AnalyzeConfig } from "../analyze-v2/config";
import { runOutcomeObservation, type MaterializedOutcomeLiveLane, type OutcomeObservationMode } from "../feedback-quality/outcome-observe";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { Sha256 } from "../feedback-learning/types";

const COMMIT = /^[0-9a-f]{40}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_LIVE_LANE_BYTES = 16 * 1024 * 1024;
const SAFE_LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type OutcomeObserveIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: OutcomeObserveIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };

type Arguments = Readonly<{ mode: OutcomeObservationMode; root: string; configFile: string; liveLaneName?: string; liveLaneFile?: string }>;
function parse(argv: readonly string[]): Arguments {
  if (argv[0] !== "--mode" || typeof argv[1] !== "string" || argv[2] !== "--root" || !argv[3]) throw new Error("invalid_arguments");
  if (argv[1] === "baseline" && argv.length === 6 && argv[4] === "--config-file" && argv[5]) return Object.freeze({ mode: "baseline", root: argv[3], configFile: argv[5] });
  if (argv[1] === "candidate" && argv.length === 6 && argv[4] === "--config-file" && argv[5]) return Object.freeze({ mode: "candidate", root: argv[3], configFile: argv[5] });
  if (argv[1].startsWith("live:") && argv.length === 8 && argv[4] === "--config-file" && argv[5] && argv[6] === "--live-lane-file" && argv[7]) {
    const name = argv[1].slice("live:".length);
    if (!SAFE_LANE.test(name)) throw new Error("invalid_arguments");
    return Object.freeze({ mode: "candidate", root: argv[3], configFile: argv[5], liveLaneName: name, liveLaneFile: argv[7] });
  }
  throw new Error("invalid_arguments");
}

async function readPrivateJson(path: string, maximum: number): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!path || path.includes("\0")) throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== 0o600 || initial.size <= 0 || initial.size > maximum) throw new Error();
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) { const item = await handle.read(bytes, offset, bytes.length - offset, null); if (!item.bytesRead) break; offset += item.bytesRead; }
    const final = await handle.stat();
    if (offset !== bytes.length || final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.nlink !== 1 || (final.mode & 0o7777) !== 0o600) throw new Error();
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch { throw new Error("private_file_invalid"); }
  finally { await handle?.close().catch(() => undefined); }
}

export async function readOutcomeObservationConfig(path: string): Promise<AnalyzeConfig> {
  try {
    const value = await readPrivateJson(path, MAX_CONFIG_BYTES);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(",") !== "config,engineFingerprint,schemaVersion" || Reflect.ownKeys(value).length !== 3) throw new Error();
    const envelope = value as Record<string, unknown>;
    if (envelope.schemaVersion !== 1 || typeof envelope.engineFingerprint !== "string" || !envelope.config || typeof envelope.config !== "object" || Array.isArray(envelope.config) || Object.getPrototypeOf(envelope.config) !== Object.prototype) throw new Error();
    const config = envelope.config as Record<string, unknown>;
    const defaults = loadAnalyzeConfig({}) as unknown as Record<string, unknown>;
    const baseKeys = Object.keys(defaults).sort();
    const thresholdedHook = config.postBoundaryHookGateMode === "shadow" || config.postBoundaryHookGateMode === "enforce";
    const expectedKeys = [...baseKeys, ...(thresholdedHook ? ["postBoundaryHookMaxDelaySec", "postBoundaryHookMaxPreHookGapSec"] : [])].sort();
    if (Object.keys(config).sort().join(",") !== expectedKeys.join(",") || Reflect.ownKeys(config).length !== expectedKeys.length) throw new Error();
    for (const key of baseKeys) {
      const expected = defaults[key];
      const actual = config[key];
      if (typeof actual !== typeof expected || (typeof actual === "number" && !Number.isFinite(actual))) throw new Error();
    }
    if (thresholdedHook && (!Number.isFinite(config.postBoundaryHookMaxDelaySec) || (config.postBoundaryHookMaxDelaySec as number) < 0 || !Number.isFinite(config.postBoundaryHookMaxPreHookGapSec) || (config.postBoundaryHookMaxPreHookGapSec as number) < 0)) throw new Error();
    const enumValues: Readonly<Record<string, readonly string[]>> = {
      engine: ["legacy", "recall-critic", "shadow"],
      visualRecallMode: ["off", "shadow", "on"],
      outcomeRecoveryMode: ["off", "shadow", "on"],
      scanWindowBudget: ["speech", "source"],
      postBoundaryHookGateMode: ["off", "observe", "shadow", "enforce"],
      safeEndAuditMode: ["off", "shadow"],
    };
    for (const [key, allowed] of Object.entries(enumValues)) if (!allowed.includes(config[key] as string)) throw new Error();
    for (const actual of Object.values(config)) if (typeof actual === "string" && (actual.length === 0 || actual.length > 256)) throw new Error();
    if (config.outcomeRecoveryMode !== "off" && config.outcomeRecoveryMode !== "shadow" && config.outcomeRecoveryMode !== "on") throw new Error();
    if (!Number.isSafeInteger(config.outcomeRecoveryMaxCandidates) || (config.outcomeRecoveryMaxCandidates as number) < 1 || (config.outcomeRecoveryMaxCandidates as number) > 12 || !Number.isSafeInteger(config.criticBatchSize) || (config.criticBatchSize as number) < (config.outcomeRecoveryMaxCandidates as number)) throw new Error();
    if (envelope.engineFingerprint !== sha256(canonicalJson(config))) throw new Error();
    return Object.freeze({ ...config }) as unknown as AnalyzeConfig;
  } catch { throw new Error("private_config_invalid"); }
}

/** Compatibility export; both baseline and candidate now read the identical
 * closed envelope and baseline changes only the recovery mode in memory. */
export const readOutcomeCandidateConfig = readOutcomeObservationConfig;

export async function readOutcomeLiveLaneFile(path: string, expectedName: string): Promise<MaterializedOutcomeLiveLane> {
  try {
    const value = await readPrivateJson(path, MAX_LIVE_LANE_BYTES);
    if (!value || typeof value !== "object" || (value as { name?: unknown }).name !== expectedName) throw new Error();
    return value as MaterializedOutcomeLiveLane;
  } catch { throw new Error("private_live_lane_invalid"); }
}

type ExecuteInput = Readonly<{ root: string; mode: OutcomeObservationMode; configFile: string; commitSha: string; liveLaneName?: string; liveLaneFile?: string }>;
type ExecuteResult = Readonly<{ observationId: Sha256; mode: OutcomeObservationMode; caseCount: number }>;
type Dependencies = Readonly<{
  execute(input: ExecuteInput): Promise<ExecuteResult>;
  commitSha: string | undefined;
  io?: OutcomeObserveIo;
}>;

function aggregateLine(value: Readonly<Record<string, unknown>>): string {
  const allowed = ["operation", "status", "mode", "caseCount", "reason"];
  return JSON.stringify(Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]])));
}

export async function runOutcomeObserve(argv: readonly string[], dependencies: Dependencies): Promise<number> {
  const io = dependencies.io ?? processIo;
  let args: Arguments;
  try {
    args = parse(argv);
    if (!dependencies.commitSha || !COMMIT.test(dependencies.commitSha)) throw new Error();
  } catch {
    io.stderr(aggregateLine({ operation: "outcome-observe", reason: "invalid_arguments" }));
    return 2;
  }
  try {
    const result = await dependencies.execute({ ...args, commitSha: dependencies.commitSha });
    io.stdout(aggregateLine({ operation: "outcome-observe", status: "committed", mode: result.mode, caseCount: result.caseCount }));
    return 0;
  } catch (error) {
    const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error && error.message === "private_config_invalid" ? error.message : "observation_failed";
    io.stderr(aggregateLine({ operation: "outcome-observe", reason }));
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runOutcomeObserve(process.argv.slice(2), {
    commitSha: process.env.CLIPCLAP_COMMIT_SHA,
    execute: async ({ root, mode, configFile, commitSha, liveLaneFile, liveLaneName }) => runOutcomeObservation({
      root: join(root, "outcomes"), mode, commitSha,
      config: await readOutcomeObservationConfig(configFile!),
      ...(liveLaneFile ? { liveLane: await readOutcomeLiveLaneFile(liveLaneFile, liveLaneName!) } : {}),
    }),
  });
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
