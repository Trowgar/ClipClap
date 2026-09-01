import { decideGate, type DecideGateInput, type GateDependencies } from "../feedback-quality/gate";
import { DEFAULT_QUALITY_ROOT } from "../feedback-quality/store";
import type { GatePolicy, QualityClaim } from "../feedback-quality/types";

export type GateCliArgs = Readonly<{
  baselineEvalObservationId: string;
  candidateEvalObservationId: string;
  baselineHoldoutObservationId: string;
  candidateHoldoutObservationId: string;
  claim: QualityClaim;
}>;

export type GateCommandIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: GateCommandIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };
const OBSERVATION_ID = /^observation:sha256:[0-9a-f]{64}$/;

export const DEFAULT_GATE_POLICY: GatePolicy = {
  schemaVersion: 1,
  policyVersion: "feedback-quality-gate-v2",
  claim: "non_regression_only",
  minimum: { evalPositive: 4, evalNegative: 6, holdoutPositive: 1, holdoutNegative: 2 },
};

export class GateCliError extends Error {
  constructor(readonly code: "unknown_flag" | "missing_flag" | "invalid_flag") { super(code); this.name = "GateCliError"; }
}

export function parseGateArgs(argv: readonly string[]): GateCliArgs {
  const values: Partial<Record<"baselineEvalObservationId" | "candidateEvalObservationId" | "baselineHoldoutObservationId" | "candidateHoldoutObservationId" | "claim", string>> = {};
  const flags: Record<string, keyof typeof values> = {
    "--baseline-eval": "baselineEvalObservationId",
    "--candidate-eval": "candidateEvalObservationId",
    "--baseline-holdout": "baselineHoldoutObservationId",
    "--candidate-holdout": "candidateHoldoutObservationId",
    "--claim": "claim",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flags[flag];
    if (!key) throw new GateCliError("unknown_flag");
    if (values[key] !== undefined) throw new GateCliError("invalid_flag");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new GateCliError("missing_flag");
    values[key] = value;
  }
  const ids = [values.baselineEvalObservationId, values.candidateEvalObservationId, values.baselineHoldoutObservationId, values.candidateHoldoutObservationId];
  if (ids.some((id) => !id || !OBSERVATION_ID.test(id)) || (values.claim !== "improvement" && values.claim !== "non-regression")) throw new GateCliError("invalid_flag");
  return {
    baselineEvalObservationId: values.baselineEvalObservationId!, candidateEvalObservationId: values.candidateEvalObservationId!,
    baselineHoldoutObservationId: values.baselineHoldoutObservationId!, candidateHoldoutObservationId: values.candidateHoldoutObservationId!,
    claim: values.claim === "non-regression" ? "non_regression_only" : "improvement",
  };
}

function safeLog(value: Record<string, unknown>): string {
  const allowed = ["operation", "decisionId", "verdict", "reasons"];
  const output: Record<string, unknown> = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = value[key];
  return JSON.stringify(output);
}

export async function runFeedbackQualityGate(
  argv: readonly string[],
  dependencies: GateDependencies & { io?: GateCommandIo; policy?: GatePolicy } = {},
): Promise<number> {
  const io = dependencies.io ?? processIo;
  let args: GateCliArgs;
  try { args = parseGateArgs(argv); } catch { io.stderr(safeLog({ operation: "gate", reasons: ["invalid_schema"] })); return 2; }
  try {
    const policy = { ...(dependencies.policy ?? DEFAULT_GATE_POLICY), claim: args.claim } as GatePolicy;
    const decision = await decideGate({ ...args, policy }, dependencies);
    const output = safeLog({ operation: "gate", decisionId: decision.decisionId, verdict: decision.verdict, reasons: decision.reasons });
    io[decision.verdict === "pass" ? "stdout" : "stderr"](output);
    return decision.verdict === "pass" ? 0 : 1;
  } catch (error) {
    io.stderr(safeLog({ operation: "gate", reasons: [error instanceof GateCliError ? error.code : "invalid_schema"] }));
    return 1;
  }
}

async function main(): Promise<void> {
  await runFeedbackQualityGate(process.argv.slice(2), { root: process.env.FEEDBACK_QUALITY_ROOT ?? process.env.QUALITY_ROOT ?? DEFAULT_QUALITY_ROOT });
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
