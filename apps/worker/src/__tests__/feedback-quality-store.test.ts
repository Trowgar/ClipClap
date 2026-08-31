import { execFileSync, spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../feedback-learning/canonical";
import {
  appendLabelEvent,
  contentId,
  ensureQualityTree,
  publishBundle,
  readBundle,
  type AppendLabelOptions,
  type PublishBundleInput,
} from "../feedback-quality/store";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "clipclap-quality-store-"));
  roots.push(parent);
  return join(parent, "quality");
}

function mode(value: { mode: number }): number {
  return value.mode & 0o777;
}

function bundle(kind: "case" | "observation" | "decision", id: string, files: Record<string, string>): PublishBundleInput {
  return {
    kind,
    id,
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value)])),
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("feedback quality private store", () => {
  it("derives key-order-independent content IDs", () => {
    expect(contentId("case", { b: 2, a: { d: false, c: 1 } })).toBe(
      contentId("case", { a: { c: 1, d: false }, b: 2 }),
    );
    expect(contentId("case", { a: 1 })).toMatch(/^case:sha256:[0-9a-f]{64}$/);
  });

  it("creates only its owned tree with private modes", async () => {
    const root = await temporaryRoot();
    const paths = await ensureQualityTree(root);
    expect(mode(await lstat(paths.root))).toBe(0o700);
    for (const directory of [paths.ledgerDir, paths.casesDir, paths.observationsDir, paths.decisionsDir]) {
      expect(mode(await lstat(directory))).toBe(0o700);
    }
    expect(await lstat(paths.labelsFile).catch((error: unknown) => (error as NodeJS.ErrnoException).code)).toBe("ENOENT");
  });

  it("publishes bundles atomically and repeats an identical publish as a no-op", async () => {
    const root = await temporaryRoot();
    const id = contentId("observation", { commit: "a" });
    const input = bundle("observation", id, { "manifest.json": "manifest", "results.jsonl": "result\n" });
    expect(await publishBundle(input, root)).toEqual({ status: "committed" });
    expect(await publishBundle(input, root)).toEqual({ status: "noop" });
    const files = await readBundle("observation", id, root);
    expect([...files.keys()].sort()).toEqual(["manifest.json", "results.jsonl"]);
    expect(Buffer.from(files.get("manifest.json")!)).toEqual(Buffer.from("manifest"));
    expect(mode(await lstat(join(root, "observations", id)))).toBe(0o700);
    expect(mode(await lstat(join(root, "observations", id, "manifest.json")))).toBe(0o600);
  });

  it("publishes a file-backed payload with the same logical digest as bytes", async () => {
    const root = await temporaryRoot();
    const content = Buffer.from("streamed payload");
    const id = contentId("case", { fileBacked: true });
    const spoolDir = await mkdtemp(join(tmpdir(), "clipclap-quality-spool-test-"));
    roots.push(spoolDir);
    const spool = join(spoolDir, "artifact.part");
    await writeFile(spool, content, { mode: 0o600 });
    const payload = { path: spool, size: content.byteLength, sha256: sha256(content) };
    await expect(publishBundle(bundle("case", id, { "case.json": content.toString() }), root)).resolves.toEqual({ status: "committed" });
    await expect(publishBundle({ kind: "case", id, files: { "case.json": payload } }, root)).resolves.toEqual({ status: "noop" });
    const files = await readBundle("case", id, root);
    expect(Buffer.from(files.get("case.json")!)).toEqual(content);
  });

  it("rejects a file-backed payload whose source digest was tampered", async () => {
    const root = await temporaryRoot();
    const spoolDir = await mkdtemp(join(tmpdir(), "clipclap-quality-spool-tampered-"));
    roots.push(spoolDir);
    const spool = join(spoolDir, "artifact.part");
    await writeFile(spool, "actual", { mode: 0o600 });
    const id = contentId("case", { tamperedFile: true });
    await expect(publishBundle({ kind: "case", id, files: { "case.json": { path: spool, size: 6, sha256: sha256(Buffer.from("wrong")) } } }, root)).rejects.toMatchObject({ code: "integrity" });
  });

  it("rejects arbitrary and cross-kind bundle IDs before touching the filesystem", async () => {
    const root = await temporaryRoot();
    await expect(publishBundle(bundle("case", "case:sha256:bad", { "case.json": "x" }), root)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publishBundle(bundle("case", `observation:sha256:${"a".repeat(64)}`, { "case.json": "x" }), root)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(publishBundle(bundle("case", "../escape", { "case.json": "x" }), root)).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(publishBundle(bundle("case", `case:sha256:${"A".repeat(64)}`, { "case.json": "x" }), root)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a content collision and never overwrites prior bytes", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { fixed: true });
    const first = bundle("case", id, { "case.json": "private-first" });
    const second = bundle("case", id, { "case.json": "private-second" });
    await publishBundle(first, root);
    await expect(publishBundle(second, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(readFile(join(root, "cases", id, "case.json"), "utf8")).resolves.toBe("private-first");
  });

  it("rejects symlink and special-file bundle entries without reading outside", async () => {
    const root = await temporaryRoot();
    const paths = await ensureQualityTree(root);
    const id = contentId("decision", { fixed: true });
    const directory = join(paths.decisionsDir, id);
    const external = join(root, "outside");
    await writeFile(external, "PRIVATE_EXTERNAL", { mode: 0o600 });
    await symlink(external, directory);
    await expect(publishBundle(bundle("decision", id, { "decision.json": "x" }), root)).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(external, "utf8")).toBe("PRIVATE_EXTERNAL");
  });

  it("rejects a real FIFO in an existing bundle and in the owned ledger", async () => {
    const root = await temporaryRoot();
    const paths = await ensureQualityTree(root);
    const id = contentId("case", { fifo: true });
    const directory = join(paths.casesDir, id);
    await publishBundle(bundle("case", id, { "case.json": "x" }), root);
    await unlink(join(directory, "case.json"));
    execFileSync("mkfifo", [join(directory, "case.json")]);
    await expect(publishBundle(bundle("case", id, { "case.json": "x" }), root)).rejects.toMatchObject({ code: "unsafe_path" });

    execFileSync("mkfifo", [paths.labelsFile]);
    await expect(appendLabelEvent({ eventId: "fifo-event", schemaVersion: 1 }, root)).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects hardlinked owned files before chmod/read and leaves the external inode unchanged", async () => {
    const root = await temporaryRoot();
    const paths = await ensureQualityTree(root);
    const id = contentId("case", { hardlink: true });
    const directory = join(paths.casesDir, id);
    const external = join(root, "external-case.json");
    await publishBundle(bundle("case", id, { "case.json": "PRIVATE_EXTERNAL_BYTES" }), root);
    await writeFile(external, "PRIVATE_EXTERNAL_BYTES", { mode: 0o640 });
    await unlink(join(directory, "case.json"));
    await link(external, join(directory, "case.json"));
    await expect(publishBundle(bundle("case", id, { "case.json": "PRIVATE_EXTERNAL_BYTES" }), root)).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(external, "utf8")).toBe("PRIVATE_EXTERNAL_BYTES");
    expect(mode(await lstat(external))).toBe(0o640);

    const externalLock = join(root, "external-lock");
    await writeFile(externalLock, "PRIVATE_LOCK_BYTES", { mode: 0o640 });
    await unlink(paths.labelsLock);
    await link(externalLock, paths.labelsLock);
    await expect(appendLabelEvent({ eventId: "hardlinked-lock", schemaVersion: 1 }, root)).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(externalLock, "utf8")).toBe("PRIVATE_LOCK_BYTES");
    expect(mode(await lstat(externalLock))).toBe(0o640);
  });

  it("rejects an intermediate symlink in the requested root path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clipclap-quality-link-root-"));
    roots.push(parent);
    const external = join(parent, "external");
    await mkdir(external, 0o700);
    await symlink(external, join(parent, "intermediate"));
    await expect(ensureQualityTree(join(parent, "intermediate", "quality"))).rejects.toMatchObject({ code: "unsafe_path" });
    expect((await lstat(external)).isDirectory()).toBe(true);
  });

  it("does not remove a foreign empty destination created at the commit race", async () => {
    const root = await temporaryRoot();
    const id = contentId("decision", { race: true });
    const destination = join(root, "decisions", id);
    await expect(publishBundle({
      ...bundle("decision", id, { "decision.json": "safe" }),
      injectFault: async (point) => {
        if (point.scope === "bundle" && point.operation === "reserve" && point.timing === "before") await mkdir(destination, 0o700);
      },
    }, root)).rejects.toMatchObject({ code: "integrity" });
    expect(mode(await lstat(destination))).toBe(0o700);
    expect(await lstat(join(destination, "decision.json")).catch((error: unknown) => (error as NodeJS.ErrnoException).code)).toBe("ENOENT");
  });

  it("appends labels atomically, makes exact repeats no-ops, and rejects event collisions", async () => {
    const root = await temporaryRoot();
    const event = { schemaVersion: 1, eventId: "event-1", disposition: "positive", privateNote: "PRIVATE_NOTE" };
    expect(await appendLabelEvent(event, root)).toEqual({ status: "committed" });
    expect(await appendLabelEvent({ privateNote: "PRIVATE_NOTE", disposition: "positive", eventId: "event-1", schemaVersion: 1 }, root)).toEqual({ status: "noop" });
    await expect(appendLabelEvent({ ...event, disposition: "exclude" }, root)).rejects.toMatchObject({ code: "integrity" });
    expect(await readFile(join(root, "ledger", "labels.jsonl"), "utf8")).toContain("PRIVATE_NOTE");
    expect(mode(await lstat(join(root, "ledger", "labels.jsonl")))).toBe(0o600);
  });

  it("restores the owned ledger mode on an exact noop", async () => {
    const root = await temporaryRoot();
    const event = { schemaVersion: 1, eventId: "mode-event", disposition: "positive" };
    await appendLabelEvent(event, root);
    await chmod(join(root, "ledger", "labels.jsonl"), 0o644);
    await expect(appendLabelEvent(event, root)).resolves.toEqual({ status: "noop" });
    expect(mode(await lstat(join(root, "ledger", "labels.jsonl")))).toBe(0o600);
  });

  it("restores the owned marker mode on noop and read", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { markerMode: true });
    const input = bundle("case", id, { "case.json": "safe" });
    await publishBundle(input, root);
    const marker = join(root, "cases", id, ".committed");
    const reservation = join(root, "cases", id, ".reservation");
    await chmod(marker, 0o644);
    await chmod(reservation, 0o644);
    await expect(publishBundle(input, root)).resolves.toEqual({ status: "noop" });
    expect(mode(await lstat(marker))).toBe(0o600);
    expect(mode(await lstat(reservation))).toBe(0o600);
    await chmod(marker, 0o644);
    await chmod(reservation, 0o644);
    await readBundle("case", id, root);
    expect(mode(await lstat(marker))).toBe(0o600);
    expect(mode(await lstat(reservation))).toBe(0o600);
  });

  it("rejects a tampered-but-valid reservation digest on read and noop", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { tamperedReservation: true });
    const input = bundle("case", id, { "case.json": "safe" });
    await publishBundle(input, root);
    const reservation = join(root, "cases", id, ".reservation");
    await writeFile(reservation, JSON.stringify({ schemaVersion: 1, digest: `sha256:${"a".repeat(64)}`, token: JSON.parse(await readFile(reservation, "utf8")).token }) + "\n", { mode: 0o600 });
    await expect(readBundle("case", id, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(publishBundle(input, root)).rejects.toMatchObject({ code: "integrity" });
  });

  it("does not remove a foreign temp file when O_EXCL reports a collision", async () => {
    const root = await temporaryRoot();
    await ensureQualityTree(root);
    const temp = join(root, "ledger", ".labels.jsonl.tmp-fixed");
    await writeFile(temp, "PRIVATE_FOREIGN_TEMP", { mode: 0o640 });
    await expect(appendLabelEvent({ eventId: "temp-collision", schemaVersion: 1 }, root, { tempSuffix: "fixed" })).rejects.toMatchObject({ code: "integrity" });
    expect(await readFile(temp, "utf8")).toBe("PRIVATE_FOREIGN_TEMP");
    expect(mode(await lstat(temp))).toBe(0o640);
  });

  it("reports uncertain post-rename failures only after verifying the published bytes", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { fault: "post-rename" });
    const input = bundle("case", id, { "case.json": "safe" });
    const injected = { scope: "bundle", operation: "rename", timing: "after" } as const;
    const result = await publishBundle({ ...input, injectFault: (point) => {
      if (JSON.stringify(point) === JSON.stringify(injected)) throw new Error("injected");
    } }, root);
    expect(result).toEqual({ status: "committed_durability_uncertain" });
    expect(Buffer.from((await readBundle("case", id, root)).get("case.json")!)).toEqual(Buffer.from("safe"));
  });

  it("does not publish when a pre-rename operation fails", async () => {
    const root = await temporaryRoot();
    const id = contentId("decision", { fault: "pre-rename" });
    const injected = { scope: "bundle", operation: "rename", timing: "before" } as const;
    await expect(publishBundle({
      ...bundle("decision", id, { "decision.json": "safe" }),
      injectFault: (point) => {
        if (JSON.stringify(point) === JSON.stringify(injected)) throw new Error("PRIVATE_INJECTED_DETAIL");
      },
    }, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(readBundle("decision", id, root)).rejects.toMatchObject({ code: "missing" });
    await expect(publishBundle(bundle("decision", id, { "decision.json": "safe" }), root)).resolves.toEqual({ status: "committed" });
    await expect(readBundle("decision", id, root)).resolves.toHaveProperty("size", 1);
  });

  it("recovers a reserved bundle after a pre-write fault", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { recovery: "write" });
    const input = bundle("case", id, { "case.json": "safe" });
    await expect(publishBundle({ ...input, injectFault: (point) => {
      if (point.scope === "bundle" && point.operation === "write" && point.timing === "before") throw new Error("injected");
    } }, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(publishBundle(input, root)).resolves.toEqual({ status: "committed" });
  });

  it("recovers a matching reserved bundle after a post-reservation fault", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { recovery: "reservation" });
    const input = bundle("case", id, { "case.json": "safe" });
    await expect(publishBundle({ ...input, injectFault: (point) => {
      if (point.scope === "bundle" && point.operation === "reserve" && point.timing === "after") throw new Error("injected");
    } }, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(publishBundle(input, root)).resolves.toEqual({ status: "committed" });
  });

  it("resumes an owned orphan temp and rejects a foreign lookalike temp", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { recovery: "orphan" });
    const input = bundle("case", id, { "case.json": "safe" });
    let orphanPath = "";
    await expect(publishBundle({ ...input, injectFault: async (point) => {
      if (point.scope === "bundle" && point.operation === "reserve" && point.timing === "after") {
        const reservation = JSON.parse(await readFile(join(root, "cases", id, ".reservation"), "utf8")) as { token: string };
        orphanPath = join(root, "cases", id, `.case.json.tmp-${reservation.token}`);
        await writeFile(orphanPath, "safe", { mode: 0o600 });
        throw new Error("injected");
      }
    } }, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(publishBundle(input, root)).resolves.toEqual({ status: "committed" });
    await expect(lstat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });

    const foreignId = contentId("case", { recovery: "foreign-lookalike" });
    const foreignInput = bundle("case", foreignId, { "case.json": "safe" });
    const foreignTemp = join(root, "cases", foreignId, `.case.json.tmp-${"f".repeat(32)}`);
    await expect(publishBundle({ ...foreignInput, injectFault: async (point) => {
      if (point.scope === "bundle" && point.operation === "reserve" && point.timing === "after") {
        await writeFile(foreignTemp, "foreign", { mode: 0o600 });
        throw new Error("injected");
      }
    } }, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(publishBundle(foreignInput, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(readFile(foreignTemp, "utf8")).resolves.toBe("foreign");
  });

  it("recovers the exact nlink=2 temp/final pair left by a link-before-unlink crash", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { recovery: "linked-temp" });
    const input = bundle("case", id, { "case.json": "safe" });
    await expect(publishBundle({ ...input, injectFault: (point) => {
      if (point.scope === "bundle" && point.operation === "reserve" && point.timing === "after") throw new Error("injected");
    } }, root)).rejects.toMatchObject({ code: "integrity" });
    const reservation = JSON.parse(await readFile(join(root, "cases", id, ".reservation"), "utf8")) as { token: string };
    const finalPath = join(root, "cases", id, "case.json");
    const temporaryPath = join(root, "cases", id, `.case.json.tmp-${reservation.token}`);
    await writeFile(finalPath, "safe", { mode: 0o600 });
    await link(finalPath, temporaryPath);
    expect((await lstat(finalPath)).nlink).toBe(2);
    await expect(publishBundle(input, root)).resolves.toEqual({ status: "committed" });
    expect((await lstat(finalPath)).nlink).toBe(1);
    await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an nlink=2 lookalike whose temp and final inodes differ", async () => {
    const root = await temporaryRoot();
    const id = contentId("case", { recovery: "foreign-linked-temp" });
    const input = bundle("case", id, { "case.json": "safe" });
    let foreignTemp = "";
    await expect(publishBundle({ ...input, injectFault: async (point) => {
      if (point.scope === "bundle" && point.operation === "reserve" && point.timing === "after") {
        const reservation = JSON.parse(await readFile(join(root, "cases", id, ".reservation"), "utf8")) as { token: string };
        const finalPath = join(root, "cases", id, "case.json");
        foreignTemp = join(root, "cases", id, `.case.json.tmp-${reservation.token}`);
        await writeFile(finalPath, "safe", { mode: 0o600 });
        const external = join(root, "external-linked-temp");
        await writeFile(external, "foreign", { mode: 0o640 });
        await link(external, foreignTemp);
        throw new Error("injected");
      }
    } }, root)).rejects.toMatchObject({ code: "integrity" });
    await expect(publishBundle(input, root)).rejects.toMatchObject({ code: "integrity" });
    expect(await readFile(foreignTemp, "utf8")).toBe("foreign");
    expect(mode(await lstat(foreignTemp))).toBe(0o640);
  });

  it.each([
    ["before", { scope: "ledger", operation: "rename", timing: "before" }],
    ["after", { scope: "ledger", operation: "rename", timing: "after" }],
  ] as const)("handles %s-rename ledger faults without leaking event data", async (label, injected) => {
    const root = await temporaryRoot();
    const event = { schemaVersion: 1, eventId: `fault-${label}`, privateNote: "PRIVATE_LEDGER_NOTE" };
    const options: AppendLabelOptions = {
      injectFault: (point) => {
        if (JSON.stringify(point) === JSON.stringify(injected)) throw new Error("PRIVATE_FAULT_DETAIL");
      },
    };
    if (label === "before") {
      await expect(appendLabelEvent(event, root, options)).rejects.toMatchObject({ code: "integrity" });
      await expect(lstat(join(root, "ledger", "labels.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(appendLabelEvent(event, root, options)).resolves.toEqual({ status: "committed_durability_uncertain" });
      const ledger = await readFile(join(root, "ledger", "labels.jsonl"), "utf8");
      expect(ledger.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(ledger)).toEqual(event);
    }
  });

  it("waits for a real process holding the labels lock before mutating the ledger", async () => {
    const root = await temporaryRoot();
    const paths = await ensureQualityTree(root);
    const child = spawn("flock", [paths.labelsLock, "-c", "printf READY; sleep 1"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lock child did not start: ${errors}`)), 2_000);
      child.stdout.on("data", () => {
        if (output.includes("READY")) { clearTimeout(timer); resolve(); }
      });
      child.once("error", reject);
    });
    let settled = false;
    const pending = appendLabelEvent({ eventId: "contended-event", schemaVersion: 1 }, root).then((result) => {
      settled = true;
      return result;
    }, (error: unknown) => {
      settled = true;
      throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await expect(pending).resolves.toEqual({ status: "committed" });
  });

  it("redacts private values from an actual injected error and its metadata", async () => {
    const root = await temporaryRoot();
    const privateValue = "PRIVATE_SECRET_VALUE";
    const privateEventId = "PRIVATE_EVENT_ID";
    const privateDetail = "PRIVATE_FAULT_DETAIL";
    let error: unknown;
    try {
      await appendLabelEvent(
        { schemaVersion: 1, eventId: privateEventId, privateValue },
        root,
        { injectFault: () => { throw new Error(privateDetail); } },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "integrity" });
    const metadata = error && typeof error === "object"
      ? [String(error), "message" in error ? String(error.message) : "", "stack" in error ? String(error.stack) : "", "cause" in error ? String(error.cause) : ""]
      : [String(error)];
    const rendered = metadata.join("\n");
    expect(rendered).not.toContain(privateValue);
    expect(rendered).not.toContain(privateEventId);
    expect(rendered).not.toContain(privateDetail);
  });
});
