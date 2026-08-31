import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runFeedbackQualityPromote } from "../feedback-quality-promote";

const temporary: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("feedback-quality-promote CLI", () => {
  it("accepts only the promote decision-file command and emits an allow-listed line", async () => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const execute = vi.fn(async () => ({ status: "committed" as const, eventId: "event-1", caseVersion: "case:sha256:" + "a".repeat(64) }));
    const result = await runFeedbackQualityPromote(["promote", "--decision-file", "/private/decision.json"], { execute, retire: vi.fn(), readDecision: vi.fn(async () => ({})), io });
    expect(result).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(expect.stringMatching(/^\{"operation":"promote","eventId":"event-1","caseVersion":"case:sha256:a{64}","status":"committed"\}$/));
    expect(io.stdout.mock.calls[0][0]).not.toContain("private");
  });

  it.each([
    { argv: [] }, { argv: ["promote"] }, { argv: ["promote", "--decision-file"] },
    { argv: ["promote", "--decision-file", "/tmp/x", "--extra", "y"] }, { argv: ["retire", "--target-event", "x"] },
  ])("rejects malformed command: $argv", async ({ argv }: { argv: readonly string[] }) => {
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await runFeedbackQualityPromote(argv, { execute: vi.fn(), retire: vi.fn(), readDecision: vi.fn(), io })).toBe(2);
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
    expect(await runFeedbackQualityPromote(["retire", "--target-event", "event-1", "--reason-file", reasonFile], { execute: vi.fn(), retire, readDecision: vi.fn(), io })).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith('{"operation":"retire","eventId":"event-2","status":"committed"}');
    await chmod(reasonFile, 0o644);
    expect(await runFeedbackQualityPromote(["retire", "--target-event", "event-1", "--reason-file", reasonFile], { execute: vi.fn(), retire, readDecision: vi.fn(), io })).toBe(1);
  });
});
