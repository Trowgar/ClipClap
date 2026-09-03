import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { flock } from "fs-ext";

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export interface LockOptions {
  retryMs?: number;
  timeoutMs?: number;
  nowNs?: () => bigint;
  delay?: (ms: number) => Promise<void>;
}

export type CorpusLockIdentity = Readonly<{
  dev: number;
  ino: number;
}>;

export type CorpusLockErrorCode = "lock_timeout" | "lock_unavailable";

export class CorpusLockError extends Error {
  readonly code: CorpusLockErrorCode;

  constructor(code: CorpusLockErrorCode) {
    super(code);
    this.name = "CorpusLockError";
    this.code = code;
  }
}

function flockAsync(fd: number, flags: "exnb" | "un"): Promise<void> {
  return new Promise((resolve, reject) => {
    flock(fd, flags, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNanoseconds(milliseconds: number): bigint {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new CorpusLockError("lock_unavailable");
  }
  return BigInt(Math.ceil(milliseconds * Number(NANOSECONDS_PER_MILLISECOND)));
}

function isContention(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "EAGAIN" || error.code === "EWOULDBLOCK";
}

async function openLockFile(lockPath: string): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600
    );
    if (!(await handle.stat()).isFile()) throw new CorpusLockError("lock_unavailable");
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The public error below deliberately hides filesystem details.
      }
    }
    if (error instanceof CorpusLockError) throw error;
    throw new CorpusLockError("lock_unavailable");
  }
}

async function acquireLock(
  handle: FileHandle,
  retryMs: number,
  timeoutMs: number,
  nowNs: () => bigint,
  delay: (ms: number) => Promise<void>
): Promise<void> {
  const deadline = nowNs() + toNanoseconds(timeoutMs);
  const retryNs = toNanoseconds(retryMs);

  for (;;) {
    try {
      await flockAsync(handle.fd, "exnb");
      return;
    } catch (error) {
      if (!isContention(error)) throw new CorpusLockError("lock_unavailable");
    }

    const remainingNs = deadline - nowNs();
    if (remainingNs <= 0n) throw new CorpusLockError("lock_timeout");

    const waitNs = retryNs < remainingNs ? retryNs : remainingNs;
    const waitMs = Number((waitNs + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND);
    await delay(waitMs);

    if (nowNs() >= deadline) throw new CorpusLockError("lock_timeout");
  }
}

export async function withCorpusLock<T>(
  lockPath: string,
  operation: (identity: CorpusLockIdentity) => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nowNs = options.nowNs ?? process.hrtime.bigint;
  const delay = options.delay ?? defaultDelay;

  const handle = await openLockFile(lockPath);

  let locked = false;
  let primaryFailure = false;
  try {
    await acquireLock(handle, retryMs, timeoutMs, nowNs, delay);
    locked = true;
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw new CorpusLockError("lock_unavailable");
    return await operation(Object.freeze({ dev: stats.dev, ino: stats.ino }));
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    let cleanupFailed = false;
    if (locked) {
      try {
        await flockAsync(handle.fd, "un");
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await handle.close();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed && !primaryFailure) throw new CorpusLockError("lock_unavailable");
  }
}
