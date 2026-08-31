import { constants } from "node:fs";
import { chmod, lstat, readFile } from "node:fs/promises";

import { createPrismaQualityPromotionRepository } from "../feedback-quality/repository";
import { promoteFeedbackCase, retireFeedbackCase, type PromotionDecision, type PromotionDependencies, type PromotionResult } from "../feedback-quality/promote";
import { DEFAULT_QUALITY_ROOT } from "../feedback-quality/store";
import { foldLedger, parseLedger } from "../feedback-learning/ledger";
import { ensurePrivateTree, readLedgerSnapshot } from "../feedback-learning/persistence";
import type { TargetSet } from "../feedback-learning/types";
import { resolve } from "node:path";

export type CommandIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: CommandIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };

function safeLog(value: Record<string, unknown>): string {
  const allowed = ["operation", "eventId", "caseVersion", "status", "reason"];
  const result: Record<string, unknown> = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  return JSON.stringify(result);
}

async function privateFile(path: string): Promise<Uint8Array> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) throw new Error("private_file_invalid");
  return new Uint8Array(await readFile(path, { flag: constants.O_RDONLY }));
}

async function readJson(path: string): Promise<unknown> {
  const bytes = await privateFile(path);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("decision_file_invalid"); }
}

function parse(argv: readonly string[]): { operation: "promote"; decisionFile: string } | { operation: "retire"; targetEventId: string; reasonFile: string } {
  if (argv.length === 3 && argv[0] === "promote" && argv[1] === "--decision-file" && argv[2].length > 0) return { operation: "promote", decisionFile: argv[2] };
  if (argv.length === 4 && argv[0] === "retire" && argv[1] === "--target-event" && argv[2].length > 0 && argv[3] === "--reason-file") throw new Error("invalid_arguments");
  if (argv.length === 5 && argv[0] === "retire" && argv[1] === "--target-event" && argv[2].length > 0 && argv[3] === "--reason-file" && argv[4].length > 0) return { operation: "retire", targetEventId: argv[2], reasonFile: argv[4] };
  throw new Error("invalid_arguments");
}

type CommandDependencies = Readonly<{
  execute(request: PromotionDecision): Promise<PromotionResult>;
  retire(request: { action: "retire"; targetEventId: string; reason: string }): Promise<PromotionResult>;
  readDecision(path: string): Promise<unknown>;
  io?: CommandIo;
}>;

export async function runFeedbackQualityPromote(argv: readonly string[], dependencies: CommandDependencies): Promise<number> {
  const io = dependencies.io ?? processIo;
  let command: ReturnType<typeof parse>;
  try { command = parse(argv); } catch { io.stderr(safeLog({ operation: "promote", reason: "invalid_arguments" })); return 2; }
  try {
    const result = command.operation === "promote"
      ? await dependencies.execute(await dependencies.readDecision(command.decisionFile) as PromotionDecision)
      : await dependencies.retire({ action: "retire", targetEventId: command.targetEventId, reason: new TextDecoder("utf-8", { fatal: true }).decode(await privateFile(command.reasonFile)) });
    io[(result.status === "committed" || result.status === "noop" || result.status === "excluded") ? "stdout" : "stderr"](
      safeLog({ operation: command.operation, eventId: result.eventId, ...(result.caseVersion ? { caseVersion: result.caseVersion } : {}), status: result.status }),
    );
    return result.status === "committed" || result.status === "noop" || result.status === "excluded" ? 0 : 1;
  } catch (error) {
    io.stderr(safeLog({ operation: command.operation, reason: error instanceof Error && ["invalid_decision", "private_file_invalid", "decision_file_invalid"].includes(error.message) ? "invalid_arguments" : "promotion_failed" }));
    return error instanceof Error && error.message === "invalid_arguments" ? 2 : 1;
  }
}

export async function composeFeedbackQualityPromoteDependencies(): Promise<CommandDependencies> {
  const [{ prisma }, { downloadFile }] = await Promise.all([import("@clipclap/shared/lib/prisma"), import("@clipclap/shared/lib/r2")]);
  const repository = createPrismaQualityPromotionRepository(prisma);
  const common: PromotionDependencies = {
    repository, root: DEFAULT_QUALITY_ROOT, downloadFile,
    existingDestination: async (feedbackId: string): Promise<TargetSet | null> => {
      const v1Root = resolve(__dirname, "../../.corpus/feedback-learning");
      const paths = await ensurePrivateTree(v1Root);
      const state = foldLedger(parseLedger(Buffer.from(await readLedgerSnapshot(paths))));
      for (const event of state.activeDecisions) if (event.action === "approve" && event.feedbackId === feedbackId) return event.set;
      return null;
    },
  };
  return {
    readDecision: readJson,
    execute: (request) => promoteFeedbackCase(request, common),
    retire: (request) => retireFeedbackCase(request, common),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2), io: CommandIo = processIo): Promise<number> {
  try { parse(argv); }
  catch { io.stderr(safeLog({ operation: "promote", reason: "invalid_arguments" })); return 2; }
  try { return await runFeedbackQualityPromote(argv, { ...(await composeFeedbackQualityPromoteDependencies()), io }); }
  catch { io.stderr(safeLog({ operation: "promote", reason: "composition_failed" })); return 1; }
}

if (require.main === module) void main().then((code) => { process.exitCode = code; });
