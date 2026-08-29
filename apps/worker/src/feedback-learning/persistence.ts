import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RUN_FILE_NAMES = [
  "run.json",
  "candidates.jsonl",
  "candidates.md",
  "exclusions.jsonl",
] as const;

export type CommitResult =
  | { status: "committed" }
  | { status: "noop" }
  | { status: "committed_durability_uncertain" }
  | { status: "indeterminate" };

export type PrivatePaths = Readonly<{
  root: string;
  exportsDir: string;
  ledgerDir: string;
  reviewsFile: string;
  lockFile: string;
}>;

export type RunFileName = (typeof RUN_FILE_NAMES)[number];

export type RunFiles = Readonly<Record<RunFileName, Uint8Array>>;

export type PersistenceFault =
  | Readonly<{
      scope: "ledger";
      operation: "write" | "file_fsync" | "close" | "rename" | "parent_fsync";
      timing: "before" | "after";
    }>
  | Readonly<{
      scope: "run";
      operation: "write" | "file_fsync" | "close";
      timing: "before" | "after";
      file: RunFileName;
    }>
  | Readonly<{
      scope: "run";
      operation: "temp_dir_fsync" | "rename" | "parent_fsync";
      timing: "before" | "after";
    }>;

type FaultInjector = (point: PersistenceFault) => void | Promise<void>;

export type LedgerWrite = Readonly<{
  paths: PrivatePaths;
  bytes: Uint8Array;
  expectedEventId: string;
  injectFault?: FaultInjector;
}>;

export type RunWrite = Readonly<{
  paths: PrivatePaths;
  runId: string;
  runDigest: string;
  files: RunFiles;
  injectFault?: FaultInjector;
}>;

export class PersistencePathError extends Error {
  readonly code = "unsafe_path" as const;

  constructor() {
    super("unsafe_path");
    this.name = "PersistencePathError";
  }
}

export class PersistenceIntegrityError extends Error {
  readonly code = "run_integrity" as const;

  constructor() {
    super("run_integrity");
    this.name = "PersistenceIntegrityError";
  }
}

export class PersistenceInputError extends Error {
  readonly code = "invalid_input" as const;

  constructor() {
    super("invalid_input");
    this.name = "PersistenceInputError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function throwUnsafe(): never {
  throw new PersistencePathError();
}

function privatePaths(root: string): PrivatePaths {
  const rootName = basename(root);
  if (!root || !rootName || rootName === "." || rootName === ".." || root.includes("\0")) {
    throw new PersistenceInputError();
  }
  const exportsDir = join(root, "exports");
  const ledgerDir = join(root, "ledger");
  return Object.freeze({
    root,
    exportsDir,
    ledgerDir,
    reviewsFile: join(ledgerDir, "reviews.jsonl"),
    lockFile: join(ledgerDir, "reviews.lock"),
  });
}

function assertPrivatePaths(paths: PrivatePaths): void {
  const expected = privatePaths(paths.root);
  for (const key of Object.keys(expected) as (keyof PrivatePaths)[]) {
    if (paths[key] !== expected[key]) throw new PersistenceInputError();
  }
  if (Object.keys(paths).length !== Object.keys(expected).length) throw new PersistenceInputError();
}

async function closeBestEffort(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Cleanup cannot replace the primary persistence outcome.
  }
}

async function removeBestEffort(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // Cleanup cannot replace the primary persistence outcome.
  }
}

async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    if (!(await handle.stat()).isDirectory()) throwUnsafe();
    return handle;
  } catch (error) {
    await closeBestEffort(handle);
    if (error instanceof PersistencePathError) throw error;
    throwUnsafe();
  }
}

async function secureDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throwUnsafe();
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      await mkdir(path, DIRECTORY_MODE);
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throwUnsafe();
  }

  const handle = await openDirectoryNoFollow(path);
  try {
    await handle.chmod(DIRECTORY_MODE);
  } finally {
    await closeBestEffort(handle);
  }
}

async function ensureNoSymlinkOrSpecialFile(path: string): Promise<"missing" | "file" | "directory"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throwUnsafe();
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    throwUnsafe();
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

async function readRegularFileNoFollow(path: string, repairMode: boolean): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    const kind = await ensureNoSymlinkOrSpecialFile(path);
    if (kind !== "file") throwUnsafe();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throwUnsafe();
    const bytes = await handle.readFile();
    if (repairMode) await handle.chmod(FILE_MODE);
    return bytes;
  } catch (error) {
    if (
      error instanceof PersistencePathError ||
      error instanceof PersistenceIntegrityError ||
      error instanceof PersistenceInputError
    ) {
      throw error;
    }
    throwUnsafe();
  } finally {
    await closeBestEffort(handle);
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error("short_write");
    offset += result.bytesWritten;
  }
}

async function fault(inject: FaultInjector | undefined, point: PersistenceFault): Promise<void> {
  await inject?.(point);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await openDirectoryNoFollow(path);
  try {
    await handle.sync();
  } finally {
    await closeBestEffort(handle);
  }
}

function uniqueSibling(parent: string, prefix: string): string {
  return join(parent, `${prefix}${randomBytes(16).toString("hex")}`);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function verifyLedgerEvent(path: string, expectedEventId: string): Promise<boolean> {
  try {
    const bytes = await readRegularFileNoFollow(path, false);
    const lines = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .split("\n")
      .filter((line) => line.length > 0);
    return lines.some((line) => {
      const value: unknown = JSON.parse(line);
      return (
        typeof value === "object" &&
        value !== null &&
        "eventId" in value &&
        value.eventId === expectedEventId
      );
    });
  } catch {
    return false;
  }
}

async function verifyRunDigest(runDirectory: string, expectedRunDigest: string): Promise<boolean> {
  try {
    const directoryKind = await ensureNoSymlinkOrSpecialFile(runDirectory);
    if (directoryKind !== "directory") return false;
    const bytes = await readRegularFileNoFollow(join(runDirectory, "run.json"), false);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return (
      typeof value === "object" &&
      value !== null &&
      "runDigest" in value &&
      value.runDigest === expectedRunDigest
    );
  } catch {
    return false;
  }
}

async function uncertainLedgerResult(input: LedgerWrite): Promise<CommitResult> {
  return (await verifyLedgerEvent(input.paths.reviewsFile, input.expectedEventId))
    ? { status: "committed_durability_uncertain" }
    : { status: "indeterminate" };
}

async function uncertainRunResult(input: RunWrite, runDirectory: string): Promise<CommitResult> {
  return (await verifyRunDigest(runDirectory, input.runDigest))
    ? { status: "committed_durability_uncertain" }
    : { status: "indeterminate" };
}

export async function ensurePrivateTree(root: string): Promise<PrivatePaths> {
  const paths = privatePaths(root);
  await secureDirectory(paths.root);
  await secureDirectory(paths.exportsDir);
  await secureDirectory(paths.ledgerDir);
  return paths;
}

export async function replaceLedgerAtomically(input: LedgerWrite): Promise<CommitResult> {
  assertPrivatePaths(input.paths);
  if (!input.expectedEventId) throw new PersistenceInputError();
  await ensurePrivateTree(input.paths.root);
  const finalKind = await ensureNoSymlinkOrSpecialFile(input.paths.reviewsFile);
  if (finalKind === "directory") throwUnsafe();

  const bytes = new Uint8Array(input.bytes);
  const tempPath = uniqueSibling(input.paths.ledgerDir, ".reviews.jsonl.tmp-");
  let handle: FileHandle | undefined;
  let closed = false;
  let renamePossible = false;

  try {
    handle = await open(
      tempPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      FILE_MODE
    );
    if (!(await handle.stat()).isFile()) throwUnsafe();
    await handle.chmod(FILE_MODE);

    await fault(input.injectFault, { scope: "ledger", operation: "write", timing: "before" });
    await writeAll(handle, bytes);
    await fault(input.injectFault, { scope: "ledger", operation: "write", timing: "after" });

    await fault(input.injectFault, {
      scope: "ledger",
      operation: "file_fsync",
      timing: "before",
    });
    await handle.sync();
    await fault(input.injectFault, {
      scope: "ledger",
      operation: "file_fsync",
      timing: "after",
    });

    await fault(input.injectFault, { scope: "ledger", operation: "close", timing: "before" });
    await handle.close();
    closed = true;
    await fault(input.injectFault, { scope: "ledger", operation: "close", timing: "after" });

    const currentKind = await ensureNoSymlinkOrSpecialFile(input.paths.reviewsFile);
    if (currentKind === "directory") throwUnsafe();
    await fault(input.injectFault, { scope: "ledger", operation: "rename", timing: "before" });
    renamePossible = true;
    await rename(tempPath, input.paths.reviewsFile);
    await fault(input.injectFault, { scope: "ledger", operation: "rename", timing: "after" });

    await fault(input.injectFault, {
      scope: "ledger",
      operation: "parent_fsync",
      timing: "before",
    });
    await syncDirectory(input.paths.ledgerDir);
    await fault(input.injectFault, {
      scope: "ledger",
      operation: "parent_fsync",
      timing: "after",
    });
    return { status: "committed" };
  } catch (error) {
    if (renamePossible) return uncertainLedgerResult(input);
    throw error;
  } finally {
    if (!closed) await closeBestEffort(handle);
    await removeBestEffort(tempPath);
  }
}

function assertRunInput(input: RunWrite): void {
  if (
    !input.runId ||
    input.runId === "." ||
    input.runId === ".." ||
    basename(input.runId) !== input.runId ||
    input.runId.includes("/") ||
    input.runId.includes("\\") ||
    input.runId.includes("\0") ||
    !input.runDigest
  ) {
    throw new PersistencePathError();
  }
  const names = Object.keys(input.files).sort();
  if (
    names.length !== RUN_FILE_NAMES.length ||
    !RUN_FILE_NAMES.every((name) => names.includes(name))
  ) {
    throw new PersistenceInputError();
  }
  for (const name of RUN_FILE_NAMES) {
    if (!(input.files[name] instanceof Uint8Array)) throw new PersistenceInputError();
  }
}

async function existingRunResult(
  runDirectory: string,
  expectedFiles: RunFiles
): Promise<CommitResult | undefined> {
  const kind = await ensureNoSymlinkOrSpecialFile(runDirectory);
  if (kind === "missing") return undefined;
  if (kind !== "directory") throw new PersistenceIntegrityError();

  const actualFiles = new Map<RunFileName, Uint8Array>();
  for (const name of RUN_FILE_NAMES) {
    try {
      actualFiles.set(name, await readRegularFileNoFollow(join(runDirectory, name), false));
    } catch (error) {
      if (error instanceof PersistencePathError) {
        try {
          const fileKind = await ensureNoSymlinkOrSpecialFile(join(runDirectory, name));
          if (fileKind === "missing") throw new PersistenceIntegrityError();
        } catch (kindError) {
          if (isMissing(kindError)) throw new PersistenceIntegrityError();
          throw kindError;
        }
      }
      throw error;
    }
  }
  for (const name of RUN_FILE_NAMES) {
    if (!bytesEqual(actualFiles.get(name)!, expectedFiles[name])) {
      throw new PersistenceIntegrityError();
    }
  }

  await secureDirectory(runDirectory);
  for (const name of RUN_FILE_NAMES) {
    await readRegularFileNoFollow(join(runDirectory, name), true);
  }
  return { status: "noop" };
}

async function writeRunFile(
  path: string,
  file: RunFileName,
  bytes: Uint8Array,
  inject: FaultInjector | undefined
): Promise<void> {
  let handle: FileHandle | undefined;
  let closed = false;
  try {
    handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      FILE_MODE
    );
    if (!(await handle.stat()).isFile()) throwUnsafe();
    await handle.chmod(FILE_MODE);

    await fault(inject, { scope: "run", operation: "write", timing: "before", file });
    await writeAll(handle, bytes);
    await fault(inject, { scope: "run", operation: "write", timing: "after", file });

    await fault(inject, { scope: "run", operation: "file_fsync", timing: "before", file });
    await handle.sync();
    await fault(inject, { scope: "run", operation: "file_fsync", timing: "after", file });

    await fault(inject, { scope: "run", operation: "close", timing: "before", file });
    await handle.close();
    closed = true;
    await fault(inject, { scope: "run", operation: "close", timing: "after", file });
  } finally {
    if (!closed) await closeBestEffort(handle);
  }
}

export async function publishRunAtomically(input: RunWrite): Promise<CommitResult> {
  assertPrivatePaths(input.paths);
  assertRunInput(input);
  await ensurePrivateTree(input.paths.root);

  const copiedFiles = Object.freeze(
    Object.fromEntries(
      RUN_FILE_NAMES.map((name) => [name, new Uint8Array(input.files[name])])
    )
  ) as RunFiles;
  const runDirectory = join(input.paths.exportsDir, input.runId);
  const priorResult = await existingRunResult(runDirectory, copiedFiles);
  if (priorResult) return priorResult;

  const tempDirectory = uniqueSibling(input.paths.exportsDir, `.${input.runId}.tmp-`);
  let renamePossible = false;
  try {
    await mkdir(tempDirectory, DIRECTORY_MODE);
    await secureDirectory(tempDirectory);
    for (const name of RUN_FILE_NAMES) {
      await writeRunFile(join(tempDirectory, name), name, copiedFiles[name], input.injectFault);
    }

    await fault(input.injectFault, {
      scope: "run",
      operation: "temp_dir_fsync",
      timing: "before",
    });
    await syncDirectory(tempDirectory);
    await fault(input.injectFault, {
      scope: "run",
      operation: "temp_dir_fsync",
      timing: "after",
    });

    const racedResult = await existingRunResult(runDirectory, copiedFiles);
    if (racedResult) return racedResult;
    await fault(input.injectFault, { scope: "run", operation: "rename", timing: "before" });
    renamePossible = true;
    await rename(tempDirectory, runDirectory);
    await fault(input.injectFault, { scope: "run", operation: "rename", timing: "after" });

    await fault(input.injectFault, {
      scope: "run",
      operation: "parent_fsync",
      timing: "before",
    });
    await syncDirectory(input.paths.exportsDir);
    await fault(input.injectFault, {
      scope: "run",
      operation: "parent_fsync",
      timing: "after",
    });
    return { status: "committed" };
  } catch (error) {
    if (renamePossible) return uncertainRunResult(input, runDirectory);
    throw error;
  } finally {
    await removeBestEffort(tempDirectory);
  }
}
