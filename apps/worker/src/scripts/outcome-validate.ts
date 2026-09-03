import { validateOutcomeStore, type OutcomeValidationReport } from "../feedback-quality/outcome-promote";
import { join } from "node:path";

export type OutcomeValidateIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: OutcomeValidateIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };

function parse(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--root" || !argv[1]) throw new Error("invalid_arguments");
  return argv[1];
}

function line(report: OutcomeValidationReport): string {
  return JSON.stringify({ operation: "outcome-validate", status: report.status, counts: report.counts, reasons: report.reasons });
}

export async function runOutcomeValidate(argv: readonly string[], dependencies: Readonly<{
  validate(root: string): Promise<OutcomeValidationReport>;
  io?: OutcomeValidateIo;
}>): Promise<number> {
  const io = dependencies.io ?? processIo;
  let root: string;
  try { root = parse(argv); }
  catch { io.stderr(JSON.stringify({ operation: "outcome-validate", status: "invalid", counts: { eval: 0, holdout: 0 }, reasons: { invalid_arguments: 1 } })); return 2; }
  try {
    const report = await dependencies.validate(join(root, "outcomes"));
    io[report.status === "valid" ? "stdout" : "stderr"](line(report));
    return report.status === "valid" ? 0 : 1;
  } catch {
    io.stderr(JSON.stringify({ operation: "outcome-validate", status: "invalid", counts: { eval: 0, holdout: 0 }, reasons: { validation_failed: 1 } }));
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runOutcomeValidate(process.argv.slice(2), { validate: validateOutcomeStore });
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
