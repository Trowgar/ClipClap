import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { loadAnalyzeConfig, type AnalyzeConfig } from "../analyze-v2/config";
import { runOutcomeObservation, type OutcomeObservationMode } from "../feedback-quality/outcome-observe";
import type { Sha256 } from "../feedback-learning/types";

const COMMIT = /^[0-9a-f]{40}$/;
const MAX_CONFIG_BYTES = 16 * 1024;

export type OutcomeObserveIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: OutcomeObserveIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };

type Arguments = Readonly<{ mode: OutcomeObservationMode; root: string; configFile?: string }>;
function parse(argv: readonly string[]): Arguments {
  if (argv.length !== 4 && argv.length !== 6) throw new Error("invalid_arguments");
  if (argv[0] !== "--mode" || (argv[1] !== "baseline" && argv[1] !== "candidate") || argv[2] !== "--root" || !argv[3]) throw new Error("invalid_arguments");
  if (argv.length === 6 && (argv[4] !== "--config-file" || !argv[5])) throw new Error("invalid_arguments");
  if (argv[1] === "candidate" && argv.length !== 6) throw new Error("invalid_arguments");
  if (argv[1] === "baseline" && argv.length !== 4) throw new Error("invalid_arguments");
  return Object.freeze({ mode: argv[1], root: argv[3], ...(argv.length === 6 ? { configFile: argv[5] } : {}) });
}

async function readCandidateConfig(path: string): Promise<AnalyzeConfig> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!path || path.includes("\0")) throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== 0o600 || initial.size <= 0 || initial.size > MAX_CONFIG_BYTES) throw new Error();
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) { const item = await handle.read(bytes, offset, bytes.length - offset, null); if (!item.bytesRead) break; offset += item.bytesRead; }
    const final = await handle.stat();
    if (offset !== bytes.length || final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(",") !== "outcomeRecoveryMaxCandidates,outcomeRecoveryMode" || Reflect.ownKeys(value).length !== 2) throw new Error();
    const raw = value as Record<string, unknown>;
    if (raw.outcomeRecoveryMode !== "shadow" && raw.outcomeRecoveryMode !== "on") throw new Error();
    if (!Number.isSafeInteger(raw.outcomeRecoveryMaxCandidates) || (raw.outcomeRecoveryMaxCandidates as number) < 1 || (raw.outcomeRecoveryMaxCandidates as number) > 12) throw new Error();
    return { ...loadAnalyzeConfig({}), outcomeRecoveryMode: raw.outcomeRecoveryMode, outcomeRecoveryMaxCandidates: raw.outcomeRecoveryMaxCandidates as number };
  } catch { throw new Error("private_config_invalid"); }
  finally { await handle?.close().catch(() => undefined); }
}

type ExecuteInput = Readonly<{ root: string; mode: OutcomeObservationMode; configFile?: string; commitSha: string }>;
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
    execute: async ({ root, mode, configFile, commitSha }) => runOutcomeObservation({
      root: join(root, "outcomes"), mode, commitSha,
      config: mode === "baseline" ? loadAnalyzeConfig({}) : await readCandidateConfig(configFile!),
    }),
  });
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
