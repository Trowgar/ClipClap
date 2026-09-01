import { deployWithQualityGate, type DeployDependencies, type DeployRequest, type WorkerService } from "../feedback-quality/deploy";
import { DEFAULT_QUALITY_ROOT } from "../feedback-quality/store";

export type DeployCliArgs = Readonly<{ decisionId: string; services: readonly WorkerService[]; overrideReasonFile?: string }>;
export type DeployCommandIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: DeployCommandIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };
const ID = /^decision:sha256:[0-9a-f]{64}$/;
const SERVICES = new Set(["worker-download", "worker-transcribe", "worker-analyze", "worker-render", "worker-finalize"]);

export class DeployCliError extends Error {
  constructor(readonly code: "unknown_flag" | "missing_flag" | "invalid_flag") { super(code); this.name = "DeployCliError"; }
}

export function parseDeployArgs(argv: readonly string[]): DeployCliArgs {
  let decisionId: string | undefined;
  let overrideReasonFile: string | undefined;
  const services: WorkerService[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--decision") {
      if (decisionId !== undefined) throw new DeployCliError("invalid_flag");
      decisionId = argv[++index];
      if (!decisionId || decisionId.startsWith("--")) throw new DeployCliError("missing_flag");
    } else if (flag === "--service") {
      const service = argv[++index];
      if (!service || service.startsWith("--")) throw new DeployCliError("missing_flag");
      if (!SERVICES.has(service)) throw new DeployCliError("invalid_flag");
      services.push(service as WorkerService);
    } else if (flag === "--override-reason-file") {
      if (overrideReasonFile !== undefined) throw new DeployCliError("invalid_flag");
      overrideReasonFile = argv[++index];
      if (!overrideReasonFile || overrideReasonFile.startsWith("--") || overrideReasonFile.includes("\0")) throw new DeployCliError("missing_flag");
    } else {
      throw new DeployCliError("unknown_flag");
    }
  }
  if (!decisionId || !ID.test(decisionId) || services.length === 0) throw new DeployCliError("invalid_flag");
  return { decisionId, services, ...(overrideReasonFile === undefined ? {} : { overrideReasonFile }) };
}

function safeLog(value: Record<string, unknown>): string {
  const allowed = ["operation", "decisionId", "status", "verdict", "overridden", "services", "recreatedServices", "reasons", "rollbackArtifactId", "rollbackArgv"];
  const output: Record<string, unknown> = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = value[key];
  return JSON.stringify(output);
}

export async function runFeedbackQualityDeploy(argv: readonly string[], dependencies: DeployDependencies & { io?: DeployCommandIo } = {}): Promise<number> {
  const io = dependencies.io ?? processIo;
  let args: DeployCliArgs;
  try { args = parseDeployArgs(argv); }
  catch { io.stderr(safeLog({ operation: "deploy", status: "failed", reasons: ["invalid_request"] })); return 2; }
  const result = await deployWithQualityGate(args, { ...dependencies, root: dependencies.root ?? process.env.FEEDBACK_QUALITY_ROOT ?? DEFAULT_QUALITY_ROOT });
  const line = safeLog({ operation: "deploy", decisionId: result.decisionId, status: result.status, verdict: result.verdict, overridden: result.overridden, services: result.services, recreatedServices: result.recreatedServices, reasons: result.reasons, rollbackArtifactId: result.rollbackArtifactId, rollbackArgv: result.rollbackArgv });
  io[result.status === "deployed" ? "stdout" : "stderr"](line);
  return result.status === "deployed" ? 0 : 1;
}

async function main(): Promise<void> {
  process.exitCode = await runFeedbackQualityDeploy(process.argv.slice(2), { root: process.env.FEEDBACK_QUALITY_ROOT ?? DEFAULT_QUALITY_ROOT });
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
