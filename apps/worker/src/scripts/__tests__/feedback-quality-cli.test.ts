import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeFeedbackQualityPromoteDependenciesWithPrisma, MAX_DECISION_FILE_BYTES, MAX_REASON_FILE_BYTES, readDecisionFile, readReasonFile, runFeedbackQualityPromote } from "../feedback-quality-promote";

const temporary: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("feedback-quality-promote CLI", () => {
  it("accepts only the promote decision-file command and emits an allow-listed line", async () => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const execute = vi.fn(async () => ({ status: "committed" as const, eventId: "event-1", caseVersion: "case:sha256:" + "a".repeat(64) }));
    const disconnect = vi.fn(async () => undefined);
    const result = await runFeedbackQualityPromote(["promote", "--decision-file", "/private/decision.json"], { execute, retire: vi.fn(), readDecision: vi.fn(async () => ({})), disconnect, io });
    expect(result).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(io.stdout).toHaveBeenCalledWith(expect.stringMatching(/^\{"operation":"promote","eventId":"event-1","caseVersion":"case:sha256:a{64}","status":"committed"\}$/));
    expect(io.stdout.mock.calls[0][0]).not.toContain("private");
  });

  it.each([
    { argv: [] }, { argv: ["promote"] }, { argv: ["promote", "--decision-file"] },
    { argv: ["promote", "--decision-file", "/tmp/x", "--extra", "y"] }, { argv: ["retire", "--target-event", "x"] },
  ])("rejects malformed command: $argv", async ({ argv }: { argv: readonly string[] }) => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const disconnect = vi.fn(async () => undefined);
    expect(await runFeedbackQualityPromote(argv, { execute: vi.fn(), retire: vi.fn(), readDecision: vi.fn(), disconnect, io })).toBe(2);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining("invalid_arguments"));
  });

  it("reads a private 0600 reason file for the append-only retire command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clipclap-promote-cli-"));
    temporary.push(directory);
    const reasonFile = join(directory, "reason.txt");
    await writeFile(reasonFile, "corrected review", { mode: 0o600 });
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const retire = vi.fn(async (request: { action: "retire"; targetEventId: string; reason: string }) => {
      expect(request).toEqual({ action: "retire", targetEventId: "event-1", reason: "corrected review" });
      return { status: "committed" as const, eventId: "event-2" };
    });
    expect(await runFeedbackQualityPromote(["retire", "--target-event", "event-1", "--reason-file", reasonFile], { execute: vi.fn(), retire, readDecision: vi.fn(), disconnect: vi.fn(async () => undefined), io })).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith('{"operation":"retire","eventId":"event-2","status":"committed"}');
    await chmod(reasonFile, 0o644);
    expect(await runFeedbackQualityPromote(["retire", "--target-event", "event-1", "--reason-file", reasonFile], { execute: vi.fn(), retire, readDecision: vi.fn(), disconnect: vi.fn(async () => undefined), io })).toBe(1);
  });

  it("fails closed and logs only an allow-listed reason when Prisma disconnect fails", async () => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const result = await runFeedbackQualityPromote(["promote", "--decision-file", "/private/decision.json"], {
      execute: vi.fn(async () => ({ status: "committed" as const, eventId: "event-1" })),
      retire: vi.fn(),
      readDecision: vi.fn(async () => ({})),
      disconnect: vi.fn(async () => { throw new Error("PRIVATE_DATABASE_DETAIL"); }),
      io,
    });
    expect(result).toBe(1);
    expect(io.stdout).not.toHaveBeenCalled();
    expect(io.stderr).toHaveBeenCalledWith('{"operation":"promote","reason":"disconnect_failed"}');
    expect(io.stderr.mock.calls[0][0]).not.toContain("PRIVATE_DATABASE_DETAIL");
  });

  it("disconnects and fails closed when a hostile thrown value breaks Error inspection", async () => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const disconnect = vi.fn(async () => undefined);
    const hostile = new Proxy(new Error("private"), { getPrototypeOf: () => { throw new Error("PRIVATE_TRAP"); } });
    const result = await runFeedbackQualityPromote(["promote", "--decision-file", "/private/decision.json"], {
      execute: vi.fn(async () => { throw hostile; }),
      retire: vi.fn(), readDecision: vi.fn(async () => ({})), disconnect, io,
    });
    expect(result).toBe(1);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(io.stderr).toHaveBeenCalledWith('{"operation":"promote","reason":"promotion_failed"}');
  });

  it("disconnects Prisma when dependency composition fails after Prisma loads", async () => {
    const disconnect = vi.fn(async () => undefined);
    await expect(composeFeedbackQualityPromoteDependenciesWithPrisma({ $disconnect: disconnect } as never, {
      loadR2: vi.fn(async () => { throw new Error("r2 import failed"); }),
      ensureTree: vi.fn(async () => ({} as never)),
    })).rejects.toThrow("r2 import failed");
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("bounds private decision/reason files and refuses symlink paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clipclap-promote-private-"));
    temporary.push(directory);
    const decisionFile = join(directory, "decision.json");
    const reasonFile = join(directory, "reason.txt");
    await writeFile(decisionFile, Buffer.alloc(MAX_DECISION_FILE_BYTES + 1), { mode: 0o600 });
    await writeFile(reasonFile, Buffer.alloc(MAX_REASON_FILE_BYTES + 1), { mode: 0o600 });
    await expect(readDecisionFile(decisionFile)).rejects.toThrow("private_file_invalid");
    await expect(readReasonFile(reasonFile)).rejects.toThrow("private_file_invalid");
    const target = join(directory, "target");
    const link = join(directory, "link");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, link);
    await expect(readDecisionFile(link)).rejects.toThrow("private_file_invalid");
  });

  it("rejects an empty reason as invalid UTF-8 input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clipclap-promote-empty-"));
    temporary.push(directory);
    const reasonFile = join(directory, "reason.txt");
    await writeFile(reasonFile, "", { mode: 0o600 });
    await expect(readReasonFile(reasonFile)).rejects.toThrow("reason_file_invalid");
  });
});
