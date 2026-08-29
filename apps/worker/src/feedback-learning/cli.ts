import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { types as utilTypes } from "node:util";

import { parseUtcMillisecond } from "./canonical";
import type { ExportRequest } from "./export";

const RUN_PATTERN = /^(eval|holdout)-[0-9a-f]{16}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isArray = Array.isArray;
const regexpExec = RegExp.prototype.exec;
const jsonStringify = JSON.stringify;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapHas = Map.prototype.has;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get as (this: Map<unknown, unknown>) => number;
const setHas = Set.prototype.has;
const stringIncludes = String.prototype.includes;
const stringCharCodeAt = String.prototype.charCodeAt;
const dateGetTime = Date.prototype.getTime;
const SAFE_MACHINE_REASONS = new Set([
  "export_request_invalid", "review_request_invalid", "private_tree_failed", "ledger_read_failed",
  "database_snapshot_failed", "projection_failed", "publish_failed", "candidate_read_failed",
  "candidate_file_invalid", "candidate_not_found", "candidate_missing", "candidate_not_as_is",
  "candidate_changed", "destination_locked", "stale_review_requires_retirement", "already_approved",
  "already_rejected", "job_cap", "user_cap", "event_identity_invalid", "ledger_write_failed",
  "invalid_encoding", "invalid_jsonl", "invalid_event", "duplicate_event_id", "invalid_transition",
  "unsafe_path", "run_integrity", "invalid_input", "lock_timeout", "lock_unavailable",
  "durability_uncertain", "commit_indeterminate",
]);

export class CliInputError extends Error {
  readonly code = "invalid_arguments";
  constructor() {
    super("invalid_arguments");
    this.name = "CliInputError";
  }
}

export type ParsedReviewArguments =
  | Readonly<{ action: "approve"; runId: string; candidateVersion: string }>
  | Readonly<{ action: "reject"; runId: string; candidateVersion: string; reasonFile: string }>
  | Readonly<{ action: "correct"; targetEventId: string; operation: "retire"; reasonFile: string }>;

function invalid(): never {
  throw new CliInputError();
}

function captureArguments(raw: readonly string[]): string[] {
  try {
    if (!isArray(raw) || utilTypes.isProxy(raw) || getPrototype(raw) !== Array.prototype) return invalid();
    const length = getDescriptor(raw, "length");
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return invalid();
    const keys = ownKeys(raw);
    if (keys.length !== length.value + 1) return invalid();
    const result: string[] = [];
    for (let index = 0; index < length.value; index += 1) {
      if (keys[index] !== String(index)) return invalid();
      const descriptor = getDescriptor(raw, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") return invalid();
      Object.defineProperty(result, String(index), { configurable: true, enumerable: true, value: descriptor.value, writable: true });
    }
    if (keys[length.value] !== "length") return invalid();
    return result;
  } catch { return invalid(); }
}

function contains(values: readonly string[], expected: string): boolean {
  for (let index = 0; index < values.length; index += 1) if (values[index] === expected) return true;
  return false;
}

function readFlags(raw: readonly string[], allowed: readonly string[]): ReadonlyMap<string, string> {
  const args = captureArguments(raw);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || !contains(allowed, flag) || mapHas.call(values, flag) || flag.length === 0 || value.length === 0) return invalid();
    mapSet.call(values, flag, value);
  }
  return values;
}

function exactFlags(values: ReadonlyMap<string, string>, required: readonly string[], optional: readonly string[] = []): void {
  for (let index = 0; index < required.length; index += 1) if (!mapHas.call(values, required[index])) return invalid();
  const size = mapSize.call(values as Map<string, string>);
  if (size !== required.length && size !== required.length + optional.length) return invalid();
}

function flag(values: ReadonlyMap<string, string>, name: string): string {
  return (mapGet.call(values, name) as string | undefined) ?? invalid();
}

function validRunId(value: string): boolean {
  return regexpExec.call(RUN_PATTERN, value) !== null;
}

function validSha256(value: string): boolean {
  return regexpExec.call(SHA256_PATTERN, value) !== null;
}

function validEventId(value: string): boolean {
  return regexpExec.call(EVENT_PATTERN, value) !== null;
}

function validReasonPath(value: string): boolean {
  return value.length > 0 && !stringIncludes.call(value, "\0") && isWellFormedUnicode(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = stringCharCodeAt.call(value, index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = stringCharCodeAt.call(value, index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function parseExportArguments(raw: readonly string[]): Required<ExportRequest> {
  const values = readFlags(raw, ["--set", "--updated-from", "--updated-to", "--limit"]);
  exactFlags(values, ["--set", "--updated-from", "--updated-to"], ["--limit"]);
  const targetSet = flag(values, "--set");
  const updatedFrom = flag(values, "--updated-from");
  const updatedTo = flag(values, "--updated-to");
  if (targetSet !== "eval" && targetSet !== "holdout") return invalid();
  let from: Date;
  let to: Date;
  try {
    from = parseUtcMillisecond(updatedFrom);
    to = parseUtcMillisecond(updatedTo);
  } catch {
    return invalid();
  }
  if (dateGetTime.call(from) >= dateGetTime.call(to)) return invalid();
  const rawLimit = (mapGet.call(values, "--limit") as string | undefined) ?? "50";
  if (regexpExec.call(POSITIVE_INTEGER_PATTERN, rawLimit) === null) return invalid();
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit <= 0) return invalid();
  return { targetSet, updatedFrom, updatedTo, limit };
}

export function parseReviewArguments(raw: readonly string[]): ParsedReviewArguments {
  const args = captureArguments(raw);
  const action = args[0];
  if (action !== "approve" && action !== "reject" && action !== "correct") return invalid();
  const tail: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    Object.defineProperty(tail, String(index - 1), { configurable: true, enumerable: true, value: args[index], writable: true });
  }
  const values = readFlags(tail, ["--run", "--candidate-version", "--reason-file", "--target-event", "--operation"]);
  if (action === "approve") {
    exactFlags(values, ["--run", "--candidate-version"]);
    const runId = flag(values, "--run");
    const candidateVersion = flag(values, "--candidate-version");
    if (!validRunId(runId) || !validSha256(candidateVersion)) return invalid();
    return { action, runId, candidateVersion };
  }
  if (action === "reject") {
    exactFlags(values, ["--run", "--candidate-version", "--reason-file"]);
    const runId = flag(values, "--run");
    const candidateVersion = flag(values, "--candidate-version");
    const reasonFile = flag(values, "--reason-file");
    if (!validRunId(runId) || !validSha256(candidateVersion) || !validReasonPath(reasonFile)) return invalid();
    return { action, runId, candidateVersion, reasonFile };
  }
  exactFlags(values, ["--target-event", "--operation", "--reason-file"]);
  const targetEventId = flag(values, "--target-event");
  const operation = flag(values, "--operation");
  const reasonFile = flag(values, "--reason-file");
  if (!validEventId(targetEventId) || operation !== "retire" || !validReasonPath(reasonFile)) return invalid();
  return { action, targetEventId, operation, reasonFile };
}

export async function readPrivateReasonFile(path: string): Promise<string> {
  if (typeof path !== "string" || !validReasonPath(path)) return invalid();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if ((metadata.mode & constants.S_IFMT) !== constants.S_IFREG || (metadata.mode & 0o7777) !== 0o600) return invalid();
    const bytes = await handle.readFile();
    const finalMetadata = await handle.stat();
    if ((finalMetadata.mode & constants.S_IFMT) !== constants.S_IFREG || (finalMetadata.mode & 0o7777) !== 0o600) return invalid();
    let reason: string;
    try { reason = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return invalid(); }
    if (reason.length === 0 || !isWellFormedUnicode(reason)) return invalid();
    return reason;
  } catch { return invalid(); } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* The input remains invalid without exposing filesystem details. */ }
    }
  }
}

export type CommandOperation = "export" | "review";
export type CommandIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
export type CapturedExportCommandResult = Readonly<{
  operation: "export";
  runId: string;
  status: "committed" | "noop" | "committed_durability_uncertain" | "indeterminate";
  counts: unknown;
}>;
export type CapturedReviewCommandResult = Readonly<{
  operation: "review";
  eventId: string;
  status: "committed" | "noop" | "committed_durability_uncertain" | "indeterminate";
}>;
export const processCommandIo: CommandIo = Object.freeze({
  stdout(line: string): void { process.stdout.write(line); },
  stderr(line: string): void { process.stderr.write(line); },
});

export function machineReason(error: unknown, fallback: "export_failed" | "review_failed"): string {
  try {
    if (error === null || typeof error !== "object" || utilTypes.isProxy(error)) return fallback;
    const descriptor = getDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") return fallback;
    return setHas.call(SAFE_MACHINE_REASONS, descriptor.value) ? descriptor.value : fallback;
  } catch {
    return fallback;
  }
}

export function isCliInputError(error: unknown): error is CliInputError {
  try { return error !== null && typeof error === "object" && !utilTypes.isProxy(error) && error instanceof CliInputError; }
  catch { return false; }
}

class CommandBoundaryError extends Error {
  constructor() {
    super("invalid_command_boundary");
    this.name = "CommandBoundaryError";
  }
}

function commandBoundary(): never {
  throw new CommandBoundaryError();
}

function captureOwnData(value: unknown, allowed: readonly string[], expectedLength?: number): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || isArray(value)) return commandBoundary();
    const prototype = getPrototype(value);
    if (prototype !== Object.prototype && prototype !== null) return commandBoundary();
    const keys = ownKeys(value);
    if (expectedLength !== undefined && keys.length !== expectedLength) return commandBoundary();
    const captured: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string" || !contains(allowed, key)) return commandBoundary();
      const descriptor = getDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return commandBoundary();
      Object.defineProperty(captured, key, { configurable: true, enumerable: true, value: descriptor.value, writable: true });
    }
    return captured;
  } catch {
    return commandBoundary();
  }
}

function validCommitStatus(value: unknown): value is CapturedExportCommandResult["status"] {
  return value === "committed" || value === "noop" || value === "committed_durability_uncertain" || value === "indeterminate";
}

export function captureExportCommandResult(value: unknown): CapturedExportCommandResult {
  const captured = captureOwnData(value, ["operation", "runId", "status", "counts"], 4);
  if (captured.operation !== "export" || typeof captured.runId !== "string" || !validRunId(captured.runId) || !validCommitStatus(captured.status)) return commandBoundary();
  return { operation: "export", runId: captured.runId, status: captured.status, counts: captured.counts };
}

export function captureReviewCommandResult(value: unknown): CapturedReviewCommandResult {
  const captured = captureOwnData(value, ["operation", "eventId", "status"], 3);
  if (captured.operation !== "review" || typeof captured.eventId !== "string" || !validEventId(captured.eventId) || !validCommitStatus(captured.status)) return commandBoundary();
  return { operation: "review", eventId: captured.eventId, status: captured.status };
}

export function safeLog(fields: Readonly<{ operation: CommandOperation; runId?: string; eventId?: string; reason?: string }>): string {
  const captured = captureOwnData(fields, ["operation", "runId", "eventId", "reason"]);
  if ((captured.operation !== "export" && captured.operation !== "review") ||
      (captured.runId !== undefined && typeof captured.runId !== "string") ||
      (captured.eventId !== undefined && typeof captured.eventId !== "string") ||
      (captured.reason !== undefined && typeof captured.reason !== "string")) return commandBoundary();
  const hasRun = captured.runId !== undefined;
  const hasEvent = captured.eventId !== undefined;
  const hasReason = captured.reason !== undefined;
  if ((hasRun && hasEvent) || (!hasRun && !hasEvent && !hasReason) ||
      (!hasRun && !hasEvent && ownKeys(captured).length !== 2) ||
      (captured.operation === "export" && hasEvent) || (captured.operation === "review" && hasRun)) return commandBoundary();
  const output = Object.create(null) as Record<string, string>;
  output.operation = captured.operation;
  if (typeof captured.runId === "string") {
    if (!validRunId(captured.runId)) return commandBoundary();
    output.runId = captured.runId;
  }
  if (typeof captured.eventId === "string") {
    if (!validEventId(captured.eventId)) return commandBoundary();
    output.eventId = captured.eventId;
  }
  if (typeof captured.reason === "string") {
    if (captured.reason !== "invalid_arguments" && captured.reason !== "disconnect_failed" &&
        captured.reason !== "export_failed" && captured.reason !== "review_failed" &&
        captured.reason !== "composition_failed" && !setHas.call(SAFE_MACHINE_REASONS, captured.reason)) return commandBoundary();
    output.reason = captured.reason;
  }
  return `${jsonStringify(output)}\n`;
}

export const cliIdentifiers = Object.freeze({ validRunId, validEventId });
