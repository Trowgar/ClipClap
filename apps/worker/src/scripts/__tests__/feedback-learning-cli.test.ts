import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CliInputError,
  parseExportArguments,
  parseReviewArguments,
  readPrivateReasonFile,
} from "../../feedback-learning/cli";
import { runFeedbackLearningExport } from "../feedback-learning-export";
import { runFeedbackLearningReview } from "../feedback-learning-review";

const RUN_ID = "eval-0123456789abcdef";
const SHA = `sha256:${"a".repeat(64)}`;
const EVENT_ID = "event-0123456789abcdef";
const FROM = "2026-08-26T00:00:00.000Z";
const TO = "2026-08-29T00:00:00.000Z";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true, force: true }));
  }
});

async function reasonFile(content = "Human review reason"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "feedback-learning-cli-"));
  temporary.push(root);
  const path = join(root, "reason.txt");
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

describe("feedback-learning CLI argument grammar", () => {
  it("parses export bounds and defaults limit to 50", () => {
    expect(parseExportArguments(["--set", "eval", "--updated-from", FROM, "--updated-to", TO])).toEqual({
      targetSet: "eval", updatedFrom: FROM, updatedTo: TO, limit: 50,
    });
    expect(parseExportArguments(["--limit", "7", "--updated-to", TO, "--set", "holdout", "--updated-from", FROM])).toMatchObject({ targetSet: "holdout", limit: 7 });
  });

  it.each([
    ["unknown flag", ["--set", "eval", "--updated-from", FROM, "--updated-to", TO, "--wat", "x"]],
    ["missing value", ["--set", "eval", "--updated-from", FROM, "--updated-to"]],
    ["duplicate flag", ["--set", "eval", "--set", "holdout", "--updated-from", FROM, "--updated-to", TO]],
    ["positional extra", ["extra", "--set", "eval", "--updated-from", FROM, "--updated-to", TO]],
    ["non-millisecond UTC", ["--set", "eval", "--updated-from", "2026-08-26T00:00:00Z", "--updated-to", TO]],
    ["offset time", ["--set", "eval", "--updated-from", "2026-08-26T01:00:00.000+01:00", "--updated-to", TO]],
    ["reversed range", ["--set", "eval", "--updated-from", TO, "--updated-to", FROM]],
    ["zero limit", ["--set", "eval", "--updated-from", FROM, "--updated-to", TO, "--limit", "0"]],
    ["fractional limit", ["--set", "eval", "--updated-from", FROM, "--updated-to", TO, "--limit", "1.5"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseExportArguments(argv)).toThrowError(CliInputError);
  });

  it("parses each closed review grammar", () => {
    expect(parseReviewArguments(["approve", "--run", RUN_ID, "--candidate-version", SHA])).toEqual({ action: "approve", runId: RUN_ID, candidateVersion: SHA });
    expect(parseReviewArguments(["reject", "--run", RUN_ID, "--candidate-version", SHA, "--reason-file", "/private/reason"])).toEqual({ action: "reject", runId: RUN_ID, candidateVersion: SHA, reasonFile: "/private/reason" });
    expect(parseReviewArguments(["correct", "--target-event", EVENT_ID, "--operation", "retire", "--reason-file", "/private/reason"])).toEqual({ action: "correct", targetEventId: EVENT_ID, operation: "retire", reasonFile: "/private/reason" });
  });

  it("does not depend on mutable Array or Map prototype methods", () => {
    const slice = Array.prototype.slice;
    const includes = Array.prototype.includes;
    const has = Map.prototype.has;
    const get = Map.prototype.get;
    const set = Map.prototype.set;
    let result: unknown;
    try {
      Array.prototype.slice = (() => { throw new Error("PRIVATE_SLICE"); }) as typeof slice;
      Array.prototype.includes = (() => { throw new Error("PRIVATE_INCLUDES"); }) as typeof includes;
      Map.prototype.has = (() => { throw new Error("PRIVATE_HAS"); }) as typeof has;
      Map.prototype.get = (() => { throw new Error("PRIVATE_GET"); }) as typeof get;
      Map.prototype.set = (() => { throw new Error("PRIVATE_SET"); }) as typeof set;
      result = parseReviewArguments(["approve", "--run", RUN_ID, "--candidate-version", SHA]);
    } finally {
      Array.prototype.slice = slice;
      Array.prototype.includes = includes;
      Map.prototype.has = has;
      Map.prototype.get = get;
      Map.prototype.set = set;
    }
    expect(result).toEqual({ action: "approve", runId: RUN_ID, candidateVersion: SHA });
  });

  it.each([
    ["approve reason", ["approve", "--run", RUN_ID, "--candidate-version", SHA, "--reason-file", "/x"]],
    ["reject missing reason", ["reject", "--run", RUN_ID, "--candidate-version", SHA]],
    ["wrong run", ["approve", "--run", "../escape", "--candidate-version", SHA]],
    ["wrong hash", ["approve", "--run", RUN_ID, "--candidate-version", `sha256:${"A".repeat(64)}`]],
    ["wrong operation", ["correct", "--target-event", EVENT_ID, "--operation", "delete", "--reason-file", "/x"]],
    ["empty event", ["correct", "--target-event", "", "--operation", "retire", "--reason-file", "/x"]],
    ["positional extra", ["approve", "extra", "--run", RUN_ID, "--candidate-version", SHA]],
    ["duplicate", ["approve", "--run", RUN_ID, "--run", RUN_ID, "--candidate-version", SHA]],
  ])("rejects review %s", (_name, argv) => {
    expect(() => parseReviewArguments(argv)).toThrowError(CliInputError);
  });
});

describe("private reason files", () => {
  it("reads a nonempty strict UTF-8 regular 0600 file", async () => {
    const path = await reasonFile("Причина\nс деталями");
    await expect(readPrivateReasonFile(path)).resolves.toBe("Причина\nс деталями");
  });

  it("rejects wrong modes, symlinks, directories, empty and invalid UTF-8 without leaking details", async () => {
    const wrongMode = await reasonFile("PRIVATE_WRONG_MODE");
    await chmod(wrongMode, 0o640);
    const root = temporary[temporary.length - 1];
    const link = join(root, "reason-link");
    await symlink(wrongMode, link);
    const empty = join(root, "empty");
    await writeFile(empty, "", { mode: 0o600 });
    const invalid = join(root, "invalid");
    await writeFile(invalid, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    for (const path of [wrongMode, link, root, empty, invalid]) {
      let failure: unknown;
      try { await readPrivateReasonFile(path); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CliInputError);
      expect(String(failure)).not.toContain(path);
      expect(String(failure)).not.toContain("PRIVATE_WRONG_MODE");
    }
  });
});

function outputCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

describe("thin command runners", () => {
  it("exports once, logs only operation and runId, and disconnects exactly once", async () => {
    const capture = outputCapture();
    const disconnect = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({ operation: "export" as const, runId: RUN_ID, status: "committed" as const,
      counts: { queried: 99, selected: 1, excluded: 98, selectedReplayReady: 1, selectedReferenceOnly: 0, freshApprovals: 0, staleReservations: 0 } }));
    const code = await runFeedbackLearningExport(["--set", "eval", "--updated-from", FROM, "--updated-to", TO],
      { repository: {} as never, execute, disconnect }, capture.io);
    expect(code).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(capture.stdout).toEqual([`{"operation":"export","runId":"${RUN_ID}"}\n`]);
    expect(capture.stderr).toEqual([]);
    expect(capture.stdout.join("")).not.toContain("99");
  });

  it.each([
    ["committed_durability_uncertain", "durability_uncertain"],
    ["indeterminate", "commit_indeterminate"],
  ] as const)("returns nonzero and an allowlisted machine reason for export %s", async (status, reason) => {
    const capture = outputCapture();
    const code = await runFeedbackLearningExport(["--set", "eval", "--updated-from", FROM, "--updated-to", TO], {
      repository: {} as never,
      execute: vi.fn(async () => ({ operation: "export" as const, runId: RUN_ID, status, counts: {} as never })),
      disconnect: vi.fn(async () => undefined),
    }, capture.io);
    expect(code).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([`{"operation":"export","runId":"${RUN_ID}","reason":"${reason}"}\n`]);
    expect(JSON.parse(capture.stderr[0])).not.toHaveProperty("status");
  });

  it("maps private export failures to a closed machine reason and disconnects", async () => {
    const capture = outputCapture();
    const disconnect = vi.fn(async () => undefined);
    const execute = vi.fn(async () => { throw new Error("PRIVATE_TRANSCRIPT candidate-version"); });
    const code = await runFeedbackLearningExport(["--set", "eval", "--updated-from", FROM, "--updated-to", TO],
      { repository: {} as never, execute, disconnect }, capture.io);
    expect(code).toBe(1);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([`{"operation":"export","reason":"export_failed"}\n`]);
  });

  it("contains hostile Proxy errors without skipping disconnect", async () => {
    const capture = outputCapture();
    const disconnect = vi.fn(async () => undefined);
    const execute = vi.fn(async () => {
      throw new Proxy(new Error("PRIVATE_PROXY"), {
        getPrototypeOf() { throw new Error("PRIVATE_TRAP"); },
        getOwnPropertyDescriptor() { throw new Error("PRIVATE_TRAP"); },
      });
    });
    const code = await runFeedbackLearningExport(["--set", "eval", "--updated-from", FROM, "--updated-to", TO],
      { repository: {} as never, execute, disconnect }, capture.io);
    expect(code).toBe(1);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(capture.stderr).toEqual([`{"operation":"export","reason":"export_failed"}\n`]);
  });

  it("loads rejection reason outside argv output and logs only the review event", async () => {
    const path = await reasonFile("PRIVATE_REASON_TEXT");
    const capture = outputCapture();
    const disconnect = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({ operation: "review" as const, eventId: EVENT_ID, status: "committed" as const }));
    const code = await runFeedbackLearningReview(["reject", "--run", RUN_ID, "--candidate-version", SHA, "--reason-file", path],
      { repository: {} as never, execute, disconnect }, capture.io);
    expect(code).toBe(0);
    expect(execute).toHaveBeenCalledWith({ action: "reject", runId: RUN_ID, candidateVersion: SHA, reason: "PRIVATE_REASON_TEXT" }, expect.anything());
    expect(disconnect).toHaveBeenCalledOnce();
    expect(capture.stdout).toEqual([`{"operation":"review","eventId":"${EVENT_ID}"}\n`]);
    expect(capture.stdout.join("") + capture.stderr.join("")).not.toContain(path);
    expect(capture.stdout.join("") + capture.stderr.join("")).not.toContain(SHA);
    expect(capture.stdout.join("") + capture.stderr.join("")).not.toContain("PRIVATE_REASON_TEXT");
  });

  it("returns nonzero with eventId and a machine reason for indeterminate review", async () => {
    const capture = outputCapture();
    const code = await runFeedbackLearningReview(["approve", "--run", RUN_ID, "--candidate-version", SHA], {
      repository: {} as never,
      execute: vi.fn(async () => ({ operation: "review" as const, eventId: EVENT_ID, status: "indeterminate" as const })),
      disconnect: vi.fn(async () => undefined),
    }, capture.io);
    expect(code).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([`{"operation":"review","eventId":"${EVENT_ID}","reason":"commit_indeterminate"}\n`]);
  });

  it("rejects bad review argv before core work and disconnects once", async () => {
    const capture = outputCapture();
    const disconnect = vi.fn(async () => undefined);
    const execute = vi.fn();
    const code = await runFeedbackLearningReview(["approve", "--run", "PRIVATE_BAD", "--candidate-version", SHA],
      { repository: {} as never, execute, disconnect }, capture.io);
    expect(code).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(capture.stderr).toEqual([`{"operation":"review","reason":"invalid_arguments"}\n`]);
  });

  it("returns failure without double-disconnect when disconnect itself fails", async () => {
    const capture = outputCapture();
    const disconnect = vi.fn(async () => { throw new Error("PRIVATE_DISCONNECT"); });
    const code = await runFeedbackLearningExport(["--set", "eval", "--updated-from", FROM, "--updated-to", TO],
      { repository: {} as never, execute: vi.fn(async () => ({ operation: "export", runId: RUN_ID } as never)), disconnect }, capture.io);
    expect(code).toBe(1);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(capture.stderr).toEqual([`{"operation":"export","reason":"disconnect_failed"}\n`]);
  });
});
