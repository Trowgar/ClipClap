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
const regexpTest = RegExp.prototype.test;
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
  return regexpTest.call(RUN_PATTERN, value);
}

function validSha256(value: string): boolean {
  return regexpTest.call(SHA256_PATTERN, value);
}

function validEventId(value: string): boolean {
  return regexpTest.call(EVENT_PATTERN, value);
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
  if (!regexpTest.call(POSITIVE_INTEGER_PATTERN, rawLimit)) return invalid();
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

export function safeLog(fields: Readonly<{ operation: CommandOperation; runId?: string; eventId?: string; reason?: string }>): string {
  const output = Object.create(null) as Record<string, string>;
  output.operation = fields.operation;
  if (fields.runId !== undefined) {
    if (!validRunId(fields.runId)) throw new CliInputError();
    output.runId = fields.runId;
  }
  if (fields.eventId !== undefined) {
    if (!validEventId(fields.eventId)) throw new CliInputError();
    output.eventId = fields.eventId;
  }
  if (fields.reason !== undefined) {
    if (fields.reason !== "invalid_arguments" && fields.reason !== "disconnect_failed" &&
        fields.reason !== "export_failed" && fields.reason !== "review_failed" &&
        fields.reason !== "composition_failed" && !setHas.call(SAFE_MACHINE_REASONS, fields.reason)) throw new CliInputError();
    output.reason = fields.reason;
  }
  return `${jsonStringify(output)}\n`;
}

export const cliIdentifiers = Object.freeze({ validRunId, validEventId });
