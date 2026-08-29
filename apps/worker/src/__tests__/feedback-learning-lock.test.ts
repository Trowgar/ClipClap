import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { withCorpusLock } from "../feedback-learning/lock";

interface ChildMessage {
  type: "locked" | "result";
  code?: string;
  elapsedMs?: number;
  isFile?: boolean;
  message?: string;
  mode?: number;
}

const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clipclap-corpus-lock-"));
  temporaryDirectories.push(directory);
  return join(directory, "reviews.lock");
}

function spawnLockChild(lockPath: string, mode: "hold" | "try"): ChildProcess {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "apps/worker/src/feedback-learning/lock.ts")
  ).href;
  const source = `
    import { stat } from "node:fs/promises";
    import { withCorpusLock } from ${JSON.stringify(moduleUrl)};

    const startedAt = Date.now();
    try {
      await withCorpusLock(
        ${JSON.stringify(lockPath)},
        async () => {
          const lockStat = await stat(${JSON.stringify(lockPath)});
          process.send?.({
            type: "locked",
            isFile: lockStat.isFile(),
            mode: lockStat.mode & 0o777,
          });
          if (${JSON.stringify(mode)} === "hold") {
            setInterval(() => undefined, 60_000);
            await new Promise(() => undefined);
          }
        },
        { retryMs: 25, timeoutMs: 250 }
      );
      process.send?.({ type: "result", elapsedMs: Date.now() - startedAt });
    } catch (error) {
      process.send?.({
        type: "result",
        code: error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "unexpected_error",
        elapsedMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : "unexpected_error",
      });
    }
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function nextMessage(child: ChildProcess): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: ChildMessage) => {
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`lock child exited before reporting: code=${code} signal=${signal}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("withCorpusLock", () => {
  it("runs the callback while reviews.lock is a regular 0600 file", async () => {
    const lockPath = await temporaryLockPath();
    const child = spawnLockChild(lockPath, "try");

    await expect(nextMessage(child)).resolves.toEqual({
      type: "locked",
      isFile: true,
      mode: 0o600,
    });
    await stopChild(child);
  });

  it("retries real process contention and reports only lock_timeout", async () => {
    const lockPath = await temporaryLockPath();
    const holder = spawnLockChild(lockPath, "hold");
    await expect(nextMessage(holder)).resolves.toMatchObject({ type: "locked" });

    const contender = spawnLockChild(lockPath, "try");
    const result = await nextMessage(contender);

    expect(result).toMatchObject({
      type: "result",
      code: "lock_timeout",
      message: "lock_timeout",
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
    expect(JSON.stringify(result)).not.toContain(lockPath);
  });

  it("lets another process acquire after the holder is killed", async () => {
    const lockPath = await temporaryLockPath();
    const holder = spawnLockChild(lockPath, "hold");
    await expect(nextMessage(holder)).resolves.toMatchObject({ type: "locked" });

    await stopChild(holder);

    const successor = spawnLockChild(lockPath, "try");
    await expect(nextMessage(successor)).resolves.toMatchObject({ type: "locked" });
    await stopChild(successor);
  });

  it("returns the callback value in the calling process", async () => {
    const lockPath = await temporaryLockPath();

    await expect(withCorpusLock(lockPath, async () => "done")).resolves.toBe("done");
  });
});
