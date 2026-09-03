import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../feedback-learning/canonical";
import { withCorpusLock } from "../feedback-learning/lock";
import {
  appendOutcomeEvent,
  ensureOutcomeStore,
  OutcomeStoreError,
  readActiveOutcomeLabels,
  type OutcomeRetirement,
} from "../feedback-quality/outcome-store";
import type { OutcomeLabel } from "../feedback-quality/outcome-types";

const roots: string[] = [];
const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;

async function temporaryRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "clipclap-outcome-store-"));
  roots.push(parent);
  return join(parent, "outcomes");
}

function label(eventId: string, overrides: Partial<OutcomeLabel> = {}): OutcomeLabel {
  return {
    schemaVersion: 1,
    action: "label",
    eventId,
    occurredAt: "2026-09-02T20:00:00.000Z",
    caseVersion: sha("a"),
    set: "eval",
    disposition: "recoverable_false_negative",
    confidence: "high",
    expected: { approvedWindows: [{ start: 10, end: 20 }], forbiddenWindows: [] },
    ...overrides,
  } as OutcomeLabel;
}

function retirement(eventId: string, targetEventId: string): OutcomeRetirement {
  return {
    schemaVersion: 1,
    action: "retire",
    eventId,
    occurredAt: "2026-09-02T21:00:00.000Z",
    targetEventId,
  };
}

function mode(value: { mode: number }): number {
  return value.mode & 0o777;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private zero-outcome store", () => {
  it("owns the exact outcome ledger layout with private modes", async () => {
    const root = await temporaryRoot();
    const paths = await ensureOutcomeStore(root);
    await appendOutcomeEvent(root, label("event-private"));

    expect(mode(await lstat(paths.root))).toBe(0o700);
    for (const directory of [paths.ledgerDir, paths.casesDir, paths.observationsDir, paths.decisionsDir]) {
      expect(mode(await lstat(directory))).toBe(0o700);
    }
    expect(mode(await lstat(paths.eventsFile))).toBe(0o600);
    expect(mode(await lstat(paths.lockFile))).toBe(0o600);
    expect(paths.eventsFile).toBe(join(root, "ledger", "outcomes.jsonl"));
    expect(paths.lockFile).toBe(join(root, "ledger", "outcomes.lock"));
    expect(await lstat(join(root, "labels.jsonl")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
  });

  it("writes one canonical JSON object per line", async () => {
    const root = await temporaryRoot();
    const input = label("event-canonical");
    const paths = await ensureOutcomeStore(root);
    await appendOutcomeEvent(root, input);
    expect(await readFile(paths.eventsFile, "utf8")).toBe(`${canonicalJson(input)}\n`);
  });

  it("rejects duplicate event ids even for an identical replay", async () => {
    const root = await temporaryRoot();
    await appendOutcomeEvent(root, label("event-duplicate"));
    await expect(appendOutcomeEvent(root, label("event-duplicate"))).rejects.toMatchObject({ code: "duplicate_event" });
    await expect(appendOutcomeEvent(root, label("event-duplicate", { caseVersion: sha("b") }))).rejects.toMatchObject({ code: "duplicate_event" });
  });

  it("corrects labels only by append-only retirement", async () => {
    const root = await temporaryRoot();
    await appendOutcomeEvent(root, label("label-old"));
    await expect(appendOutcomeEvent(root, label("label-illegal-rewrite", { confidence: "medium" }))).rejects.toMatchObject({ code: "invalid_retirement" });
    await appendOutcomeEvent(root, retirement("retire-old", "label-old"));
    await appendOutcomeEvent(root, label("label-new", { disposition: "valid_empty", expected: { approvedWindows: [], forbiddenWindows: [{ start: 30, end: 40 }] } }));

    await expect(readActiveOutcomeLabels(root)).resolves.toEqual([
      expect.objectContaining({ eventId: "label-new", disposition: "valid_empty" }),
    ]);
    await expect(appendOutcomeEvent(root, retirement("retire-again", "label-old"))).rejects.toMatchObject({ code: "invalid_retirement" });
    await expect(appendOutcomeEvent(root, retirement("retire-missing", "missing"))).rejects.toMatchObject({ code: "invalid_retirement" });
  });

  it("rejects malformed retirement records before touching disk", async () => {
    const root = await temporaryRoot();
    await expect(appendOutcomeEvent(root, { ...retirement("retire-bad", "label-old"), note: "private" } as OutcomeRetirement)).rejects.toBeInstanceOf(OutcomeStoreError);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses symlink and special-file ledger entries", async () => {
    const symlinkRoot = await temporaryRoot();
    const outside = join(roots[roots.length - 1], "outside");
    await mkdir(outside, 0o700);
    await symlink(outside, symlinkRoot);
    await expect(appendOutcomeEvent(symlinkRoot, label("event-symlink"))).rejects.toMatchObject({ code: "unsafe_path" });

    const fifoRoot = await temporaryRoot();
    const paths = await ensureOutcomeStore(fifoRoot);
    execFileSync("mkfifo", [paths.eventsFile]);
    await expect(appendOutcomeEvent(fifoRoot, label("event-fifo"))).rejects.toMatchObject({ code: "unsafe_path" });

    const lockRoot = await temporaryRoot();
    const lockPaths = await ensureOutcomeStore(lockRoot);
    execFileSync("mkfifo", [lockPaths.lockFile]);
    await expect(appendOutcomeEvent(lockRoot, label("event-lock-fifo"))).rejects.toMatchObject({ code: "unsafe_path" });

    const hardlinkRoot = await temporaryRoot();
    const hardlinkPaths = await ensureOutcomeStore(hardlinkRoot);
    const external = join(roots[roots.length - 1], "external-ledger");
    await writeFile(external, "private external bytes\n", { mode: 0o640 });
    await link(external, hardlinkPaths.eventsFile);
    await expect(appendOutcomeEvent(hardlinkRoot, label("event-hardlink"))).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(external, "utf8")).toBe("private external bytes\n");
    expect(mode(await lstat(external))).toBe(0o640);
  });

  it("uses the permanent flock for writer exclusion", async () => {
    const root = await temporaryRoot();
    const paths = await ensureOutcomeStore(root);
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withCorpusLock(paths.lockFile, async () => { locked(); await held; });
    await acquired;
    await expect(appendOutcomeEvent(root, label("event-locked"), { lockOptions: { timeoutMs: 20, retryMs: 1 } })).rejects.toMatchObject({ code: "lock_timeout" });
    release();
    await holder;
  });

  it("fails closed when the lock path is replaced after flock acquisition", async () => {
    const root = await temporaryRoot();
    const paths = await ensureOutcomeStore(root);
    await appendOutcomeEvent(root, label("event-before-lock-swap"));
    const before = await readFile(paths.eventsFile);
    await expect(appendOutcomeEvent(root, label("event-after-lock-swap", { caseVersion: sha("b") }), {
      async afterLock() {
        await rename(paths.lockFile, `${paths.lockFile}.displaced`);
        await writeFile(paths.lockFile, "", { mode: 0o600 });
      },
    })).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(paths.eventsFile)).toEqual(before);
  });

  it("fails closed when the ledger directory is replaced after flock acquisition", async () => {
    const root = await temporaryRoot();
    const paths = await ensureOutcomeStore(root);
    await appendOutcomeEvent(root, label("event-before-ledger-swap"));
    const before = await readFile(paths.eventsFile);
    const displaced = join(root, "ledger.displaced");
    await expect(appendOutcomeEvent(root, label("event-after-ledger-swap", { caseVersion: sha("b") }), {
      async afterLock() {
        await rename(paths.ledgerDir, displaced);
        await mkdir(paths.ledgerDir, 0o700);
        await rename(join(displaced, "outcomes.lock"), paths.lockFile);
      },
    })).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(join(displaced, "outcomes.jsonl"))).toEqual(before);
    await expect(lstat(paths.eventsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the store root is replaced after flock acquisition", async () => {
    const root = await temporaryRoot();
    const paths = await ensureOutcomeStore(root);
    await appendOutcomeEvent(root, label("event-before-root-swap"));
    const before = await readFile(paths.eventsFile);
    const displaced = `${root}.displaced`;
    await expect(appendOutcomeEvent(root, label("event-after-root-swap", { caseVersion: sha("b") }), {
      async afterLock() {
        await rename(root, displaced);
        await mkdir(root, 0o700);
        await mkdir(join(root, "ledger"), 0o700);
        await rename(join(displaced, "ledger", "outcomes.lock"), join(root, "ledger", "outcomes.lock"));
      },
    })).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(join(displaced, "ledger", "outcomes.jsonl"))).toEqual(before);
    await expect(lstat(paths.eventsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the old ledger and removes its temp after a crash before rename", async () => {
    const root = await temporaryRoot();
    const paths = await ensureOutcomeStore(root);
    await appendOutcomeEvent(root, label("event-before"));
    const before = await readFile(paths.eventsFile);
    await expect(appendOutcomeEvent(root, label("event-crash", { caseVersion: sha("b") }), {
      tempSuffix: "crash-before-rename",
      injectFault(point) {
        if (point.operation === "rename" && point.timing === "before") throw new Error("simulated_crash");
      },
    })).rejects.toMatchObject({ code: "integrity" });
    expect(await readFile(paths.eventsFile)).toEqual(before);
    await expect(lstat(join(paths.ledgerDir, ".outcomes.jsonl.tmp-crash-before-rename"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("orders durable publication as file fsync, rename, then directory fsync", async () => {
    const root = await temporaryRoot();
    const operations: string[] = [];
    await appendOutcomeEvent(root, label("event-durable-order"), {
      injectFault(point) { operations.push(`${point.operation}:${point.timing}`); },
    });
    expect(operations).toEqual([
      "write:before", "write:after",
      "file_fsync:before", "file_fsync:after",
      "close:before", "close:after",
      "rename:before", "rename:after",
      "parent_fsync:before", "parent_fsync:after",
    ]);
  });

  it("reports an uncertain durable commit when parent fsync fails after rename", async () => {
    const root = await temporaryRoot();
    await expect(appendOutcomeEvent(root, label("event-fsync-uncertain"), {
      injectFault(point) {
        if (point.operation === "parent_fsync" && point.timing === "before") throw new Error("simulated_fsync_failure");
      },
    })).resolves.toEqual({ status: "committed_durability_uncertain" });
    await expect(readActiveOutcomeLabels(root)).resolves.toEqual([
      expect.objectContaining({ eventId: "event-fsync-uncertain" }),
    ]);
  });

  it("removes stale owned temps under the lock before appending", async () => {
    const root = await temporaryRoot();
    const paths = await ensureOutcomeStore(root);
    await appendOutcomeEvent(root, label("event-before-stale"));
    const stale = join(paths.ledgerDir, ".outcomes.jsonl.tmp-stale");
    await writeFile(stale, "stale private bytes", { mode: 0o600 });
    await appendOutcomeEvent(root, label("event-after-stale", { caseVersion: sha("b") }));
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent writers without losing events", async () => {
    const root = await temporaryRoot();
    const events = Array.from({ length: 12 }, (_, index) => label(`event-${index}`, { caseVersion: sha(index.toString(16)) }));
    await Promise.all(events.map((event) => appendOutcomeEvent(root, event)));
    const paths = await ensureOutcomeStore(root);
    const lines = (await readFile(paths.eventsFile, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(events.length);
    expect(new Set(lines.map((line) => (JSON.parse(line) as { eventId: string }).eventId))).toEqual(new Set(events.map((event) => event.eventId)));
  });

  it("fails closed on a non-canonical or truncated existing ledger", async () => {
    const root = await temporaryRoot();
    const paths = await ensureOutcomeStore(root);
    await writeFile(paths.eventsFile, JSON.stringify(label("event-raw")), { mode: 0o600 });
    await expect(readActiveOutcomeLabels(root)).rejects.toMatchObject({ code: "integrity" });
    await expect(appendOutcomeEvent(root, label("event-next"))).rejects.toMatchObject({ code: "integrity" });
    await unlink(paths.eventsFile);
  });
});
