import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { createPrismaQualityPromotionRepository } from "../feedback-quality/repository";
import { promoteFeedbackCase, retireFeedbackCase, type PromotionDecision, type PromotionDependencies, type PromotionResult } from "../feedback-quality/promote";
import { DEFAULT_QUALITY_ROOT, qualityDestination } from "../feedback-quality/store";
import { foldLedger, parseLedger } from "../feedback-learning/ledger";
import { withCorpusLock } from "../feedback-learning/lock";
import { ensurePrivateTree, readLedgerSnapshot } from "../feedback-learning/persistence";
import { resolve } from "node:path";

export type CommandIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: CommandIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };
export const MAX_DECISION_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_REASON_FILE_BYTES = 64 * 1024;

function safeLog(value: Record<string, unknown>): string {
  const allowed = ["operation", "eventId", "caseVersion", "status", "reason"];
  const result: Record<string, unknown> = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  return JSON.stringify(result);
}

function safeErrorMessage(value: unknown): string | undefined {
  try {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
    const message = Reflect.get(value as object, "message");
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

export async function readPrivateFile(path: string, maxBytes: number): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== 0o600 || initial.size > maxBytes) throw new Error();
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const read = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const final = await handle.stat();
    if (!final.isFile() || final.nlink !== 1 || (final.mode & 0o7777) !== 0o600 || final.size > maxBytes || offset > maxBytes) throw new Error();
    return new Uint8Array(buffer.subarray(0, offset));
  } catch {
    throw new Error("private_file_invalid");
  } finally {
    try { await handle?.close(); } catch { /* preserve the private error */ }
  }
}

export async function readDecisionFile(path: string): Promise<unknown> {
  const bytes = await readPrivateFile(path, MAX_DECISION_FILE_BYTES);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length === 0) throw new Error();
    return JSON.parse(text);
  } catch { throw new Error("decision_file_invalid"); }
}

export async function readReasonFile(path: string): Promise<string> {
  const bytes = await readPrivateFile(path, MAX_REASON_FILE_BYTES);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length === 0) throw new Error();
    return text;
  } catch { throw new Error("reason_file_invalid"); }
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
  disconnect(): Promise<void>;
  io?: CommandIo;
}>;

type CommandOutcome = Readonly<{ code: number; stream: "stdout" | "stderr"; line: string }>;

async function finishOutcome(operation: "promote" | "retire", outcome: CommandOutcome, dependencies: CommandDependencies, io: CommandIo): Promise<number> {
  let final = outcome;
  try {
    await dependencies.disconnect();
  } catch {
    if (outcome.code === 0) final = { code: 1, stream: "stderr", line: safeLog({ operation, reason: "disconnect_failed" }) };
  }
  io[final.stream](final.line);
  return final.code;
}

export async function runFeedbackQualityPromote(argv: readonly string[], dependencies: CommandDependencies): Promise<number> {
  const io = dependencies.io ?? processIo;
  let command: ReturnType<typeof parse>;
  try { command = parse(argv); }
  catch { return finishOutcome("promote", { code: 2, stream: "stderr", line: safeLog({ operation: "promote", reason: "invalid_arguments" }) }, dependencies, io); }
  try {
    const result = command.operation === "promote"
      ? await dependencies.execute(await dependencies.readDecision(command.decisionFile) as PromotionDecision)
      : await dependencies.retire({ action: "retire", targetEventId: command.targetEventId, reason: await readReasonFile(command.reasonFile) });
    const success = result.status === "committed" || result.status === "noop" || result.status === "excluded";
    return finishOutcome(command.operation, { code: success ? 0 : 1, stream: success ? "stdout" : "stderr", line: safeLog({ operation: command.operation, eventId: result.eventId, ...(result.caseVersion ? { caseVersion: result.caseVersion } : {}), status: result.status }) }, dependencies, io);
  } catch (error) {
    const message = safeErrorMessage(error);
    return finishOutcome(command.operation, { code: message === "invalid_arguments" ? 2 : 1, stream: "stderr", line: safeLog({ operation: command.operation, reason: message && ["invalid_decision", "private_file_invalid", "decision_file_invalid", "reason_file_invalid"].includes(message) ? "invalid_arguments" : "promotion_failed" }) }, dependencies, io);
  }
}

const defaultCompositionLoaders = {
  loadR2: () => import("@clipclap/shared/lib/r2"),
  ensureTree: ensurePrivateTree,
};
type CompositionLoaders = typeof defaultCompositionLoaders;
type PromotionPrisma = Parameters<typeof createPrismaQualityPromotionRepository>[0];

export async function composeFeedbackQualityPromoteDependenciesWithPrisma(prisma: PromotionPrisma, overrides: Partial<CompositionLoaders> = {}): Promise<CommandDependencies> {
  const loaders = { ...defaultCompositionLoaders, ...overrides };
  const v1Root = resolve(__dirname, "../../.corpus/feedback-learning");
  try {
    const [{ downloadFile, getObjectSize }, v1Paths] = await Promise.all([loaders.loadR2(), loaders.ensureTree(v1Root)]);
    const repository = createPrismaQualityPromotionRepository(prisma);
    const common: PromotionDependencies = {
      repository, root: DEFAULT_QUALITY_ROOT, downloadFile, getObjectSize,
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
      readDecision: readDecisionFile,
      execute: (request) => promoteFeedbackCase(request, common),
      retire: (request) => retireFeedbackCase(request, common),
      disconnect: () => prisma.$disconnect(),
    };
  } catch (error) {
    try { await prisma.$disconnect(); } catch { /* preserve the composition failure */ }
    throw error;
  }
}

export async function composeFeedbackQualityPromoteDependencies(overrides: Partial<CompositionLoaders> = {}): Promise<CommandDependencies> {
  const [{ prisma }] = await Promise.all([import("@clipclap/shared/lib/prisma")]);
  return composeFeedbackQualityPromoteDependenciesWithPrisma(prisma, overrides);
}

export async function main(argv: readonly string[] = process.argv.slice(2), io: CommandIo = processIo): Promise<number> {
  try { parse(argv); }
  catch { io.stderr(safeLog({ operation: "promote", reason: "invalid_arguments" })); return 2; }
  try { return await runFeedbackQualityPromote(argv, { ...(await composeFeedbackQualityPromoteDependencies()), io }); }
  catch { io.stderr(safeLog({ operation: "promote", reason: "composition_failed" })); return 1; }
}

if (require.main === module) void main().then((code) => { process.exitCode = code; });
