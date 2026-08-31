import { constants } from "node:fs";
import { chmod, lstat, readFile } from "node:fs/promises";

import { createPrismaQualityPromotionRepository } from "../feedback-quality/repository";
import { promoteFeedbackCase, retireFeedbackCase, type PromotionDecision, type PromotionDependencies, type PromotionResult } from "../feedback-quality/promote";
import { DEFAULT_QUALITY_ROOT, qualityDestination } from "../feedback-quality/store";
import { foldLedger, parseLedger } from "../feedback-learning/ledger";
import { withCorpusLock } from "../feedback-learning/lock";
import { ensurePrivateTree, readLedgerSnapshot } from "../feedback-learning/persistence";
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
  const v1Root = resolve(__dirname, "../../.corpus/feedback-learning");
  const v1Paths = await ensurePrivateTree(v1Root);
  const common: PromotionDependencies = {
    repository, root: DEFAULT_QUALITY_ROOT, downloadFile,
    // Promotion acquires this V1 lock before the V2 labels lock; do not call
    // any V1 mutator while the V2 lock is held.
    withV1AuthorityLock: <T>(operation: () => Promise<T>) => withCorpusLock(v1Paths.lockFile, operation),
    resolveV1Approval: async (identity) => {
      const state = foldLedger(parseLedger(Buffer.from(await readLedgerSnapshot(v1Paths))));
      for (const event of state.activeDecisions) if (event.action === "approve" && event.feedbackId === identity.feedbackId && event.set === identity.destination) {
        return { eventId: event.eventId, feedbackId: event.feedbackId, clipId: event.clipId, jobId: event.jobId, userId: event.userId, feedbackUpdatedAt: event.feedbackUpdatedAt, snapshotSha256: event.snapshotSha256, candidateVersion: event.candidateVersion, destination: event.set };
      }
      return null;
    },
    qualityDestinationGuard: async (feedbackId, destination) => {
      const current = await qualityDestination(DEFAULT_QUALITY_ROOT, feedbackId);
      if (current !== null && current !== destination) throw new Error("destination_locked");
    },
    qualityDestinationPreflight: async (feedbackId, destination) => {
      const current = await qualityDestination(DEFAULT_QUALITY_ROOT, feedbackId);
      if (current !== null && current !== destination) throw new Error("destination_locked");
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
