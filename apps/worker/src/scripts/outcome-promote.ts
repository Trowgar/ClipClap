import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { prisma } from "@clipclap/shared/lib/prisma";
import { downloadFile, getObjectSize } from "@clipclap/shared/lib/r2";

import { createPrismaOutcomePromotionRepository, promoteOutcomeCase, type OutcomePromotionDecision, type OutcomePromotionResult } from "../feedback-quality/outcome-promote";

const MAX_DECISION_BYTES = 4 * 1024 * 1024;

export type OutcomeCommandIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: OutcomeCommandIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };

function safeLine(value: Record<string, unknown>): string {
  const allowed = ["operation", "status", "set", "reason"];
  return JSON.stringify(Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]])));
}

export async function readOutcomeDecisionFile(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!path || path.includes("\0")) throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== 0o600 || initial.size <= 0 || initial.size > MAX_DECISION_BYTES) throw new Error();
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) { const item = await handle.read(bytes, offset, bytes.length - offset, null); if (!item.bytesRead) break; offset += item.bytesRead; }
    const final = await handle.stat();
    if (offset !== bytes.length || final.ino !== initial.ino || final.size !== initial.size || final.nlink !== 1) throw new Error();
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch { throw new Error("private_file_invalid"); }
  finally { await handle?.close().catch(() => undefined); }
}

function parse(argv: readonly string[]): { decisionFile: string; root: string } {
  if (argv.length !== 4 || argv[0] !== "--decision-file" || !argv[1] || argv[2] !== "--root" || !argv[3]) throw new Error("invalid_arguments");
  return { decisionFile: argv[1], root: argv[3] };
}

type CommandDependencies = Readonly<{
  readDecision(path: string): Promise<unknown>;
  execute(decision: OutcomePromotionDecision, root: string): Promise<OutcomePromotionResult>;
  disconnect(): Promise<void>;
  io?: OutcomeCommandIo;
}>;

export async function runOutcomePromote(argv: readonly string[], dependencies: CommandDependencies): Promise<number> {
  const io = dependencies.io ?? processIo;
  let args: ReturnType<typeof parse>;
  try { args = parse(argv); }
  catch { io.stderr(safeLine({ operation: "outcome-promote", reason: "invalid_arguments" })); await dependencies.disconnect().catch(() => undefined); return 2; }
  try {
    const result = await dependencies.execute(await dependencies.readDecision(args.decisionFile) as OutcomePromotionDecision, join(args.root, "outcomes"));
    await dependencies.disconnect();
    io.stdout(safeLine({ operation: "outcome-promote", status: result.status, set: result.set }));
    return 0;
  } catch (error) {
    await dependencies.disconnect().catch(() => undefined);
    const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error && error.message === "private_file_invalid" ? error.message : "promotion_failed";
    io.stderr(safeLine({ operation: "outcome-promote", reason }));
    return 1;
  }
}

async function main(): Promise<void> {
  const repository = createPrismaOutcomePromotionRepository(prisma);
  process.exitCode = await runOutcomePromote(process.argv.slice(2), {
    readDecision: readOutcomeDecisionFile,
    execute: (decision, root) => promoteOutcomeCase(decision, {
      repository, root, getObjectSize,
      downloadFile: (key) => downloadFile(key),
    }),
    disconnect: () => prisma.$disconnect(),
  });
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
