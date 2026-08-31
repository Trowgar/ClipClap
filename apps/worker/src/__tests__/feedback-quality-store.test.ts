import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendLabelEvent,
  contentId,
  ensureQualityTree,
  publishBundle,
  readBundle,
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

  it("appends labels atomically, makes exact repeats no-ops, and rejects event collisions", async () => {
    const root = await temporaryRoot();
    const event = { schemaVersion: 1, eventId: "event-1", disposition: "positive", privateNote: "PRIVATE_NOTE" };
    expect(await appendLabelEvent(event, root)).toEqual({ status: "committed" });
    expect(await appendLabelEvent({ privateNote: "PRIVATE_NOTE", disposition: "positive", eventId: "event-1", schemaVersion: 1 }, root)).toEqual({ status: "noop" });
    await expect(appendLabelEvent({ ...event, disposition: "exclude" }, root)).rejects.toMatchObject({ code: "integrity" });
    expect(await readFile(join(root, "ledger", "labels.jsonl"), "utf8")).toContain("PRIVATE_NOTE");
    expect(mode(await lstat(join(root, "ledger", "labels.jsonl")))).toBe(0o600);
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
  });

  it("does not leak private values in store errors", async () => {
    const root = await temporaryRoot();
    const privateValue = "PRIVATE_SECRET_VALUE";
    const id = contentId("case", { privateValue });
    await mkdir(root, 0o700);
    await symlink(join(root, "outside-does-not-exist"), join(root, "quality-link"));
    let error: unknown;
    try {
      await publishBundle(bundle("case", id, { "case.json": privateValue }), join(root, "quality-link"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "unsafe_path" });
    expect(String(error)).not.toContain(privateValue);
    expect(String(error)).not.toContain(id);
  });
});
