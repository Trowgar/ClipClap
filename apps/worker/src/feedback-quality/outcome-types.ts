import type { Sha256 } from "../feedback-learning/types";
import type { Subsystem } from "./types";

export type OutcomeDisposition = "recoverable_false_negative" | "valid_empty" | "exclude";
export type OutcomeSet = "eval" | "holdout";
export type OutcomeConfidence = "high" | "medium";

export interface OutcomeWindow {
  start: number;
  end: number;
}

export interface OutcomeExpected {
  approvedWindows: OutcomeWindow[];
  forbiddenWindows: OutcomeWindow[];
}

interface OutcomeLabelBase {
  schemaVersion: 1;
  action: "label";
  eventId: string;
  occurredAt: string;
  caseVersion: Sha256;
  disposition: OutcomeDisposition;
  confidence: OutcomeConfidence;
  expected: OutcomeExpected;
}

export type OutcomeLabel =
  | (OutcomeLabelBase & { disposition: "recoverable_false_negative" | "valid_empty"; set: OutcomeSet })
  | (OutcomeLabelBase & { disposition: "exclude"; set?: never });

interface OutcomeCaseBase {
  schemaVersion: 1;
  caseVersion: Sha256;
  jobIdentitySha256: Sha256;
  analyzeStepSha256: Sha256;
  analysisVersion: string;
  engineFingerprint: Sha256;
  configSha256: Sha256;
  sourceDurationSec: number;
  transcriptSha256: Sha256;
  sourceSha256: Sha256;
  recordedResponsesSha256: Sha256;
  disposition: OutcomeDisposition;
  confidence: OutcomeConfidence;
  subsystem: Subsystem;
  expected: OutcomeExpected;
}

export type OutcomeCase =
  | (OutcomeCaseBase & { disposition: "recoverable_false_negative" | "valid_empty"; set: OutcomeSet })
  | (OutcomeCaseBase & { disposition: "exclude"; set?: never });

export class OutcomeSchemaError extends Error {
  constructor() {
    super("invalid_outcome_schema");
    this.name = "OutcomeSchemaError";
  }
}

export const MAX_OUTCOME_WINDOWS = 64;
export const MAX_OUTCOME_SECONDS = 7 * 24 * 60 * 60;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SUBSYSTEMS: readonly Subsystem[] = ["selection", "boundary", "framing", "subtitles", "render"];

function fail(): never {
  throw new OutcomeSchemaError();
}

function plainExact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length) fail();
  for (const key of actual) {
    if (typeof key !== "string" || !keys.includes(key)) fail();
    const descriptor = descriptors[key];
    if (descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) fail();
  }
  return value as Record<string, unknown>;
}

function hasOwnKey(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && Reflect.ownKeys(value).includes(key);
}

function denseArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(value.length) || value.length > maximum) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(descriptors);
  if (own.length !== value.length + 1 || !Object.prototype.hasOwnProperty.call(descriptors, "length")) fail();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) fail();
  }
  if (own.some((key) => typeof key !== "string" || (key !== "length" && !/^\d+$/.test(key)))) fail();
  return value;
}

function sha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function finiteSecond(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_OUTCOME_SECONDS;
}

function parseExpected(value: unknown, sourceDurationSec = MAX_OUTCOME_SECONDS): OutcomeExpected {
  const raw = plainExact(value, ["approvedWindows", "forbiddenWindows"]);
  const approvedRaw = denseArray(raw.approvedWindows, MAX_OUTCOME_WINDOWS);
  const forbiddenRaw = denseArray(raw.forbiddenWindows, MAX_OUTCOME_WINDOWS);
  if (approvedRaw.length + forbiddenRaw.length > MAX_OUTCOME_WINDOWS) fail();

  const parseWindows = (items: readonly unknown[]): OutcomeWindow[] => items.map((entry) => {
    const window = plainExact(entry, ["start", "end"]);
    if (!finiteSecond(window.start) || !finiteSecond(window.end) || window.end <= window.start || window.end > sourceDurationSec) fail();
    return Object.freeze({ start: window.start, end: window.end });
  });
  const approvedWindows = parseWindows(approvedRaw);
  const forbiddenWindows = parseWindows(forbiddenRaw);
  const ordered = [...approvedWindows, ...forbiddenWindows].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) fail();
  }
  return Object.freeze({ approvedWindows: Object.freeze(approvedWindows), forbiddenWindows: Object.freeze(forbiddenWindows) }) as unknown as OutcomeExpected;
}

function dispositionFields(raw: Record<string, unknown>, expected: OutcomeExpected): { disposition: OutcomeDisposition; confidence: OutcomeConfidence; set?: OutcomeSet } {
  const disposition = raw.disposition;
  const confidence = raw.confidence;
  const hasOwnSet = Object.prototype.hasOwnProperty.call(raw, "set");
  if (disposition !== "recoverable_false_negative" && disposition !== "valid_empty" && disposition !== "exclude") fail();
  if (confidence !== "high" && confidence !== "medium") fail();
  if (disposition === "recoverable_false_negative") {
    if (expected.approvedWindows.length === 0 || !hasOwnSet || (raw.set !== "eval" && raw.set !== "holdout")) fail();
    return { disposition, confidence, set: raw.set };
  }
  if (expected.approvedWindows.length !== 0) fail();
  if (disposition === "valid_empty") {
    if (!hasOwnSet || (raw.set !== "eval" && raw.set !== "holdout")) fail();
    return { disposition, confidence, set: raw.set };
  }
  if (expected.forbiddenWindows.length !== 0 || hasOwnSet) fail();
  return { disposition, confidence };
}

export function parseOutcomeLabel(value: unknown): OutcomeLabel {
  const preliminary = plainExact(value, hasOwnKey(value, "set")
    ? ["schemaVersion", "action", "eventId", "occurredAt", "caseVersion", "set", "disposition", "confidence", "expected"]
    : ["schemaVersion", "action", "eventId", "occurredAt", "caseVersion", "disposition", "confidence", "expected"]);
  if (preliminary.schemaVersion !== 1 || preliminary.action !== "label" || typeof preliminary.eventId !== "string" || !IMMUTABLE_TOKEN.test(preliminary.eventId) || !canonicalUtc(preliminary.occurredAt) || !sha256(preliminary.caseVersion)) fail();
  const expected = parseExpected(preliminary.expected);
  const fields = dispositionFields(preliminary, expected);
  return Object.freeze({
    schemaVersion: 1,
    action: "label",
    eventId: preliminary.eventId,
    occurredAt: preliminary.occurredAt,
    caseVersion: preliminary.caseVersion,
    ...(fields.set === undefined ? {} : { set: fields.set }),
    disposition: fields.disposition,
    confidence: fields.confidence,
    expected,
  }) as OutcomeLabel;
}

export function parseOutcomeCase(value: unknown): OutcomeCase {
  const hasSet = hasOwnKey(value, "set");
  const raw = plainExact(value, [
    "schemaVersion", "caseVersion", "jobIdentitySha256", "analyzeStepSha256", "analysisVersion",
    "engineFingerprint", "configSha256", "sourceDurationSec", "transcriptSha256", "sourceSha256",
    "recordedResponsesSha256", ...(hasSet ? ["set"] : []), "disposition", "confidence", "subsystem", "expected",
  ]);
  if (raw.schemaVersion !== 1 || !sha256(raw.caseVersion) || !sha256(raw.jobIdentitySha256) || !sha256(raw.analyzeStepSha256) ||
      typeof raw.analysisVersion !== "string" || !IMMUTABLE_TOKEN.test(raw.analysisVersion) || !sha256(raw.engineFingerprint) || !sha256(raw.configSha256) ||
      typeof raw.sourceDurationSec !== "number" || !Number.isFinite(raw.sourceDurationSec) || raw.sourceDurationSec <= 0 || raw.sourceDurationSec > MAX_OUTCOME_SECONDS ||
      !sha256(raw.transcriptSha256) || !sha256(raw.sourceSha256) || !sha256(raw.recordedResponsesSha256) || !SUBSYSTEMS.includes(raw.subsystem as Subsystem)) fail();
  const expected = parseExpected(raw.expected, raw.sourceDurationSec);
  const fields = dispositionFields(raw, expected);
  return Object.freeze({
    schemaVersion: 1,
    caseVersion: raw.caseVersion,
    jobIdentitySha256: raw.jobIdentitySha256,
    analyzeStepSha256: raw.analyzeStepSha256,
    analysisVersion: raw.analysisVersion,
    engineFingerprint: raw.engineFingerprint,
    configSha256: raw.configSha256,
    sourceDurationSec: raw.sourceDurationSec,
    transcriptSha256: raw.transcriptSha256,
    sourceSha256: raw.sourceSha256,
    recordedResponsesSha256: raw.recordedResponsesSha256,
    ...(fields.set === undefined ? {} : { set: fields.set }),
    disposition: fields.disposition,
    confidence: fields.confidence,
    subsystem: raw.subsystem,
    expected,
  }) as OutcomeCase;
}
