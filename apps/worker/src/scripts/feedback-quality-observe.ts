import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { observeQualitySet, type ObservationDependencies, type ObserveQualityOptions } from "../feedback-quality/observe";
import type { MaterializedCase } from "../feedback-quality/promote";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";

const execFileAsync = promisify(execFile);
const HEX40 = /^[0-9a-f]{40}$/;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

export type ObserveCliArgs = Readonly<{ set: "eval" | "holdout"; mode: "baseline" | "candidate"; commit: string; configFile: string; live: boolean }>;

export class ObserveCliError extends Error {
  constructor(readonly code: "unknown_flag" | "missing_flag" | "invalid_flag" | "insecure_config" | "dirty_tree" | "runtime_missing") {
    super(code);
    this.name = "ObserveCliError";
  }
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

/** CLI orchestration is injected at the corpus boundary so unit tests never
 * invoke ffmpeg/network. Production wiring supplies the materialized cases and
 * the adapters after the private store has been read. */
export async function runObservationCli(
  argv: readonly string[],
  input: Readonly<{ cases: readonly MaterializedCase[]; dependencies: ObservationDependencies; corpusSha256?: `sha256:${string}`; runnerVersion: number; environment?: Readonly<Record<string, string | undefined>>; allowedEnvironment?: readonly string[]; root?: string }>,
): Promise<Awaited<ReturnType<typeof observeQualitySet>>> {
  const args = parseObserveArgs(argv);
  await assertTrackedTreeClean();
  const config = await readSecureConfig(args.configFile);
  const result = await observeQualitySet({
    set: args.set, mode: args.mode, commitSha: args.commit, config, corpusSha256: sha256(canonicalJson(input.cases)),
    runnerVersion: input.runnerVersion, cases: input.cases, dependencies: input.dependencies, root: input.root,
    environment: input.environment ?? {}, allowedEnvironment: input.allowedEnvironment ?? [], live: args.live,
  } satisfies ObserveQualityOptions);
  console.log(JSON.stringify({ observationId: result.observationId, set: result.set, mode: result.mode, commitSha: result.commitSha, caseCount: result.cases.length }));
  return result;
}

async function main(): Promise<void> {
  throw new ObserveCliError("runtime_missing");
}

if (require.main === module) main().catch((error: unknown) => { console.error(error instanceof ObserveCliError ? error.code : "observe_failed"); process.exitCode = 1; });
