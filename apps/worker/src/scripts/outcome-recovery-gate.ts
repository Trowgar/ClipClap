import { dirname, join } from "node:path";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { decideOutcomeRecoveryGate } from "../feedback-quality/outcome-gate";
import { readOutcomeObservationConfig } from "./outcome-observe";

type Io = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const ioDefault: Io = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };

type Args = Readonly<{ root: string; baseline: `sha256:${string}`; candidate: `sha256:${string}`; clipDecision: string; configFile: string }>;
function parse(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!["--root", "--baseline", "--candidate", "--clip-decision", "--config-file"].includes(flag) || !value || value.startsWith("--") || values.has(flag)) throw new Error();
    values.set(flag, value);
  }
  const root = values.get("--root"); const baseline = values.get("--baseline"); const candidate = values.get("--candidate"); const clipDecision = values.get("--clip-decision"); const configFile = values.get("--config-file");
  if (!root || !configFile || !/^sha256:[0-9a-f]{64}$/.test(baseline ?? "") || !/^sha256:[0-9a-f]{64}$/.test(candidate ?? "") || !/^decision:sha256:[0-9a-f]{64}$/.test(clipDecision ?? "")) throw new Error();
  return { root, baseline: baseline as `sha256:${string}`, candidate: candidate as `sha256:${string}`, clipDecision: clipDecision!, configFile };
}

function line(value: Record<string, unknown>): string {
  const keys = ["operation", "status", "verdict", "reasons", "recoverableCases", "validEmptyCases", "recoveredCases"];
  return JSON.stringify(Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]])));
}

export async function runOutcomeRecoveryGate(argv: readonly string[], io: Io = ioDefault): Promise<number> {
  let args: Args;
  try { args = parse(argv); } catch { io.stderr(line({ operation: "outcome-recovery-gate", status: "failed", reasons: ["invalid_input"] })); return 2; }
  try {
    const config = await readOutcomeObservationConfig(args.configFile);
    if (config.outcomeRecoveryMode !== "shadow") throw new Error();
    const activationConfig = { ...config, outcomeRecoveryMode: "on" as const };
    const decision = await decideOutcomeRecoveryGate({ baselineObservationId: args.baseline, candidateObservationId: args.candidate, clipDecisionId: args.clipDecision,
      expectedCandidateEngineFingerprint: sha256(canonicalJson(config)), expectedActivationEngineFingerprint: sha256(canonicalJson(activationConfig)), customerOutputsMatch: true }, { root: join(args.root, "outcomes"), clipRoot: args.root });
    const output = line({ operation: "outcome-recovery-gate", status: "committed", verdict: decision.verdict, reasons: decision.reasons,
      recoverableCases: decision.metrics.recoverableCases, validEmptyCases: decision.metrics.validEmptyCases, recoveredCases: decision.metrics.recoveredCases });
    io[decision.verdict === "pass" ? "stdout" : "stderr"](output); return decision.verdict === "pass" ? 0 : 1;
  } catch { io.stderr(line({ operation: "outcome-recovery-gate", status: "failed", reasons: ["invalid_input"] })); return 1; }
}

if (require.main === module) runOutcomeRecoveryGate(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
