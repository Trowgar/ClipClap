import { constants, type Dirent } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { withCorpusLock, type CorpusLockError } from "../feedback-learning/lock";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const COMMIT_MARKER = ".committed";
const RESERVATION_MARKER = ".reservation";
const COMMIT_MARKER_BYTES = Buffer.from("clipclap-feedback-quality-committed-v1\n", "utf8");
const BUNDLE_NAMES = ["case", "observation", "decision"] as const;
const PRIVATE_FILE_NAMES = new Set(["case.json", "transcript.json", "source-or-evidence.mp4", "manifest.json", "results.jsonl", "decision.json", "report.md"]);
const MAX_PRIVATE_METADATA_BYTES = 8 * 1024;
export const MAX_READ_BUNDLE_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_READ_BUNDLE_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_STREAM_BUNDLE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_STREAM_BUNDLE_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;

export type BundleKind = (typeof BUNDLE_NAMES)[number];

export type QualityPaths = Readonly<{
  root: string;
  ledgerDir: string;
  labelsFile: string;
  labelsLock: string;
  casesDir: string;
  observationsDir: string;
  decisionsDir: string;
}>;

export type QualityLabelEvent = Readonly<{
  eventId: string;
  [key: string]: unknown;
}>;

/** A private, already-spooled artifact. It is copied into the owned corpus;
 * the external path is never linked into the corpus. */
export type FileBackedPayload = Readonly<{
  path: string;
  size: number;
  sha256: `sha256:${string}`;
}>;
export type BundleFilePayload = Uint8Array | FileBackedPayload;

export type QualityStoreFault = Readonly<{
  scope: "ledger" | "bundle";
  operation: "reserve" | "write" | "file_fsync" | "close" | "temp_dir_fsync" | "rename" | "parent_fsync";
  timing: "before" | "after";
  file?: string;
}>;

export type QualityStoreFaultInjector = (point: QualityStoreFault) => void | Promise<void>;

/** Optional test-only hooks; omitted by all production callers. */
export type AppendLabelOptions = Readonly<{
  injectFault?: QualityStoreFaultInjector;
  /** Test-only deterministic temp name; never persisted. */
  tempSuffix?: string;
  /** Runs under labels.lock immediately before publishing the new ledger bytes. */
  beforeCommit?: () => void | Promise<void>;
}>;

export type PublishBundleInput = Readonly<{
  kind: BundleKind;
  id: string;
  files: Readonly<Record<string, BundleFilePayload>>;
  injectFault?: QualityStoreFaultInjector;
}>;

export type CommitResult =
  | { status: "committed" }
  | { status: "noop" }
  | { status: "committed_durability_uncertain" }
  | { status: "indeterminate" };

export class QualityStoreError extends Error {
  readonly code: "invalid_input" | "unsafe_path" | "integrity" | "missing" | "too_large";

  constructor(code: QualityStoreError["code"]) {
    super(code);
    this.name = "QualityStoreError";
    this.code = code;
  }
}

export const DEFAULT_QUALITY_ROOT = resolve(__dirname, "../../.corpus/feedback-quality-gate");

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function safeError(code: QualityStoreError["code"]): QualityStoreError {
  return new QualityStoreError(code);
}

function validateRoot(root: string): string {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) throw safeError("invalid_input");
  const name = basename(root);
  if (!name || name === "." || name === "..") throw safeError("invalid_input");
  return root;
}

function validateComponent(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) throw safeError("unsafe_path");
  return value;
}

function validateKind(kind: BundleKind): BundleKind {
  if (!BUNDLE_NAMES.includes(kind)) throw safeError("invalid_input");
  return kind;
}

function validateBundleId(kind: BundleKind, id: string): string {
  validateComponent(id);
  if (!new RegExp(`^${kind}:sha256:[0-9a-f]{64}$`).test(id)) throw safeError("invalid_input");
  return id;
}

function validateFileName(name: string): string {
  validateComponent(name);
  if (!PRIVATE_FILE_NAMES.has(name)) throw safeError("invalid_input");
  return name;
}

function ownedPaths(root: string): QualityPaths {
  return Object.freeze({
    root,
    ledgerDir: join(root, "ledger"),
    labelsFile: join(root, "ledger", "labels.jsonl"),
    labelsLock: join(root, "ledger", "labels.lock"),
    casesDir: join(root, "cases"),
    observationsDir: join(root, "observations"),
    decisionsDir: join(root, "decisions"),
  });
}

function anchoredPath(handle: FileHandle, child?: string): string {
  const root = `/proc/self/fd/${handle.fd}`;
  return child === undefined ? root : join(root, child);
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try { await handle.close(); } catch { /* preserve primary result */ }
}

async function openDirectory(path: string, missing = false): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isDirectory()) throw safeError("unsafe_path");
    return handle;
  } catch (error) {
    await closeQuietly(handle);
    if (missing && codeOf(error) === "ENOENT") throw safeError("missing");
    if (error instanceof QualityStoreError) throw error;
    throw safeError("unsafe_path");
  }
}

async function openRootAnchored(root: string): Promise<FileHandle> {
  let current = await openDirectory("/");
  try {
    for (const component of resolve(root).split("/").filter(Boolean)) {
      const next = await openDirectory(anchoredPath(current, component));
      await closeQuietly(current);
      current = next;
    }
    return current;
  } catch (error) {
    await closeQuietly(current);
    throw error instanceof QualityStoreError ? error : safeError("unsafe_path");
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isDirectory()) throw safeError("unsafe_path");
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error instanceof QualityStoreError ? error : safeError("unsafe_path");
    try { await mkdir(path, DIRECTORY_MODE); }
    catch (mkdirError) {
      if (codeOf(mkdirError) !== "EEXIST") throw safeError("unsafe_path");
    }
    const created = await lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()) throw safeError("unsafe_path");
  }
  const handle = await openDirectory(path);
  try {
    await handle.chmod(DIRECTORY_MODE);
    await handle.sync();
  } finally { await closeQuietly(handle); }
}

async function assertNoSymlinkComponents(root: string): Promise<void> {
  const absolute = resolve(root);
  let current = await openDirectory("/");
  try {
    for (const component of absolute.split("/").filter(Boolean)) {
      try {
        const next = await openDirectory(anchoredPath(current, component), true);
        await closeQuietly(current);
        current = next;
      } catch (error) {
        if (error instanceof QualityStoreError && error.code === "unsafe_path") throw error;
        if (codeOf(error) === "ENOENT" || (error instanceof QualityStoreError && error.code === "missing")) break;
        throw safeError("unsafe_path");
      }
    }
  } finally { await closeQuietly(current); }
}

export async function ensureQualityTree(root = DEFAULT_QUALITY_ROOT): Promise<QualityPaths> {
  const checkedRoot = validateRoot(root);
  await assertNoSymlinkComponents(checkedRoot);
  const paths = ownedPaths(checkedRoot);
  await ensureDirectory(paths.root);
  await Promise.all([paths.ledgerDir, paths.casesDir, paths.observationsDir, paths.decisionsDir].map(ensureDirectory));
  return paths;
}

function contentBytes(value: unknown): Buffer {
  try { return Buffer.from(canonicalJson(value), "utf8"); }
  catch { throw safeError("invalid_input"); }
}

export function contentId(prefix: "case" | "observation" | "decision", value: unknown): string {
  if (!BUNDLE_NAMES.includes(prefix)) throw safeError("invalid_input");
  const canonical = contentBytes(value);
  return `${prefix}:${sha256(canonical)}`;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw safeError("integrity");
    offset += result.bytesWritten;
  }
}

async function writeAllAt(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (result.bytesWritten <= 0) throw safeError("integrity");
    offset += result.bytesWritten;
  }
}

async function fault(inject: PublishBundleInput["injectFault"], point: QualityStoreFault): Promise<void> {
  try { await inject?.(point); }
  catch { throw safeError("integrity"); }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

type PreparedFile = Readonly<{ bytes?: Uint8Array; file?: FileBackedPayload; size: number; sha256: string }>;
type PreparedFiles = Readonly<Record<string, PreparedFile>>;

function payloadMetadata(value: BundleFilePayload): PreparedFile {
  if (value instanceof Uint8Array) {
    const bytes = new Uint8Array(value);
    return { bytes, size: bytes.byteLength, sha256: sha256(Buffer.from(bytes)) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw safeError("invalid_input");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "path,sha256,size" || typeof value.path !== "string" || value.path.length === 0 || value.path.length > 4096 || value.path.includes("\0") ||
      !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.sha256)) throw safeError("invalid_input");
  return { file: value, size: value.size, sha256: value.sha256 };
}

function bundleDigest(expected: PreparedFiles): string {
  const captured: Record<string, { size: number; sha256: string }> = Object.create(null);
  for (const name of Object.keys(expected).sort()) captured[name] = { size: expected[name].size, sha256: expected[name].sha256 };
  return sha256(canonicalJson(captured));
}

function reservationBytes(expected: PreparedFiles, token: string): Buffer {
  return Buffer.from(`${canonicalJson({ schemaVersion: 1, digest: bundleDigest(expected), token })}\n`, "utf8");
}

async function payloadMatches(path: string, expected: PreparedFile, allowLinked = false): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat();
    if (!initial.isFile() || (initial.nlink !== 1 && !(allowLinked && initial.nlink === 2))) throw safeError("unsafe_path");
    if (initial.size !== expected.size) return false;
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
      if (size > expected.size) return false;
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const final = await handle.stat();
    if (!final.isFile() || (final.nlink !== 1 && !(allowLinked && final.nlink === 2)) || final.size !== size) return false;
    return size === expected.size && `sha256:${digest.digest("hex")}` === expected.sha256;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    if (error instanceof QualityStoreError) throw error;
    throw safeError("integrity");
  } finally { await closeQuietly(handle); }
}

async function fileMetadata(path: string, maxSize = MAX_STREAM_BUNDLE_FILE_BYTES): Promise<{ size: number; sha256: `sha256:${string}` }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== FILE_MODE) throw safeError("unsafe_path");
    if (initial.size > maxSize) throw safeError("too_large");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const final = await handle.stat();
    if (!final.isFile() || final.nlink !== 1 || (final.mode & 0o7777) !== FILE_MODE || final.size !== size) throw safeError("integrity");
    return { size, sha256: `sha256:${digest.digest("hex")}` as `sha256:${string}` };
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("integrity");
  } finally { await closeQuietly(handle); }
}

type Reservation = Readonly<{ digest: string; token: string }>;
type BundleResume = Readonly<{ status: "resume"; reservation: Reservation; temps: ReadonlyMap<string, string> }>;

async function inspectTemp(
  directory: FileHandle,
  temporaryName: string,
  finalName: string,
  expected: PreparedFile,
): Promise<boolean> {
  let temporary: FileHandle | undefined;
  let final: FileHandle | undefined;
  try {
    temporary = await open(anchoredPath(directory, temporaryName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const temporaryStat = await temporary.stat();
    if (!temporaryStat.isFile() || (temporaryStat.nlink !== 1 && temporaryStat.nlink !== 2)) throw safeError("unsafe_path");
    if (temporaryStat.nlink === 2) {
      final = await open(anchoredPath(directory, finalName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const finalStat = await final.stat();
      if (!finalStat.isFile() || finalStat.nlink !== 2 || finalStat.dev !== temporaryStat.dev || finalStat.ino !== temporaryStat.ino) throw safeError("integrity");
      const [temporaryMatch, finalMatch] = await Promise.all([payloadMatches(anchoredPath(directory, temporaryName), expected, true), payloadMatches(anchoredPath(directory, finalName), expected, true)]);
      if (!temporaryMatch || !finalMatch) throw safeError("integrity");
      return true;
    }
    if (!await payloadMatches(anchoredPath(directory, temporaryName), expected, true)) throw safeError("integrity");
    return false;
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("integrity");
  } finally {
    await closeQuietly(final);
    await closeQuietly(temporary);
  }
}

async function readReservation(directory: FileHandle): Promise<Reservation> {
  const bytes = await readPrivateMetadata(anchoredPath(directory, RESERVATION_MARKER));
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Object.keys(parsed).sort().join(",") !== "digest,schemaVersion,token") throw safeError("integrity");
    const value = parsed as { schemaVersion?: unknown; digest?: unknown; token?: unknown };
    if (value.schemaVersion !== 1 || typeof value.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.digest) || typeof value.token !== "string" || !/^[0-9a-f]{32}$/.test(value.token)) throw safeError("integrity");
    if (!bytesEqual(bytes, Buffer.from(`${canonicalJson(parsed)}\n`, "utf8"))) throw safeError("integrity");
    return { digest: value.digest, token: value.token };
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("integrity");
  }
}

async function readRegular(path: string): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()) throw safeError("unsafe_path");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw safeError("unsafe_path");
    const bytes = await handle.readFile();
    return new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("unsafe_path");
  } finally { await closeQuietly(handle); }
}

async function readRegularCapped(path: string, cap: number): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw safeError("unsafe_path");
    if (stats.size > cap) throw safeError("too_large");
    const bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const final = await handle.stat();
    if (!final.isFile() || final.nlink !== 1 || final.size > cap || final.size !== offset) throw safeError(final.size > cap ? "too_large" : "integrity");
    return new Uint8Array(bytes.subarray(0, offset));
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("unsafe_path");
  } finally { await closeQuietly(handle); }
}

async function readPrivateMetadata(path: string): Promise<Uint8Array> {
  return readRegularCapped(path, MAX_PRIVATE_METADATA_BYTES);
}

async function regularFileSize(path: string): Promise<number> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o7777) !== FILE_MODE) throw safeError("unsafe_path");
    return stats.size;
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("unsafe_path");
  } finally { await closeQuietly(handle); }
}

export type OpenBundleFile = Readonly<{
  size: number;
  sha256: Promise<`sha256:${string}`>;
  stream: ReadableStream<Uint8Array>;
  close(): Promise<void>;
}>;

/** Open one committed corpus file without exposing its filesystem path. The
 * descriptor remains pinned while the caller consumes the stream. */
export async function openBundleFile(kind: BundleKind, id: string, name: string, root = DEFAULT_QUALITY_ROOT): Promise<OpenBundleFile> {
  validateKind(kind);
  validateBundleId(kind, id);
  validateFileName(name);
  if (name === COMMIT_MARKER || name === RESERVATION_MARKER) throw safeError("invalid_input");
  let tree: Awaited<ReturnType<typeof openTree>> | undefined;
  let directory: FileHandle | undefined;
  let handle: FileHandle | undefined;
  try {
    tree = await openTree(validateRoot(root));
    directory = await openDirectory(anchoredPath(tree.dirs[kind], id), true);
    const reservation = await readReservation(directory);
    const marker = await readPrivateMetadata(anchoredPath(directory, COMMIT_MARKER));
    if (!bytesEqual(marker, COMMIT_MARKER_BYTES)) throw safeError("integrity");
    const manifest: Record<string, { size: number; sha256: `sha256:${string}` }> = Object.create(null);
    const bundleEntries = await entries(directory);
    const sizes: Record<string, number> = Object.create(null);
    let totalSize = 0;
    for (const entry of bundleEntries) {
      if (entry.name === COMMIT_MARKER || entry.name === RESERVATION_MARKER) continue;
      validateFileName(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) throw safeError("unsafe_path");
      const size = await regularFileSize(anchoredPath(directory, entry.name));
      if (size > MAX_STREAM_BUNDLE_FILE_BYTES || totalSize > MAX_STREAM_BUNDLE_TOTAL_BYTES - size) throw safeError("too_large");
      sizes[entry.name] = size;
      totalSize += size;
    }
    for (const entry of bundleEntries) {
      if (entry.name === COMMIT_MARKER || entry.name === RESERVATION_MARKER) continue;
      manifest[entry.name] = await fileMetadata(anchoredPath(directory, entry.name), sizes[entry.name]);
    }
    const orderedManifest: Record<string, { size: number; sha256: `sha256:${string}` }> = Object.create(null);
    for (const key of Object.keys(manifest).sort()) orderedManifest[key] = manifest[key];
    if (reservation.digest !== sha256(canonicalJson(orderedManifest)) || !Object.prototype.hasOwnProperty.call(manifest, name)) throw safeError("integrity");
    handle = await open(anchoredPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o7777) !== FILE_MODE) throw safeError("unsafe_path");
    const size = stats.size;
    if (size !== manifest[name].size) throw safeError("integrity");
    const expectedSha256 = manifest[name].sha256;
    await restoreOwnedMode(anchoredPath(directory, RESERVATION_MARKER));
    await restoreOwnedMode(anchoredPath(directory, COMMIT_MARKER));
    const pinned = handle;
    handle = undefined;
    let closed = false;
    let complete = false;
    let consumed = 0;
    let finalized = false;
    let resolveDigest!: (value: `sha256:${string}`) => void;
    let rejectDigest!: (reason?: unknown) => void;
    const digestPromise = new Promise<`sha256:${string}`>((resolveDigestValue, rejectDigestValue) => { resolveDigest = resolveDigestValue; rejectDigest = rejectDigestValue; });
    const digest = createHash("sha256");
    const finish = (success: boolean, reason?: unknown, value?: `sha256:${string}`): void => {
      if (finalized) return;
      finalized = true;
      if (success) resolveDigest(value ?? (`sha256:${digest.digest("hex")}` as `sha256:${string}`));
      else rejectDigest(reason ?? new Error("stream_closed"));
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (!complete) finish(false);
      await closeQuietly(pinned);
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) { controller.close(); return; }
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024);
          const result = await pinned.read(buffer, 0, buffer.byteLength, null);
          if (result.bytesRead === 0) {
            const actual = `sha256:${digest.digest("hex")}` as `sha256:${string}`;
            if (consumed !== size || actual !== expectedSha256) {
              complete = true;
              finish(false, safeError("integrity"));
              controller.error(safeError("integrity"));
              await close();
              return;
            }
            complete = true;
            finish(true, undefined, actual);
            controller.close();
            await close();
            return;
          }
          if (consumed + result.bytesRead > size) throw safeError("integrity");
          consumed += result.bytesRead;
          digest.update(buffer.subarray(0, result.bytesRead));
          controller.enqueue(new Uint8Array(buffer.subarray(0, result.bytesRead)));
        } catch (error) {
          finish(false);
          await close();
          controller.error(error);
        }
      },
      async cancel() { await close(); },
    });
    return { size, sha256: digestPromise, stream, close };
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  } finally {
    await closeQuietly(directory);
    if (tree) await closeTree(tree);
  }
}

async function openTree(root: string): Promise<{ paths: QualityPaths; root: FileHandle; dirs: Record<BundleKind, FileHandle>; ledger: FileHandle }> {
  const paths = await ensureQualityTree(root);
  const rootHandle = await openRootAnchored(paths.root);
  let ledger: FileHandle | undefined;
  const dirs: Partial<Record<BundleKind, FileHandle>> = {};
  try {
    ledger = await openDirectory(anchoredPath(rootHandle, "ledger"));
    for (const kind of BUNDLE_NAMES) dirs[kind] = await openDirectory(anchoredPath(rootHandle, kind === "case" ? "cases" : `${kind}s`));
    return { paths, root: rootHandle, dirs: dirs as Record<BundleKind, FileHandle>, ledger };
  } catch (error) {
    await Promise.all(Object.values(dirs).map(closeQuietly));
    await closeQuietly(ledger);
    await closeQuietly(rootHandle);
    throw error;
  }
}

async function assertLockSafe(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1) throw safeError("unsafe_path");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    if (error instanceof QualityStoreError) throw error;
    throw safeError("unsafe_path");
  } finally { await closeQuietly(handle); }
}

async function closeTree(tree: Awaited<ReturnType<typeof openTree>>): Promise<void> {
  await Promise.all([...Object.values(tree.dirs), tree.ledger, tree.root].map(closeQuietly));
}

async function entries(handle: FileHandle): Promise<Dirent[]> {
  try { return await readdir(anchoredPath(handle), { withFileTypes: true }); }
  catch { throw safeError("unsafe_path"); }
}

async function existingBundle(
  parent: FileHandle,
  id: string,
  expected: PreparedFiles,
): Promise<"missing" | "noop" | BundleResume> {
  const path = anchoredPath(parent, id);
  let current;
  try { current = await lstat(path); }
  catch (error) {
    if (codeOf(error) === "ENOENT") return "missing";
    throw safeError("unsafe_path");
  }
  if (current.isSymbolicLink() || !current.isDirectory()) throw safeError("unsafe_path");
  const directory = await openDirectory(path);
  try {
    const actualEntries = await entries(directory);
    const names = actualEntries.map((entry) => entry.name).sort();
    const expectedNames = Object.keys(expected).sort();
    let reservation: Reservation;
    try {
      const reservationStat = await lstat(anchoredPath(directory, RESERVATION_MARKER));
      if (reservationStat.isSymbolicLink() || !reservationStat.isFile()) throw safeError("unsafe_path");
      reservation = await readReservation(directory);
    } catch (error) {
      if (codeOf(error) === "ENOENT") throw safeError("integrity");
      throw error;
    }
    if (reservation.digest !== bundleDigest(expected)) throw safeError("integrity");
    const hasMarker = names.includes(COMMIT_MARKER);
    const temporaryNames = names.filter((name) => name.startsWith(".") && name.includes(".tmp-"));
    const allowedNames = hasMarker ? [...expectedNames, COMMIT_MARKER, RESERVATION_MARKER].sort() : [...expectedNames, RESERVATION_MARKER, ...temporaryNames].sort();
    if (names.some((name) => !allowedNames.includes(name))) throw safeError("integrity");
    if (hasMarker && (names.length !== allowedNames.length || !bytesEqual(await readPrivateMetadata(anchoredPath(directory, COMMIT_MARKER)), COMMIT_MARKER_BYTES))) throw safeError("integrity");
    const ownedTemps = new Map<string, string>();
    for (const name of temporaryNames) {
      const match = /^\.([a-z0-9.-]+)\.tmp-([0-9a-f]{32})$/.exec(name);
      if (!match || match[2] !== reservation.token || !Object.prototype.hasOwnProperty.call(expected, match[1])) throw safeError("integrity");
      const linked = await inspectTemp(directory, name, match[1], expected[match[1]]);
      if (linked) {
        await unlink(anchoredPath(directory, name));
        continue;
      }
      await restoreOwnedMode(anchoredPath(directory, name));
      ownedTemps.set(match[1], name);
    }
    for (const name of expectedNames) {
      if (!names.includes(name)) continue;
      validateFileName(name);
      if (!await payloadMatches(anchoredPath(directory, name), expected[name])) throw safeError("integrity");
    }
    await directory.chmod(DIRECTORY_MODE);
    for (const name of expectedNames) {
      if (!names.includes(name)) continue;
      await restoreOwnedMode(anchoredPath(directory, name));
    }
    if (hasMarker) {
      await restoreOwnedMode(anchoredPath(directory, COMMIT_MARKER));
      await restoreOwnedMode(anchoredPath(directory, RESERVATION_MARKER));
      if (names.length !== allowedNames.length) throw safeError("integrity");
      return "noop";
    }
    await restoreOwnedMode(anchoredPath(directory, RESERVATION_MARKER));
    return { status: "resume", reservation, temps: ownedTemps };
  } finally { await closeQuietly(directory); }
}

async function restoreOwnedMode(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw safeError("unsafe_path");
    await handle.chmod(FILE_MODE);
    await handle.sync();
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("unsafe_path");
  } finally { await closeQuietly(handle); }
}

async function writeBundleFile(
  directory: string,
  name: string,
  payload: PreparedFile,
  inject: PublishBundleInput["injectFault"],
  onCreated?: () => void,
): Promise<void> {
  let handle: FileHandle | undefined;
  let closed = false;
  try {
    handle = await open(join(directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, FILE_MODE);
    onCreated?.();
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw safeError("unsafe_path");
    await handle.chmod(FILE_MODE);
    await fault(inject, { scope: "bundle", operation: "write", timing: "before", file: name });
    if (payload.bytes) {
      await writeAll(handle, payload.bytes);
    } else if (payload.file) {
      let source: FileHandle | undefined;
      try {
        source = await open(payload.file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const sourceStat = await source.stat();
        if (!sourceStat.isFile() || sourceStat.nlink !== 1 || (sourceStat.mode & 0o7777) !== FILE_MODE || sourceStat.size !== payload.file.size) throw safeError("integrity");
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let size = 0;
        for (;;) {
          const read = await source.read(buffer, 0, buffer.byteLength, null);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
          if (size > payload.file.size) throw safeError("integrity");
          digest.update(buffer.subarray(0, read.bytesRead));
          await writeAllAt(handle, buffer.subarray(0, read.bytesRead), size - read.bytesRead);
        }
        const finalStat = await source.stat();
        if (finalStat.size !== size || size !== payload.file.size || `sha256:${digest.digest("hex")}` !== payload.file.sha256) throw safeError("integrity");
      } finally { await closeQuietly(source); }
    } else throw safeError("invalid_input");
    await fault(inject, { scope: "bundle", operation: "write", timing: "after", file: name });
    await fault(inject, { scope: "bundle", operation: "file_fsync", timing: "before", file: name });
    await handle.sync();
    await fault(inject, { scope: "bundle", operation: "file_fsync", timing: "after", file: name });
    await fault(inject, { scope: "bundle", operation: "close", timing: "before", file: name });
    await handle.close();
    closed = true;
    await fault(inject, { scope: "bundle", operation: "close", timing: "after", file: name });
  } finally { if (!closed) await closeQuietly(handle); }
}

function copyFiles(input: PublishBundleInput): PreparedFiles {
  validateKind(input.kind);
  validateBundleId(input.kind, input.id);
  if (!input.files || typeof input.files !== "object" || Array.isArray(input.files)) throw safeError("invalid_input");
  const result: Record<string, PreparedFile> = Object.create(null);
  for (const name of Object.keys(input.files)) {
    validateFileName(name);
    const descriptor = Object.getOwnPropertyDescriptor(input.files, name);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) throw safeError("invalid_input");
    result[name] = payloadMetadata(descriptor.value as BundleFilePayload);
  }
  if (Object.keys(result).length === 0) throw safeError("invalid_input");
  return Object.freeze(result);
}

async function verifyBundle(root: string, kind: BundleKind, id: string, expected: PreparedFiles): Promise<boolean> {
  let tree: Awaited<ReturnType<typeof openTree>> | undefined;
  let directory: FileHandle | undefined;
  try {
    tree = await openTree(root);
    directory = await openDirectory(anchoredPath(tree.dirs[kind], id), true);
    const names = (await entries(directory)).map((entry) => entry.name).sort();
    const expectedNames = [...Object.keys(expected), RESERVATION_MARKER, COMMIT_MARKER].sort();
    if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) return false;
    if (!bytesEqual(await readPrivateMetadata(anchoredPath(directory, COMMIT_MARKER)), COMMIT_MARKER_BYTES)) return false;
    try {
      const reservation = await readReservation(directory);
      if (reservation.digest !== bundleDigest(expected)) return false;
    } catch { return false; }
    for (const name of expectedNames) if (name !== COMMIT_MARKER && name !== RESERVATION_MARKER && !await payloadMatches(anchoredPath(directory, name), expected[name])) return false;
    return true;
  } catch { return false; }
  finally { await closeQuietly(directory); if (tree) await closeTree(tree); }
}

async function publishBundleLocked(input: PublishBundleInput, root: string, prepared = copyFiles(input)): Promise<CommitResult> {
  const files = prepared;
  const paths = await ensureQualityTree(validateRoot(root));
  await assertLockSafe(paths.labelsLock);
  let tree: Awaited<ReturnType<typeof openTree>> | undefined;
  const createdTemps: string[] = [];
  let committed = false;
  let commitPossible = false;
  let bundleDirectory: FileHandle | undefined;
  let createdDestination = false;
  let reservationDurable = false;
  let resumeInfo: BundleResume | undefined;
  let reservation: Reservation | undefined;
  try {
      await assertLockSafe(paths.labelsLock);
        tree = await openTree(paths.root);
        const parent = tree.dirs[input.kind];
        const finalPath = anchoredPath(parent, input.id);
        await fault(input.injectFault, { scope: "bundle", operation: "reserve", timing: "before" });
        let resume = false;
        try {
          await mkdir(finalPath, DIRECTORY_MODE);
          createdDestination = true;
        } catch (error) {
          if (codeOf(error) !== "EEXIST") throw error;
          const prior = await existingBundle(parent, input.id, files);
          if (prior === "noop") return { status: "noop" };
          if (prior === "missing") throw safeError("integrity");
          resumeInfo = prior;
          resume = true;
          reservation = prior.reservation;
        }
        bundleDirectory = await openDirectory(finalPath);
        await bundleDirectory.chmod(DIRECTORY_MODE);
        const anchoredBundle = anchoredPath(bundleDirectory);
        if (!reservation) {
          const token = randomBytes(16).toString("hex");
          reservation = { digest: bundleDigest(files), token };
          await writeBundleFile(anchoredBundle, RESERVATION_MARKER, payloadMetadata(reservationBytes(files, token)), input.injectFault);
          await bundleDirectory.sync();
          reservationDurable = true;
          await fault(input.injectFault, { scope: "bundle", operation: "reserve", timing: "after" });
        }
        for (const name of Object.keys(files)) {
          const orphan = resumeInfo?.temps.get(name);
          if (resume) {
            try {
              if (await payloadMatches(join(anchoredBundle, name), files[name])) {
                if (orphan) await unlink(join(anchoredBundle, orphan));
                continue;
              }
            } catch (error) {
              if (!(error instanceof QualityStoreError && error.code === "unsafe_path")) throw error;
            }
          }
          if (orphan) {
            await restoreOwnedMode(join(anchoredBundle, orphan));
            await link(join(anchoredBundle, orphan), join(anchoredBundle, name));
            await unlink(join(anchoredBundle, orphan));
            continue;
          }
          const temporaryName = `.${name}.tmp-${randomBytes(12).toString("hex")}`;
          const temporaryPath = join(anchoredBundle, temporaryName);
          await writeBundleFile(anchoredBundle, temporaryName, files[name], input.injectFault, () => createdTemps.push(temporaryPath));
          await link(temporaryPath, join(anchoredBundle, name));
          await unlink(temporaryPath);
          createdTemps.pop();
        }
        await fault(input.injectFault, { scope: "bundle", operation: "temp_dir_fsync", timing: "before" });
        await bundleDirectory.sync();
        await fault(input.injectFault, { scope: "bundle", operation: "temp_dir_fsync", timing: "after" });
        await fault(input.injectFault, { scope: "bundle", operation: "rename", timing: "before" });
        commitPossible = true;
          await writeBundleFile(anchoredBundle, COMMIT_MARKER, payloadMetadata(COMMIT_MARKER_BYTES), input.injectFault);
        await bundleDirectory.sync();
        await fault(input.injectFault, { scope: "bundle", operation: "rename", timing: "after" });
        await fault(input.injectFault, { scope: "bundle", operation: "parent_fsync", timing: "before" });
        await parent.sync();
        await fault(input.injectFault, { scope: "bundle", operation: "parent_fsync", timing: "after" });
        committed = true;
        return { status: "committed" };
  } catch (error) {
        if (commitPossible) {
          return (await verifyBundle(paths.root, input.kind, input.id, files))
            ? { status: "committed_durability_uncertain" }
            : { status: "indeterminate" };
        }
        if (error instanceof QualityStoreError) throw error;
        throw safeError("integrity");
  } finally {
        if (!committed) await Promise.all(createdTemps.map(async (path) => { try { await unlink(path); } catch { /* only our temp */ } }));
        await closeQuietly(bundleDirectory);
        if (createdDestination && !reservationDurable) {
          try { await rm(anchoredPath(tree!.dirs[input.kind], input.id), { recursive: true, force: true }); } catch { /* only our unreserved directory */ }
        }
        if (tree) await closeTree(tree);
  }
}

export async function publishBundle(input: PublishBundleInput, root = DEFAULT_QUALITY_ROOT): Promise<CommitResult> {
  const prepared = copyFiles(input);
  const paths = await ensureQualityTree(validateRoot(root));
  await assertLockSafe(paths.labelsLock);
  try {
    return await withCorpusLock(paths.labelsLock, () => publishBundleLocked(input, paths.root, prepared));
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    const code = codeOf(error);
    if (code === "lock_timeout" || code === "lock_unavailable") throw error as CorpusLockError;
    throw safeError("integrity");
  }
}

function eventIdOf(event: QualityLabelEvent): string {
  try {
    if (!event || typeof event !== "object" || typeof event.eventId !== "string" || event.eventId.length === 0) throw safeError("invalid_input");
    return event.eventId;
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("invalid_input");
  }
}

async function verifyLabel(root: string, wantedId: string, wantedLine: Buffer): Promise<boolean> {
  let tree: Awaited<ReturnType<typeof openTree>> | undefined;
  try {
    tree = await openTree(root);
    let bytes: Uint8Array;
    try { bytes = await readRegular(anchoredPath(tree.ledger, "labels.jsonl")); }
    catch { return false; }
    const text = Buffer.from(bytes).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && (parsed as { eventId?: unknown }).eventId === wantedId) {
          return Buffer.from(`${canonicalJson(parsed)}\n`).equals(wantedLine);
        }
      } catch { return false; }
    }
    return false;
  } catch { return false; }
  finally { if (tree) await closeTree(tree); }
}

async function ledgerState(path: string, wantedId: string, wantedLine: Buffer): Promise<{ existing: Uint8Array; noop: boolean }> {
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()) throw safeError("unsafe_path");
    bytes = await readRegular(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") bytes = new Uint8Array();
    else if (!(error instanceof QualityStoreError && error.code === "missing")) throw error;
  }
  if (bytes.byteLength === 0) return { existing: bytes, noop: false };
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n")) throw safeError("integrity");
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw safeError("integrity"); }
    if (!parsed || typeof parsed !== "object" || !Object.prototype.hasOwnProperty.call(parsed, "eventId")) throw safeError("integrity");
    if ((parsed as { eventId?: unknown }).eventId === wantedId) {
      let normalized: Buffer;
      try { normalized = Buffer.from(`${canonicalJson(parsed)}\n`); } catch { throw safeError("integrity"); }
      if (!bytesEqual(normalized, wantedLine)) throw safeError("integrity");
      return { existing: bytes, noop: true };
    }
  }
  return { existing: bytes, noop: false };
}

async function restoreLedgerMode(path: string): Promise<void> {
  await restoreOwnedMode(path);
}

async function appendLabelEventLocked(
  event: QualityLabelEvent,
  root = DEFAULT_QUALITY_ROOT,
  options: AppendLabelOptions = {},
): Promise<CommitResult> {
  const eventId = eventIdOf(event);
  const line = Buffer.from(`${canonicalJson(event)}\n`);
  const paths = await ensureQualityTree(validateRoot(root));
  await assertLockSafe(paths.labelsLock);
  try {
      await assertLockSafe(paths.labelsLock);
      let tree: Awaited<ReturnType<typeof openTree>> | undefined;
      let tempPath: string | undefined;
      let tempCreated = false;
      let renamed = false;
      let renamePossible = false;
      try {
        tree = await openTree(paths.root);
        const current = await ledgerState(anchoredPath(tree.ledger, "labels.jsonl"), eventId, line);
        if (current.noop) {
          await restoreLedgerMode(anchoredPath(tree.ledger, "labels.jsonl"));
          return { status: "noop" };
        }
        // Idempotent replays must remain no-ops even when a guard's target has
        // since changed state; guards protect only a new append.
        await options.beforeCommit?.();
        const tempSuffix = options.tempSuffix ?? randomBytes(12).toString("hex");
        if (!/^[0-9a-z-]{1,64}$/.test(tempSuffix)) throw safeError("invalid_input");
        tempPath = anchoredPath(tree.ledger, `.labels.jsonl.tmp-${tempSuffix}`);
        const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, FILE_MODE);
        tempCreated = true;
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.nlink !== 1) throw safeError("unsafe_path");
          await handle.chmod(FILE_MODE);
          await fault(options.injectFault, { scope: "ledger", operation: "write", timing: "before" });
          await writeAll(handle, Buffer.concat([Buffer.from(current.existing), line]));
          await fault(options.injectFault, { scope: "ledger", operation: "write", timing: "after" });
          await fault(options.injectFault, { scope: "ledger", operation: "file_fsync", timing: "before" });
          await handle.sync();
          await fault(options.injectFault, { scope: "ledger", operation: "file_fsync", timing: "after" });
          await fault(options.injectFault, { scope: "ledger", operation: "close", timing: "before" });
          await handle.close();
          await fault(options.injectFault, { scope: "ledger", operation: "close", timing: "after" });
        } finally { await closeQuietly(handle); }
        await fault(options.injectFault, { scope: "ledger", operation: "rename", timing: "before" });
        renamePossible = true;
        await rename(tempPath, anchoredPath(tree.ledger, "labels.jsonl"));
        renamed = true;
        await fault(options.injectFault, { scope: "ledger", operation: "rename", timing: "after" });
        await fault(options.injectFault, { scope: "ledger", operation: "parent_fsync", timing: "before" });
        await tree.ledger.sync();
        await fault(options.injectFault, { scope: "ledger", operation: "parent_fsync", timing: "after" });
        return { status: "committed" };
      } catch (error) {
        if (renamePossible) {
          return (await verifyLabel(paths.root, eventId, line))
            ? { status: "committed_durability_uncertain" }
            : { status: "indeterminate" };
        }
        if (error instanceof QualityStoreError) throw error;
        throw safeError("integrity");
      } finally {
        if (!renamed && tempCreated) {
          try { await unlink(tempPath!); } catch { /* only our temp */ }
        }
        if (tree) await closeTree(tree);
      }
    return { status: "indeterminate" };
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    const code = codeOf(error);
    if (code === "lock_timeout" || code === "lock_unavailable") throw error as CorpusLockError;
    throw safeError("integrity");
  }
}

export async function appendLabelEvent(
  event: QualityLabelEvent,
  root = DEFAULT_QUALITY_ROOT,
  options: AppendLabelOptions = {},
): Promise<CommitResult> {
  const paths = await ensureQualityTree(validateRoot(root));
  await assertLockSafe(paths.labelsLock);
  try {
    return await withCorpusLock(paths.labelsLock, () => appendLabelEventLocked(event, paths.root, options));
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    const code = codeOf(error);
    if (code === "lock_timeout" || code === "lock_unavailable") throw error as CorpusLockError;
    throw safeError("integrity");
  }
}

/** Read the permanent destination lock without acquiring labels.lock. Callers
 * must invoke this only from a callback already holding that lock. */
export async function qualityDestination(root: string, feedbackId: string): Promise<"eval" | "holdout" | null> {
  const paths = await ensureQualityTree(validateRoot(root));
  try {
    const current = await lstat(paths.labelsFile);
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) throw safeError("unsafe_path");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    if (error instanceof QualityStoreError) throw error;
    throw safeError("unsafe_path");
  }
  const bytes = await readRegular(paths.labelsFile);
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) throw safeError("integrity");
  let destination: "eval" | "holdout" | null = null;
  const lines = Buffer.from(bytes).toString("utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw safeError("integrity"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw safeError("integrity");
    const record = value as Record<string, unknown>;
    if (record.action === "retire") {
      if (typeof record.targetEventId !== "string" || record.targetEventId.length === 0) throw safeError("integrity");
      continue;
    }
    if (record.action !== "label" || typeof record.eventId !== "string" || typeof record.feedbackId !== "string" || (record.set !== "eval" && record.set !== "holdout")) throw safeError("integrity");
    if (record.feedbackId !== feedbackId) continue;
    const set = record.set as "eval" | "holdout";
    if (destination !== null && destination !== set) throw safeError("integrity");
    destination = set;
  }
  return destination;
}

/** Validate that a correction targets an existing, currently active label.
 * This is intended for an appendLabelEvent beforeCommit callback. */
export async function qualityRetirementTarget(root: string, targetEventId: string): Promise<void> {
  const paths = await ensureQualityTree(validateRoot(root));
  const bytes = await readRegular(paths.labelsFile);
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) throw safeError("integrity");
  const labels = new Set<string>();
  const retired = new Set<string>();
  for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw safeError("integrity"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw safeError("integrity");
    const record = value as Record<string, unknown>;
    if (record.action === "retire") {
      if (typeof record.targetEventId !== "string" || record.targetEventId.length === 0) throw safeError("integrity");
      retired.add(record.targetEventId);
    } else if (record.action === "label" && typeof record.eventId === "string" && record.eventId.length > 0) labels.add(record.eventId);
    else throw safeError("integrity");
  }
  if (!labels.has(targetEventId) || retired.has(targetEventId)) throw safeError("integrity");
}

/** Publish a case and its active label while holding the single corpus lock.
 * A crash after the case commit leaves a harmless orphan; retry observes the
 * content-addressed case and appends the idempotent label event. */
export async function publishCaseAndLabel(
  bundle: PublishBundleInput,
  event: QualityLabelEvent,
  root = DEFAULT_QUALITY_ROOT,
  beforeLabel?: () => void | Promise<void>,
): Promise<CommitResult> {
  const prepared = copyFiles(bundle);
  const paths = await ensureQualityTree(validateRoot(root));
  await assertLockSafe(paths.labelsLock);
  try {
    return await withCorpusLock(paths.labelsLock, async () => {
      const published = await publishBundleLocked(bundle, paths.root, prepared);
      if (published.status === "indeterminate") return published;
      const labelled = await appendLabelEventLocked(event, paths.root, { beforeCommit: beforeLabel });
      if (labelled.status === "indeterminate") return labelled;
      if (published.status === "committed_durability_uncertain" || labelled.status === "committed_durability_uncertain") {
        return { status: "committed_durability_uncertain" };
      }
      return published.status === "noop" && labelled.status === "noop" ? { status: "noop" } : { status: "committed" };
    });
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    const code = codeOf(error);
    if (code === "lock_timeout" || code === "lock_unavailable") throw error as CorpusLockError;
    throw safeError("integrity");
  }
}

export async function readBundle(kind: BundleKind, id: string, root = DEFAULT_QUALITY_ROOT): Promise<ReadonlyMap<string, Uint8Array>> {
  validateKind(kind);
  validateBundleId(kind, id);
  let tree: Awaited<ReturnType<typeof openTree>> | undefined;
  let directory: FileHandle | undefined;
  try {
    tree = await openTree(validateRoot(root));
    directory = await openDirectory(anchoredPath(tree.dirs[kind], id), true);
    const result = new Map<string, Uint8Array>();
    let totalBytes = 0;
    for (const entry of await entries(directory)) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw safeError("unsafe_path");
      if (entry.name === COMMIT_MARKER || entry.name === RESERVATION_MARKER) continue;
      validateFileName(entry.name);
      const remaining = MAX_READ_BUNDLE_TOTAL_BYTES - totalBytes;
      if (remaining < 0) throw safeError("too_large");
      const bytes = await readRegularCapped(anchoredPath(directory, entry.name), Math.min(MAX_READ_BUNDLE_FILE_BYTES, remaining));
      totalBytes += bytes.byteLength;
      result.set(entry.name, bytes);
    }
    const reservation = await readReservation(directory);
    try {
      const marker = await lstat(anchoredPath(directory, COMMIT_MARKER));
      if (marker.isSymbolicLink() || !marker.isFile()) throw safeError("unsafe_path");
    } catch (error) {
      if (codeOf(error) === "ENOENT") throw safeError("missing");
      throw error;
    }
    if (!bytesEqual(await readPrivateMetadata(anchoredPath(directory, COMMIT_MARKER)), COMMIT_MARKER_BYTES)) throw safeError("integrity");
    if (result.size === 0) throw safeError("integrity");
    const actualFiles: Record<string, PreparedFile> = Object.create(null);
    for (const [name, bytes] of result) actualFiles[name] = payloadMetadata(bytes);
    if (reservation.digest !== bundleDigest(actualFiles)) throw safeError("integrity");
    await directory.chmod(DIRECTORY_MODE);
    await restoreOwnedMode(anchoredPath(directory, RESERVATION_MARKER));
    await restoreOwnedMode(anchoredPath(directory, COMMIT_MARKER));
    for (const name of result.keys()) await restoreOwnedMode(anchoredPath(directory, name));
    return result;
  } catch (error) {
    if (error instanceof QualityStoreError) throw error;
    throw safeError("unsafe_path");
  } finally { await closeQuietly(directory); if (tree) await closeTree(tree); }
}
