import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename as renamePath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  PersistenceIntegrityError,
  ensurePrivateTree,
  publishRunAtomically,
  readPublishedCandidateSnapshot,
  readLedgerSnapshot,
  replaceLedgerAtomically,
  type PersistenceFault,
  type PrivatePaths,
  type RunFiles,
} from "../feedback-learning/persistence";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();
const execFileAsync = promisify(execFile);
const PRIVATE_TREE_ROOT_OPEN_TEST_HOOK = Symbol.for(
  "clipclap.feedback-learning.persistence.private-tree-root-open-test-hook"
);
const PRIVATE_TREE_READY_TEST_HOOK = Symbol.for(
  "clipclap.feedback-learning.persistence.private-tree-ready-test-hook"
);
const PUBLISHED_CANDIDATE_READY_TEST_HOOK = Symbol.for(
  "clipclap.feedback-learning.persistence.published-candidate-ready-test-hook"
);

function testHookGlobal(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

async function temporaryRoot(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "clipclap-corpus-persistence-"));
  temporaryDirectories.push(parent);
  return { parent, root: join(parent, "feedback-learning") };
}

async function privatePaths(): Promise<PrivatePaths> {
  const { root } = await temporaryRoot();
  return ensurePrivateTree(root);
}

function mode(stat: { mode: number }): number {
  return stat.mode & 0o777;
}

function ledgerBytes(eventId: string): Uint8Array {
  return encoder.encode(`${JSON.stringify({ schemaVersion: 1, eventId })}\n`);
}

function runFiles(runId: string, runDigest: string): RunFiles {
  return {
    "run.json": encoder.encode(`${JSON.stringify({ schemaVersion: 1, runId, runDigest })}\n`),
    "candidates.jsonl": encoder.encode('{"candidate":1}\n'),
    "candidates.md": encoder.encode("# candidates\n"),
    "exclusions.jsonl": new Uint8Array(),
  };
}

function sameFault(actual: PersistenceFault, expected: PersistenceFault): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function failAt(expected: PersistenceFault): (actual: PersistenceFault) => void {
  return (actual) => {
    if (sameFault(actual, expected)) throw new Error(`injected:${JSON.stringify(expected)}`);
  };
}

afterEach(async () => {
  delete testHookGlobal()[PRIVATE_TREE_ROOT_OPEN_TEST_HOOK];
  delete testHookGlobal()[PRIVATE_TREE_READY_TEST_HOOK];
  delete testHookGlobal()[PUBLISHED_CANDIDATE_READY_TEST_HOOK];
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("readPublishedCandidateSnapshot", () => {
  it("reads exact isolated candidate bytes and repairs private modes", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDirectory = join(paths.exportsDir, runId);
    const expected = encoder.encode('{"candidate":1}\n');
    await mkdir(runDirectory, 0o755);
    await writeFile(join(runDirectory, "candidates.jsonl"), expected, { mode: 0o644 });

    const actual = await readPublishedCandidateSnapshot(paths, runId);

    expect(actual).toEqual(expected);
    expect(actual).not.toBe(expected);
    expect(mode(await lstat(runDirectory))).toBe(0o700);
    expect(mode(await lstat(join(runDirectory, "candidates.jsonl")))).toBe(0o600);
  });

  it.each(["missing", "symlink", "directory", "fifo"] as const)(
    "rejects a %s candidate file",
    async (kind) => {
      const paths = await privatePaths();
      const runId = "eval-0123456789abcdef";
      const runDirectory = join(paths.exportsDir, runId);
      const external = join((await temporaryRoot()).parent, "external-candidates");
      await mkdir(runDirectory, 0o700);
      await writeFile(external, "PRIVATE_EXTERNAL");
      if (kind === "symlink") await symlink(external, join(runDirectory, "candidates.jsonl"));
      if (kind === "directory") await mkdir(join(runDirectory, "candidates.jsonl"));
      if (kind === "fifo") await execFileAsync("mkfifo", [join(runDirectory, "candidates.jsonl")]);

      await expect(readPublishedCandidateSnapshot(paths, runId)).rejects.toMatchObject({
        code: "unsafe_path",
      });
      expect(await readFile(external, "utf8")).toBe("PRIVATE_EXTERNAL");
    },
  );

  it("rejects unsafe run components before opening exports", async () => {
    const paths = await privatePaths();
    await expect(readPublishedCandidateSnapshot(paths, "../escape")).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it.each(["root", "exports", "run"] as const)(
    "rejects a %s replacement while preserving external candidate bytes",
    async (component) => {
      const { parent, root } = await temporaryRoot();
      const paths = await ensurePrivateTree(root);
      const runId = "holdout-0123456789abcdef";
      const runDirectory = join(paths.exportsDir, runId);
      await mkdir(runDirectory, 0o700);
      await writeFile(join(runDirectory, "candidates.jsonl"), "TRUSTED\n", { mode: 0o600 });
      const parked = join(parent, `parked-candidate-${component}`);
      const external = join(parent, `external-candidate-${component}`);
      if (component === "root") {
        await mkdir(external, 0o700);
        await mkdir(join(external, "exports"), 0o700);
        await mkdir(join(external, "ledger"), 0o700);
        await mkdir(join(external, "exports", runId), 0o700);
        await writeFile(join(external, "exports", runId, "candidates.jsonl"), "PRIVATE_EXTERNAL\n");
      } else if (component === "exports") {
        await mkdir(external, 0o700);
        await mkdir(join(external, runId), 0o700);
        await writeFile(join(external, runId, "candidates.jsonl"), "PRIVATE_EXTERNAL\n");
      } else {
        await mkdir(external, 0o700);
        await writeFile(join(external, "candidates.jsonl"), "PRIVATE_EXTERNAL\n");
      }
      const hook = async () => {
        const target = component === "root" ? paths.root : component === "exports" ? paths.exportsDir : runDirectory;
        await renamePath(target, parked);
        await symlink(external, target);
      };
      testHookGlobal()[component === "run" ? PUBLISHED_CANDIDATE_READY_TEST_HOOK : PRIVATE_TREE_READY_TEST_HOOK] = hook;

      let failure: unknown;
      try {
        await readPublishedCandidateSnapshot(paths, runId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "unsafe_path" });
      expect(String(failure)).not.toContain("PRIVATE_EXTERNAL");
    },
  );
});

describe("readLedgerSnapshot", () => {
  it("returns zero bytes when the anchored ledger file is missing", async () => {
    const paths = await privatePaths();

    await expect(readLedgerSnapshot(paths)).resolves.toEqual(new Uint8Array());
  });

  it("returns an isolated exact byte snapshot from an anchored regular file", async () => {
    const paths = await privatePaths();
    const expected = ledgerBytes("event-read");
    await writeFile(paths.reviewsFile, expected, { mode: 0o600 });

    const actual = await readLedgerSnapshot(paths);

    expect(actual).toEqual(expected);
    expect(actual).not.toBe(expected);
  });

  it.each([0o644, 0o666])("repairs an existing ledger mode %o before reading", async (fileMode) => {
    const paths = await privatePaths();
    const expected = ledgerBytes("event-mode");
    await writeFile(paths.reviewsFile, expected, { mode: fileMode });
    await chmod(paths.reviewsFile, fileMode);

    expect(await readLedgerSnapshot(paths)).toEqual(expected);
    expect(mode(await lstat(paths.reviewsFile))).toBe(0o600);
  });

  it.each(["symlink", "directory"] as const)(
    "rejects a final %s without reading an external target",
    async (kind) => {
      const paths = await privatePaths();
      const external = join((await temporaryRoot()).parent, "external-ledger");
      await writeFile(external, "private-outside");
      if (kind === "symlink") await symlink(external, paths.reviewsFile);
      else await mkdir(paths.reviewsFile);

      await expect(readLedgerSnapshot(paths)).rejects.toMatchObject({ code: "unsafe_path" });
      expect(await readFile(external, "utf8")).toBe("private-outside");
    },
  );

  it("rejects a root replacement during private-tree validation", async () => {
    const { parent, root } = await temporaryRoot();
    const paths = await ensurePrivateTree(root);
    const parkedRoot = join(parent, "parked-root-read");
    const externalRoot = join(parent, "external-root-read");
    await mkdir(externalRoot, 0o700);
    await mkdir(join(externalRoot, "exports"), 0o700);
    await mkdir(join(externalRoot, "ledger"), 0o700);
    await writeFile(join(externalRoot, "ledger", "reviews.jsonl"), "private-outside");
    testHookGlobal()[PRIVATE_TREE_ROOT_OPEN_TEST_HOOK] = async () => {
      await renamePath(root, parkedRoot);
      await symlink(externalRoot, root);
    };

    await expect(readLedgerSnapshot(paths)).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(join(externalRoot, "ledger", "reviews.jsonl"), "utf8")).toBe(
      "private-outside",
    );
  });

  it.each(["root", "ledger"] as const)(
    "rejects a %s replacement after the trusted tree is continuously anchored",
    async (component) => {
      const { parent, root } = await temporaryRoot();
      const paths = await ensurePrivateTree(root);
      await writeFile(paths.reviewsFile, ledgerBytes("trusted"), { mode: 0o600 });
      const parked = join(parent, `parked-${component}-read`);
      const external = join(parent, `external-${component}-read`);
      if (component === "root") {
        await mkdir(external, 0o700);
        await mkdir(join(external, "exports"), 0o700);
        await mkdir(join(external, "ledger"), 0o700);
        await writeFile(join(external, "ledger", "reviews.jsonl"), "PRIVATE_EXTERNAL");
      } else {
        await mkdir(external, 0o700);
        await writeFile(join(external, "reviews.jsonl"), "PRIVATE_EXTERNAL");
      }
      testHookGlobal()[PRIVATE_TREE_READY_TEST_HOOK] = async () => {
        const target = component === "root" ? paths.root : paths.ledgerDir;
        await renamePath(target, parked);
        await symlink(external, target);
      };

      let failure: unknown;
      try {
        await readLedgerSnapshot(paths);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "unsafe_path" });
      expect(String(failure)).not.toContain("PRIVATE_EXTERNAL");
    },
  );
});

describe("ensurePrivateTree", () => {
  it("creates only the V1-owned tree as exact 0700 under a permissive umask", async () => {
    const { parent, root } = await temporaryRoot();
    await chmod(parent, 0o755);
    const previousUmask = process.umask(0);
    let paths: PrivatePaths;
    try {
      paths = await ensurePrivateTree(root);
    } finally {
      process.umask(previousUmask);
    }

    expect(paths).toEqual({
      root,
      exportsDir: join(root, "exports"),
      ledgerDir: join(root, "ledger"),
      reviewsFile: join(root, "ledger", "reviews.jsonl"),
      lockFile: join(root, "ledger", "reviews.lock"),
    });
    expect(mode(await lstat(parent))).toBe(0o755);
    for (const directory of [paths.root, paths.exportsDir, paths.ledgerDir]) {
      const stat = await lstat(directory);
      expect(stat.isDirectory()).toBe(true);
      expect(mode(stat)).toBe(0o700);
    }
  });

  it("repairs modes only on existing V1-owned directories", async () => {
    const { parent, root } = await temporaryRoot();
    await chmod(parent, 0o751);
    await mkdir(root, 0o755);
    await mkdir(join(root, "exports"), 0o755);
    await mkdir(join(root, "ledger"), 0o755);

    const paths = await ensurePrivateTree(root);

    expect(mode(await lstat(parent))).toBe(0o751);
    expect(mode(await lstat(paths.root))).toBe(0o700);
    expect(mode(await lstat(paths.exportsDir))).toBe(0o700);
    expect(mode(await lstat(paths.ledgerDir))).toBe(0o700);
  });

  it("fsyncs every owned directory inode and the root parent entry in protocol order", async () => {
    const { parent, root } = await temporaryRoot();
    await chmod(parent, 0o751);
    const probe = await open(parent, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      fd: number;
      sync(): Promise<void>;
    };
    const originalSync = prototype.sync;
    const syncedPaths: string[] = [];
    await probe.close();
    prototype.sync = async function (): Promise<void> {
      syncedPaths.push(await readlink(`/proc/self/fd/${this.fd}`));
      await originalSync.call(this);
    };

    try {
      await ensurePrivateTree(root);
    } finally {
      prototype.sync = originalSync;
    }

    expect(syncedPaths).toEqual([
      root,
      parent,
      join(root, "exports"),
      join(root, "ledger"),
      root,
    ]);
    expect(mode(await lstat(parent))).toBe(0o751);
  });

  it.each(["root", "exports", "ledger"] as const)(
    "rejects a symlink at the owned %s component without touching its external target",
    async (component) => {
      const { parent, root } = await temporaryRoot();
      const external = join(parent, `external-${component}`);
      await mkdir(external, 0o755);
      await writeFile(join(external, "sentinel"), "outside");

      if (component === "root") {
        await symlink(external, root);
      } else {
        await mkdir(root, 0o700);
        if (component === "ledger") await mkdir(join(root, "exports"), 0o700);
        await symlink(external, join(root, component));
      }

      await expect(ensurePrivateTree(root)).rejects.toMatchObject({ code: "unsafe_path" });
      expect(await readFile(join(external, "sentinel"), "utf8")).toBe("outside");
      expect(mode(await lstat(external))).toBe(0o755);
    }
  );

  it("anchors child setup to the opened root when the public root is replaced", async () => {
    const { parent, root } = await temporaryRoot();
    const originalRoot = `${root}-original`;
    const externalRoot = join(parent, "external-root");
    const externalExports = join(externalRoot, "exports");
    await mkdir(externalRoot, 0o755);
    await mkdir(externalExports, 0o751);
    await writeFile(join(externalExports, "sentinel"), "outside", { mode: 0o640 });
    let hookCalled = false;
    testHookGlobal()[PRIVATE_TREE_ROOT_OPEN_TEST_HOOK] = async () => {
      hookCalled = true;
      await renamePath(root, originalRoot);
      await symlink(externalRoot, root);
    };

    await expect(ensurePrivateTree(root)).rejects.toMatchObject({ code: "unsafe_path" });

    expect(hookCalled).toBe(true);
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
    for (const directory of [
      originalRoot,
      join(originalRoot, "exports"),
      join(originalRoot, "ledger"),
    ]) {
      expect((await lstat(directory)).isDirectory()).toBe(true);
      expect(mode(await lstat(directory))).toBe(0o700);
    }
    expect(mode(await lstat(externalRoot))).toBe(0o755);
    expect(mode(await lstat(externalExports))).toBe(0o751);
    expect(await readFile(join(externalExports, "sentinel"), "utf8")).toBe("outside");
    expect(mode(await lstat(join(externalExports, "sentinel")))).toBe(0o640);
    expect((await readdir(externalRoot)).sort()).toEqual(["exports"]);
  });
});

describe("replaceLedgerAtomically", () => {
  it("writes all bytes through the ordered durable protocol with exact 0600 modes", async () => {
    const paths = await privatePaths();
    const bytes = ledgerBytes("event-1");
    const observed: PersistenceFault[] = [];
    const previousUmask = process.umask(0);
    try {
      await expect(
        replaceLedgerAtomically({
          paths,
          bytes,
          expectedEventId: "event-1",
          injectFault: (point) => {
            observed.push(point);
          },
        })
      ).resolves.toEqual({ status: "committed" });
    } finally {
      process.umask(previousUmask);
    }

    expect(await readFile(paths.reviewsFile)).toEqual(Buffer.from(bytes));
    expect(mode(await lstat(paths.reviewsFile))).toBe(0o600);
    expect(observed).toEqual([
      { scope: "ledger", operation: "write", timing: "before" },
      { scope: "ledger", operation: "write", timing: "after" },
      { scope: "ledger", operation: "file_fsync", timing: "before" },
      { scope: "ledger", operation: "file_fsync", timing: "after" },
      { scope: "ledger", operation: "close", timing: "before" },
      { scope: "ledger", operation: "close", timing: "after" },
      { scope: "ledger", operation: "rename", timing: "before" },
      { scope: "ledger", operation: "rename", timing: "after" },
      { scope: "ledger", operation: "parent_fsync", timing: "before" },
      { scope: "ledger", operation: "parent_fsync", timing: "after" },
    ]);
    expect((await readdir(paths.ledgerDir)).sort()).toEqual(["reviews.jsonl"]);
  });

  it.each([
    { scope: "ledger", operation: "write", timing: "before" },
    { scope: "ledger", operation: "write", timing: "after" },
    { scope: "ledger", operation: "file_fsync", timing: "before" },
    { scope: "ledger", operation: "file_fsync", timing: "after" },
    { scope: "ledger", operation: "close", timing: "before" },
    { scope: "ledger", operation: "close", timing: "after" },
    { scope: "ledger", operation: "rename", timing: "before" },
  ] satisfies PersistenceFault[])(
    "leaves the prior ledger unchanged on a $timing $operation fault before commit",
    async (fault) => {
      const paths = await privatePaths();
      const prior = ledgerBytes("event-old");
      await writeFile(paths.reviewsFile, prior, { mode: 0o600 });

      await expect(
        replaceLedgerAtomically({
          paths,
          bytes: ledgerBytes("event-new"),
          expectedEventId: "event-new",
          injectFault: failAt(fault),
        })
      ).rejects.toThrow("injected:");

      expect(await readFile(paths.reviewsFile)).toEqual(Buffer.from(prior));
      expect((await readdir(paths.ledgerDir)).sort()).toEqual(["reviews.jsonl"]);
    }
  );

  it.each([
    { scope: "ledger", operation: "rename", timing: "after" },
    { scope: "ledger", operation: "parent_fsync", timing: "before" },
    { scope: "ledger", operation: "parent_fsync", timing: "after" },
  ] satisfies PersistenceFault[])(
    "rereads the committed event and reports uncertain durability on a $timing $operation fault",
    async (fault) => {
      const paths = await privatePaths();
      const bytes = ledgerBytes("event-new");

      await expect(
        replaceLedgerAtomically({
          paths,
          bytes,
          expectedEventId: "event-new",
          injectFault: failAt(fault),
        })
      ).resolves.toEqual({ status: "committed_durability_uncertain" });
      expect(await readFile(paths.reviewsFile)).toEqual(Buffer.from(bytes));
    }
  );

  it("returns indeterminate rather than a false success when post-rename verification mismatches", async () => {
    const paths = await privatePaths();

    await expect(
      replaceLedgerAtomically({
        paths,
        bytes: ledgerBytes("event-new"),
        expectedEventId: "event-new",
        injectFault: async (point) => {
          if (sameFault(point, { scope: "ledger", operation: "rename", timing: "after" })) {
            await writeFile(paths.reviewsFile, ledgerBytes("event-other"));
            throw new Error("injected:post-rename-race");
          }
        },
      })
    ).resolves.toEqual({ status: "indeterminate" });
  });

  it("returns indeterminate when the ledger parent is swapped for a symlink after rename", async () => {
    const paths = await privatePaths();
    const expectedEventId = "event-new";
    const externalDirectory = join(paths.root, "external-ledger-directory");
    const externalBytes = ledgerBytes(expectedEventId);
    let tempName: string | undefined;
    await mkdir(externalDirectory, 0o755);
    await writeFile(join(externalDirectory, "reviews.jsonl"), externalBytes, { mode: 0o640 });

    await expect(
      replaceLedgerAtomically({
        paths,
        bytes: ledgerBytes(expectedEventId),
        expectedEventId,
        injectFault: async (point) => {
          if (sameFault(point, { scope: "ledger", operation: "rename", timing: "before" })) {
            tempName = (await readdir(paths.ledgerDir)).find((name) => name.startsWith(".reviews"));
          }
          if (sameFault(point, { scope: "ledger", operation: "rename", timing: "after" })) {
            expect(tempName).toBeDefined();
            await writeFile(join(externalDirectory, tempName!), "external trap", { mode: 0o640 });
            await renamePath(paths.ledgerDir, `${paths.ledgerDir}-original`);
            await symlink(externalDirectory, paths.ledgerDir);
          }
        },
      })
    ).resolves.toEqual({ status: "indeterminate" });

    expect(await readFile(join(externalDirectory, "reviews.jsonl"))).toEqual(
      Buffer.from(externalBytes)
    );
    expect(mode(await lstat(externalDirectory))).toBe(0o755);
    expect(mode(await lstat(join(externalDirectory, "reviews.jsonl")))).toBe(0o640);
    expect(await readFile(join(externalDirectory, tempName!), "utf8")).toBe("external trap");
    expect(mode(await lstat(join(externalDirectory, tempName!)))).toBe(0o640);
  });

  it("returns indeterminate when the private root is swapped for a matching symlink after ledger rename", async () => {
    const paths = await privatePaths();
    const expectedEventId = "event-root-swap";
    const externalRoot = `${paths.root}-external`;
    const externalLedger = join(externalRoot, "ledger");
    const externalBytes = ledgerBytes(expectedEventId);
    await mkdir(externalRoot, 0o755);
    await mkdir(externalLedger, 0o755);
    await writeFile(join(externalLedger, "reviews.jsonl"), externalBytes, { mode: 0o640 });

    await expect(
      replaceLedgerAtomically({
        paths,
        bytes: ledgerBytes(expectedEventId),
        expectedEventId,
        injectFault: async (point) => {
          if (sameFault(point, { scope: "ledger", operation: "rename", timing: "after" })) {
            await renamePath(paths.root, `${paths.root}-original`);
            await symlink(externalRoot, paths.root);
          }
        },
      })
    ).resolves.toEqual({ status: "indeterminate" });

    expect(await readFile(join(externalLedger, "reviews.jsonl"))).toEqual(
      Buffer.from(externalBytes)
    );
    expect(mode(await lstat(externalRoot))).toBe(0o755);
    expect(mode(await lstat(externalLedger))).toBe(0o755);
    expect(mode(await lstat(join(externalLedger, "reviews.jsonl")))).toBe(0o640);
  });

  it("does not follow a swapped ledger parent while cleaning a pre-rename temp", async () => {
    const paths = await privatePaths();
    const externalDirectory = join(paths.root, "external-ledger-cleanup");
    await mkdir(externalDirectory, 0o755);
    await writeFile(join(externalDirectory, "reviews.jsonl"), "outside", { mode: 0o640 });
    let tempName: string | undefined;

    await expect(
      replaceLedgerAtomically({
        paths,
        bytes: ledgerBytes("event-new"),
        expectedEventId: "event-new",
        injectFault: async (point) => {
          if (sameFault(point, { scope: "ledger", operation: "rename", timing: "before" })) {
            tempName = (await readdir(paths.ledgerDir)).find((name) => name.startsWith(".reviews"));
            expect(tempName).toBeDefined();
            await writeFile(join(externalDirectory, tempName!), "external trap", { mode: 0o640 });
            await renamePath(paths.ledgerDir, `${paths.ledgerDir}-original`);
            await symlink(externalDirectory, paths.ledgerDir);
            throw new Error("injected:ledger-parent-swap-before-rename");
          }
        },
      })
    ).rejects.toThrow("injected:ledger-parent-swap-before-rename");

    expect(await readFile(join(externalDirectory, "reviews.jsonl"), "utf8")).toBe("outside");
    expect(await readFile(join(externalDirectory, tempName!), "utf8")).toBe("external trap");
    expect(mode(await lstat(join(externalDirectory, tempName!)))).toBe(0o640);
  });

  it("rejects a symlink ledger without modifying the target", async () => {
    const paths = await privatePaths();
    const target = join(paths.root, "external-ledger");
    await writeFile(target, "outside", { mode: 0o640 });
    await symlink(target, paths.reviewsFile);

    await expect(
      replaceLedgerAtomically({
        paths,
        bytes: ledgerBytes("event-new"),
        expectedEventId: "event-new",
      })
    ).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(target, "utf8")).toBe("outside");
    expect(mode(await lstat(target))).toBe(0o640);
  });
});

describe("publishRunAtomically", () => {
  it("publishes one sibling 0700 directory containing exactly four synced 0600 files", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"1".repeat(64)}`;
    const files = runFiles(runId, runDigest);
    const observed: PersistenceFault[] = [];
    let inspectedTemp = false;
    const previousUmask = process.umask(0);
    try {
      await expect(
        publishRunAtomically({
          paths,
          runId,
          runDigest,
          files,
          injectFault: async (point) => {
            observed.push(point);
            if (sameFault(point, { scope: "run", operation: "rename", timing: "before" })) {
              const siblings = await readdir(paths.exportsDir);
              const tempName = siblings.find((name) => name !== runId);
              expect(tempName).toBeDefined();
              const temp = join(paths.exportsDir, tempName!);
              expect(mode(await lstat(temp))).toBe(0o700);
              expect((await readdir(temp)).sort()).toEqual(Object.keys(files).sort());
              for (const name of Object.keys(files)) {
                expect(mode(await lstat(join(temp, name)))).toBe(0o600);
              }
              inspectedTemp = true;
            }
          },
        })
      ).resolves.toEqual({ status: "committed" });
    } finally {
      process.umask(previousUmask);
    }

    expect(inspectedTemp).toBe(true);
    const runDir = join(paths.exportsDir, runId);
    expect(mode(await lstat(runDir))).toBe(0o700);
    expect((await readdir(runDir)).sort()).toEqual(Object.keys(files).sort());
    for (const [name, bytes] of Object.entries(files)) {
      expect(await readFile(join(runDir, name))).toEqual(Buffer.from(bytes));
      expect(mode(await lstat(join(runDir, name)))).toBe(0o600);
    }
    expect(observed.at(-4)).toEqual({ scope: "run", operation: "rename", timing: "before" });
    expect(observed.slice(-3)).toEqual([
      { scope: "run", operation: "rename", timing: "after" },
      { scope: "run", operation: "parent_fsync", timing: "before" },
      { scope: "run", operation: "parent_fsync", timing: "after" },
    ]);
  });

  it("returns noop for byte-identical existing output and repairs its owned modes", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"2".repeat(64)}`;
    const files = runFiles(runId, runDigest);
    const runDir = join(paths.exportsDir, runId);
    await mkdir(runDir, 0o755);
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(runDir, name), bytes, { mode: 0o644 });
    }

    await expect(publishRunAtomically({ paths, runId, runDigest, files })).resolves.toEqual({
      status: "noop",
    });
    expect(mode(await lstat(runDir))).toBe(0o700);
    for (const name of Object.keys(files)) expect(mode(await lstat(join(runDir, name)))).toBe(0o600);
    expect(await readdir(paths.exportsDir)).toEqual([runId]);
  });

  it("throws a typed integrity error and never overwrites differing bytes for the same runId", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"3".repeat(64)}`;
    const files = runFiles(runId, runDigest);
    const runDir = join(paths.exportsDir, runId);
    await mkdir(runDir, 0o700);
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(runDir, name), bytes, { mode: 0o600 });
    }
    const changed = encoder.encode("different bytes\n");
    await writeFile(join(runDir, "candidates.md"), changed, { mode: 0o600 });

    const promise = publishRunAtomically({ paths, runId, runDigest, files });
    await expect(promise).rejects.toBeInstanceOf(PersistenceIntegrityError);
    await expect(promise).rejects.toMatchObject({ code: "run_integrity" });
    expect(await readFile(join(runDir, "candidates.md"))).toEqual(Buffer.from(changed));
    expect(await readdir(paths.exportsDir)).toEqual([runId]);
  });

  it("rejects an otherwise exact existing run that contains an unexpected file without mutation", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"a".repeat(64)}`;
    const files = runFiles(runId, runDigest);
    const runDir = join(paths.exportsDir, runId);
    await mkdir(runDir, 0o700);
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(runDir, name), bytes, { mode: 0o600 });
    }
    const unexpected = encoder.encode("do not modify\n");
    await writeFile(join(runDir, "unexpected.txt"), unexpected, { mode: 0o640 });

    await expect(
      publishRunAtomically({ paths, runId, runDigest, files })
    ).rejects.toMatchObject({ code: "run_integrity" });

    expect((await readdir(runDir)).sort()).toEqual([...Object.keys(files), "unexpected.txt"].sort());
    for (const [name, bytes] of Object.entries(files)) {
      expect(await readFile(join(runDir, name))).toEqual(Buffer.from(bytes));
    }
    expect(await readFile(join(runDir, "unexpected.txt"))).toEqual(Buffer.from(unexpected));
    expect(mode(await lstat(join(runDir, "unexpected.txt")))).toBe(0o640);
  });

  it("rejects a raced exact run behind a swapped exports symlink without touching it", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"e".repeat(64)}`;
    const files = runFiles(runId, runDigest);
    const externalExports = join(paths.root, "external-raced-exports");
    const externalRun = join(externalExports, runId);
    await mkdir(externalExports, 0o755);
    await mkdir(externalRun, 0o755);
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(externalRun, name), bytes, { mode: 0o644 });
    }

    await expect(
      publishRunAtomically({
        paths,
        runId,
        runDigest,
        files,
        injectFault: async (point) => {
          if (sameFault(point, { scope: "run", operation: "temp_dir_fsync", timing: "after" })) {
            await renamePath(paths.exportsDir, `${paths.exportsDir}-original`);
            await symlink(externalExports, paths.exportsDir);
          }
        },
      })
    ).rejects.toMatchObject({ code: "unsafe_path" });

    expect(mode(await lstat(externalExports))).toBe(0o755);
    expect(mode(await lstat(externalRun))).toBe(0o755);
    for (const [name, bytes] of Object.entries(files)) {
      expect(await readFile(join(externalRun, name))).toEqual(Buffer.from(bytes));
      expect(mode(await lstat(join(externalRun, name)))).toBe(0o644);
    }
  });

  it("rejects a raced exact run behind a swapped root symlink without touching it", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"f".repeat(64)}`;
    const files = runFiles(runId, runDigest);
    const externalRoot = `${paths.root}-raced-external`;
    const externalExports = join(externalRoot, "exports");
    const externalRun = join(externalExports, runId);
    await mkdir(externalRoot, 0o755);
    await mkdir(externalExports, 0o755);
    await mkdir(externalRun, 0o755);
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(externalRun, name), bytes, { mode: 0o644 });
    }

    await expect(
      publishRunAtomically({
        paths,
        runId,
        runDigest,
        files,
        injectFault: async (point) => {
          if (sameFault(point, { scope: "run", operation: "temp_dir_fsync", timing: "after" })) {
            await renamePath(paths.root, `${paths.root}-original`);
            await symlink(externalRoot, paths.root);
          }
        },
      })
    ).rejects.toMatchObject({ code: "unsafe_path" });

    expect(mode(await lstat(externalRoot))).toBe(0o755);
    expect(mode(await lstat(externalExports))).toBe(0o755);
    expect(mode(await lstat(externalRun))).toBe(0o755);
    for (const [name, bytes] of Object.entries(files)) {
      expect(await readFile(join(externalRun, name))).toEqual(Buffer.from(bytes));
      expect(mode(await lstat(join(externalRun, name)))).toBe(0o644);
    }
  });

  it.each([
    ...(["run.json", "candidates.jsonl", "candidates.md", "exclusions.jsonl"] as const).flatMap(
      (file) =>
        (["write", "file_fsync", "close"] as const).flatMap((operation) =>
          (["before", "after"] as const).map(
            (timing): PersistenceFault => ({ scope: "run", operation, timing, file })
          )
        )
    ),
    { scope: "run", operation: "temp_dir_fsync", timing: "before" },
    { scope: "run", operation: "temp_dir_fsync", timing: "after" },
    { scope: "run", operation: "rename", timing: "before" },
  ] satisfies PersistenceFault[])(
    "never exposes a partial run on a $timing $operation fault before commit",
    async (fault) => {
      const paths = await privatePaths();
      const runId = "eval-0123456789abcdef";
      const runDigest = `sha256:${"4".repeat(64)}`;

      await expect(
        publishRunAtomically({
          paths,
          runId,
          runDigest,
          files: runFiles(runId, runDigest),
          injectFault: failAt(fault),
        })
      ).rejects.toThrow("injected:");

      await expect(lstat(join(paths.exportsDir, runId))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(paths.exportsDir)).toEqual([]);
    }
  );

  it.each([
    { scope: "run", operation: "rename", timing: "after" },
    { scope: "run", operation: "parent_fsync", timing: "before" },
    { scope: "run", operation: "parent_fsync", timing: "after" },
  ] satisfies PersistenceFault[])(
    "verifies runDigest and reports uncertain durability on a $timing $operation fault",
    async (fault) => {
      const paths = await privatePaths();
      const runId = "eval-0123456789abcdef";
      const runDigest = `sha256:${"5".repeat(64)}`;

      await expect(
        publishRunAtomically({
          paths,
          runId,
          runDigest,
          files: runFiles(runId, runDigest),
          injectFault: failAt(fault),
        })
      ).resolves.toEqual({ status: "committed_durability_uncertain" });
      expect(await readdir(paths.exportsDir)).toEqual([runId]);
    }
  );

  it("returns indeterminate when a post-rename no-follow reread sees a different digest", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"6".repeat(64)}`;

    await expect(
      publishRunAtomically({
        paths,
        runId,
        runDigest,
        files: runFiles(runId, runDigest),
        injectFault: async (point) => {
          if (sameFault(point, { scope: "run", operation: "rename", timing: "after" })) {
            await writeFile(
              join(paths.exportsDir, runId, "run.json"),
              `${JSON.stringify({ runDigest: `sha256:${"7".repeat(64)}` })}\n`
            );
            throw new Error("injected:post-rename-race");
          }
        },
      })
    ).resolves.toEqual({ status: "indeterminate" });
  });

  it("returns indeterminate when the exports parent is swapped for a symlink after rename", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"b".repeat(64)}`;
    const externalDirectory = join(paths.root, "external-exports-directory");
    const externalRunDirectory = join(externalDirectory, runId);
    const externalRunBytes = runFiles(runId, runDigest)["run.json"];
    let tempName: string | undefined;
    await mkdir(externalDirectory, 0o755);
    await mkdir(externalRunDirectory, 0o755);
    await writeFile(join(externalRunDirectory, "run.json"), externalRunBytes, { mode: 0o640 });

    await expect(
      publishRunAtomically({
        paths,
        runId,
        runDigest,
        files: runFiles(runId, runDigest),
        injectFault: async (point) => {
          if (sameFault(point, { scope: "run", operation: "rename", timing: "before" })) {
            tempName = (await readdir(paths.exportsDir)).find((name) => name !== runId);
          }
          if (sameFault(point, { scope: "run", operation: "rename", timing: "after" })) {
            expect(tempName).toBeDefined();
            await mkdir(join(externalDirectory, tempName!), 0o755);
            await writeFile(join(externalDirectory, tempName!, "sentinel"), "external trap", {
              mode: 0o640,
            });
            await renamePath(paths.exportsDir, `${paths.exportsDir}-original`);
            await symlink(externalDirectory, paths.exportsDir);
          }
        },
      })
    ).resolves.toEqual({ status: "indeterminate" });

    expect(await readFile(join(externalRunDirectory, "run.json"))).toEqual(
      Buffer.from(externalRunBytes)
    );
    expect(mode(await lstat(externalDirectory))).toBe(0o755);
    expect(mode(await lstat(externalRunDirectory))).toBe(0o755);
    expect(mode(await lstat(join(externalRunDirectory, "run.json")))).toBe(0o640);
    expect(await readFile(join(externalDirectory, tempName!, "sentinel"), "utf8")).toBe(
      "external trap"
    );
    expect(mode(await lstat(join(externalDirectory, tempName!)))).toBe(0o755);
    expect(mode(await lstat(join(externalDirectory, tempName!, "sentinel")))).toBe(0o640);
  });

  it("returns indeterminate when the private root is swapped for a matching symlink after run rename", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"d".repeat(64)}`;
    const externalRoot = `${paths.root}-external`;
    const externalExports = join(externalRoot, "exports");
    const externalRun = join(externalExports, runId);
    const externalRunBytes = runFiles(runId, runDigest)["run.json"];
    await mkdir(externalRoot, 0o755);
    await mkdir(externalExports, 0o755);
    await mkdir(externalRun, 0o755);
    await writeFile(join(externalRun, "run.json"), externalRunBytes, { mode: 0o640 });

    await expect(
      publishRunAtomically({
        paths,
        runId,
        runDigest,
        files: runFiles(runId, runDigest),
        injectFault: async (point) => {
          if (sameFault(point, { scope: "run", operation: "rename", timing: "after" })) {
            await renamePath(paths.root, `${paths.root}-original`);
            await symlink(externalRoot, paths.root);
          }
        },
      })
    ).resolves.toEqual({ status: "indeterminate" });

    expect(await readFile(join(externalRun, "run.json"))).toEqual(Buffer.from(externalRunBytes));
    expect(mode(await lstat(externalRoot))).toBe(0o755);
    expect(mode(await lstat(externalExports))).toBe(0o755);
    expect(mode(await lstat(externalRun))).toBe(0o755);
    expect(mode(await lstat(join(externalRun, "run.json")))).toBe(0o640);
  });

  it("does not report committed when the published run inode is silently replaced", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"0".repeat(64)}`;
    const files = runFiles(runId, runDigest);
    const publishedRun = join(paths.exportsDir, runId);
    const externalRun = join(paths.root, "external-published-run");
    await mkdir(externalRun, 0o755);
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(externalRun, name), bytes, { mode: 0o644 });
    }

    await expect(
      publishRunAtomically({
        paths,
        runId,
        runDigest,
        files,
        injectFault: async (point) => {
          if (sameFault(point, { scope: "run", operation: "rename", timing: "after" })) {
            await renamePath(publishedRun, `${publishedRun}-original`);
            await symlink(externalRun, publishedRun);
          }
        },
      })
    ).resolves.toEqual({ status: "indeterminate" });

    expect(mode(await lstat(externalRun))).toBe(0o755);
    for (const [name, bytes] of Object.entries(files)) {
      expect(await readFile(join(externalRun, name))).toEqual(Buffer.from(bytes));
      expect(mode(await lstat(join(externalRun, name)))).toBe(0o644);
    }
  });

  it("does not follow a swapped exports parent while cleaning a pre-rename temp", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"c".repeat(64)}`;
    const externalDirectory = join(paths.root, "external-exports-cleanup");
    await mkdir(externalDirectory, 0o755);
    let tempName: string | undefined;

    await expect(
      publishRunAtomically({
        paths,
        runId,
        runDigest,
        files: runFiles(runId, runDigest),
        injectFault: async (point) => {
          if (sameFault(point, { scope: "run", operation: "rename", timing: "before" })) {
            tempName = (await readdir(paths.exportsDir)).find((name) => name !== runId);
            expect(tempName).toBeDefined();
            await mkdir(join(externalDirectory, tempName!), 0o755);
            await writeFile(join(externalDirectory, tempName!, "sentinel"), "external trap", {
              mode: 0o640,
            });
            await renamePath(paths.exportsDir, `${paths.exportsDir}-original`);
            await symlink(externalDirectory, paths.exportsDir);
            throw new Error("injected:exports-parent-swap-before-rename");
          }
        },
      })
    ).rejects.toThrow("injected:exports-parent-swap-before-rename");

    expect(await readFile(join(externalDirectory, tempName!, "sentinel"), "utf8")).toBe(
      "external trap"
    );
    expect(mode(await lstat(join(externalDirectory, tempName!)))).toBe(0o755);
    expect(mode(await lstat(join(externalDirectory, tempName!, "sentinel")))).toBe(0o640);
  });

  it("rejects symlinks at the final run and owned file paths without touching targets", async () => {
    const paths = await privatePaths();
    const runId = "eval-0123456789abcdef";
    const runDigest = `sha256:${"8".repeat(64)}`;
    const files = runFiles(runId, runDigest);
    const externalDirectory = join(paths.root, "external-run");
    await mkdir(externalDirectory, 0o755);
    await writeFile(join(externalDirectory, "sentinel"), "outside");
    await symlink(externalDirectory, join(paths.exportsDir, runId));

    await expect(
      publishRunAtomically({ paths, runId, runDigest, files })
    ).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(join(externalDirectory, "sentinel"), "utf8")).toBe("outside");

    await rm(join(paths.exportsDir, runId));
    await mkdir(join(paths.exportsDir, runId), 0o700);
    const externalFile = join(paths.root, "external-file");
    await writeFile(externalFile, "outside", { mode: 0o640 });
    await symlink(externalFile, join(paths.exportsDir, runId, "run.json"));

    await expect(
      publishRunAtomically({ paths, runId, runDigest, files })
    ).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(externalFile, "utf8")).toBe("outside");
    expect(mode(await lstat(externalFile))).toBe(0o640);
  });

  it("rejects unsafe runIds before creating any path", async () => {
    const paths = await privatePaths();
    const runDigest = `sha256:${"9".repeat(64)}`;
    for (const runId of ["", ".", "..", "../escape", "nested/run"]) {
      await expect(
        publishRunAtomically({ paths, runId, runDigest, files: runFiles(runId, runDigest) })
      ).rejects.toMatchObject({ code: "unsafe_path" });
    }
    expect(await readdir(paths.exportsDir)).toEqual([]);
  });
});
import { execFile } from "node:child_process";
