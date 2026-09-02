/**
 * Offline, real-source visual-recall gate.
 *
 * Usage:
 *   npm run eval:visual-recall --workspace apps/worker -- /private/manifest.json
 *
 * The manifest is deliberately private and anonymous. It contains only a
 * `caseKey` (not a job/user/source id), `kind` (`gaming`, `as_is`, or
 * `other`), local source/transcript paths, human-labelled time windows, and an
 * `invarianceEvidencePath` to separate deterministic off-vs-shadow replay
 * evidence. This command has no model or
 * database dependency; it computes motion from each local source and maps
 * peaks to the local transcript.
 *
 * Output is a sanitized report: source paths, transcript paths, transcript
 * text, and external identifiers never leave the private input files.
 */
import { open as fsOpen, readFile, stat as fsStat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildSentenceGraph } from "../analyze-v2/sentence-graph";
import { loadAnalyzeConfig, type AnalyzeConfig } from "../analyze-v2/config";
import { nominateVisualCandidates } from "../analyze-v2/visual-candidates";
import {
  videoEnvelopesFromFd,
  type VideoEnvelopes,
} from "../processors/video-envelopes";
import type { TranscriptionResult } from "@clipclap/shared";

const execFileAsync = promisify(execFile);

export interface EvalWindow {
  start: number;
  end: number;
}

export type EvalCaseKind = "gaming" | "as_is" | "other";

export interface EvalManifestCase {
  caseKey: string;
  kind: EvalCaseKind;
  sourcePath: string;
  transcriptPath: string;
  positiveWindows: EvalWindow[];
  negativeWindows: EvalWindow[];
}

export interface EvalManifest {
  version: 1;
  invarianceEvidencePath: string;
  cases: EvalManifestCase[];
}

export interface InvarianceEvidence {
  version: 1;
  passed: boolean;
  testName: "visual-recall-wiring";
  offHighlightsSha256: string;
  shadowHighlightsSha256: string;
  testedCommit: string;
}

export interface EvalCaseResult {
  caseKey: string;
  kind: EvalCaseKind;
  positiveWindows: EvalWindow[];
  negativeWindows: EvalWindow[];
  nominatedWindows: EvalWindow[];
  candidateCount: number;
}

export interface EvalCaseReport {
  caseKey: string;
  kind: EvalCaseKind;
  candidateCount: number;
  positive: { total: number; matched: number; recall: number };
  negative: { total: number; matched: number; hitRate: number | null; available: boolean };
  nominations: Array<{ start: number; end: number; peakSec: number; peakValue: number }>;
}

export interface EvalSummary {
  positiveRecall: number;
  positiveMatchedWindows: number;
  positiveWindows: number;
  gamingMatchedWindows: number;
  asIsMatchedWindows: number;
  asIsPositiveWindows: number;
  negativeWindowHitRate: number | null;
  negativeControlsAvailable: boolean;
  gates: {
    gamingMinimum: boolean;
    asIsRetention: boolean;
    candidateCap: boolean;
    offShadowInvariant: boolean;
  };
  failureReasons: string[];
  pass: boolean;
}

export interface EvalReport {
  schemaVersion: 1;
  candidateCap: number;
  offShadowInvariant: { required: true; passed: boolean; separatelyVerified: boolean };
  cases: EvalCaseReport[];
  summary: EvalSummary;
  pass: boolean;
}

export interface VisualRecallEvalIo {
  stat(path: string): Promise<{ size: number; isFile: (() => boolean) | boolean }>;
  readFile(path: string): Promise<string | Buffer>;
  open?(path: string): Promise<EvalFileHandle>;
  stdout?(value: string): void;
  stderr?(value: string): void;
}

export interface EvalFileHandle {
  fd: number;
  stat(): Promise<{ size: number; isFile: () => boolean }>;
  readFile(): Promise<string | Buffer>;
  close(): Promise<void>;
}

type EvalConfig = Pick<
  AnalyzeConfig,
  | "visualRecallMode"
  | "visualRecallMaxCandidates"
  | "visualRecallClusterSec"
  | "visualRecallPreSec"
  | "visualRecallPostSec"
  | "visualRecallMaxNodeDistanceSec"
  | "scanWindowSec"
>;

interface CliDependencies {
  loadConfig?: () => Partial<AnalyzeConfig>;
  /** Test-only path hook; production uses the descriptor hook below. */
  videoEnvelopes?: (sourcePath: string) => Promise<VideoEnvelopes>;
  videoEnvelopesFromFd?: (sourceFd: number) => Promise<VideoEnvelopes>;
  resolveCurrentCommit?: () => Promise<string>;
  resolveWorktreeDirty?: () => Promise<boolean>;
}

export interface VisualRecallCliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CASES = 500;
const MAX_WINDOWS_PER_CASE = 500;
const MAX_TIME_SEC = 7 * 24 * 60 * 60;
const CASE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWindow(value: unknown): EvalWindow {
  if (!isRecord(value)) throw new Error("window must be an object");
  const start = value.start;
  const end = value.end;
  if (
    typeof start !== "number" || typeof end !== "number" ||
    !Number.isFinite(start) || !Number.isFinite(end) ||
    start < 0 || end <= start || end > MAX_TIME_SEC
  ) {
    throw new Error("window must have a finite positive range");
  }
  return { start, end };
}

function parseWindows(value: unknown, required: boolean): EvalWindow[] {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`${required ? "positiveWindows" : "negativeWindows"} must be an array`);
  }
  if (value.length > MAX_WINDOWS_PER_CASE) throw new Error("too many windows");
  return value.map(parseWindow);
}

function parsePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 4096 ||
    value.includes("\0") || !isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    throw new Error(`${label} must be an absolute local path`);
  }
  return value;
}

/** Parse the private manifest before any source or transcript work starts. */
export function parseEvalManifest(value: unknown): EvalManifest {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("manifest requires version 1");
  }
  const invarianceEvidencePath = parsePath(value.invarianceEvidencePath, "invarianceEvidencePath");
  if (!Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > MAX_CASES) {
    throw new Error("cases must be a non-empty bounded array");
  }
  const keys = new Set<string>();
  const sourcePaths = new Set<string>();
  const cases = value.cases.map((rawCase) => {
    if (!isRecord(rawCase)) throw new Error("case must be an object");
    const caseKey = rawCase.caseKey;
    if (typeof caseKey !== "string" || !CASE_KEY.test(caseKey) || keys.has(caseKey)) {
      throw new Error("caseKey must be unique and anonymous");
    }
    keys.add(caseKey);
    const kind = rawCase.kind;
    if (kind !== "gaming" && kind !== "as_is" && kind !== "other") {
      throw new Error("kind must be gaming, as_is, or other");
    }
    const parsedKind: EvalCaseKind = kind;
    const positiveWindows = parseWindows(rawCase.positiveWindows, true);
    const negativeWindows = rawCase.negativeWindows === undefined
      ? []
      : parseWindows(rawCase.negativeWindows, false);
    const assertNoDuplicates = (windows: EvalWindow[], label: string) => {
      const seen = new Set(windows.map((item) => `${item.start}:${item.end}`));
      if (seen.size !== windows.length) throw new Error(`duplicate ${label} window`);
    };
    assertNoDuplicates(positiveWindows, "positive");
    assertNoDuplicates(negativeWindows, "negative");
    const sourcePath = parsePath(rawCase.sourcePath, "sourcePath");
    const normalizedSourcePath = normalize(sourcePath);
    if (sourcePaths.has(normalizedSourcePath)) throw new Error("duplicate sourcePath");
    sourcePaths.add(normalizedSourcePath);
    const sortedPositive = [...positiveWindows].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < sortedPositive.length; index++) {
      if (sortedPositive[index].start < sortedPositive[index - 1].end) {
        throw new Error("overlapping positive windows represent one human event");
      }
    }
    return {
      caseKey,
      kind: parsedKind,
      sourcePath,
      transcriptPath: parsePath(rawCase.transcriptPath, "transcriptPath"),
      positiveWindows,
      negativeWindows,
    };
  });
  return { version: 1, invarianceEvidencePath, cases };
}

export function parseInvarianceEvidence(value: unknown): InvarianceEvidence {
  if (!isRecord(value) || value.version !== 1 || typeof value.passed !== "boolean") {
    throw new Error("invariance evidence is malformed");
  }
  if (value.testName !== "visual-recall-wiring") {
    throw new Error("invariance evidence testName is not allowlisted");
  }
  if (
      typeof value.offHighlightsSha256 !== "string" ||
      typeof value.shadowHighlightsSha256 !== "string" ||
      typeof value.testedCommit !== "string" ||
      !/^[a-f0-9]{64}$/iu.test(value.offHighlightsSha256) ||
      !/^[a-f0-9]{64}$/iu.test(value.shadowHighlightsSha256) ||
      !/^[a-f0-9]{40}$/iu.test(value.testedCommit)) {
    throw new Error("invariance evidence is malformed");
  }
  return {
    version: 1,
    passed: value.passed,
    testName: "visual-recall-wiring",
    offHighlightsSha256: value.offHighlightsSha256,
    shadowHighlightsSha256: value.shadowHighlightsSha256,
    testedCommit: value.testedCommit,
  };
}

/** Evidence is valid only for the exact clean tree that produced it. */
export function invarianceGate(
  evidence: InvarianceEvidence,
  currentCommit: string,
  worktreeDirty: boolean,
): boolean {
  return evidence.passed && !worktreeDirty &&
    evidence.offHighlightsSha256.toLowerCase() === evidence.shadowHighlightsSha256.toLowerCase() &&
    /^[a-f0-9]{40}$/iu.test(currentCommit) &&
    evidence.testedCommit.toLowerCase() === currentCommit.toLowerCase();
}

function validWindow(value: EvalWindow): boolean {
  return Number.isFinite(value.start) && Number.isFinite(value.end) &&
    value.start >= 0 && value.end > value.start;
}

/** True when overlap is at least `threshold` of the shorter range.
 * The public helper accepts either a fraction (0.2) or the plan's percentage
 * spelling (20), which keeps replay notebooks readable without ambiguity. */
export function matchesWindow(
  candidate: EvalWindow,
  target: EvalWindow,
  threshold = 0.2,
): boolean {
  const thresholdFraction = Number.isInteger(threshold) && threshold > 1
    ? threshold / 100
    : threshold;
  if (!validWindow(candidate) || !validWindow(target) ||
      !Number.isFinite(thresholdFraction) || thresholdFraction < 0 || thresholdFraction > 1) return false;
  const overlap = Math.max(0, Math.min(candidate.end, target.end) - Math.max(candidate.start, target.start));
  if (overlap <= 0) return false;
  return overlap / Math.min(candidate.end - candidate.start, target.end - target.start) >= thresholdFraction;
}

function matchedCount(targets: readonly EvalWindow[], nominated: readonly EvalWindow[]): number {
  const candidateByTarget = targets.map((target) => nominated
    .map((candidate, candidateIndex) => matchesWindow(candidate, target) ? candidateIndex : -1)
    .filter((candidateIndex) => candidateIndex >= 0));
  const targetByCandidate = new Map<number, number>();
  const visit = (targetIndex: number, seen: Set<number>): boolean => {
    for (const candidateIndex of candidateByTarget[targetIndex]) {
      if (seen.has(candidateIndex)) continue;
      seen.add(candidateIndex);
      const previousTarget = targetByCandidate.get(candidateIndex);
      if (previousTarget === undefined || visit(previousTarget, seen)) {
        targetByCandidate.set(candidateIndex, targetIndex);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    if (visit(targetIndex, new Set())) matched++;
  }
  return matched;
}

function ratio(matched: number, total: number): number {
  return total === 0 ? 0 : matched / total;
}

/** Aggregate pure, sanitized corpus metrics and all release-gate reasons. */
export function summarizeCases(
  cases: readonly EvalCaseResult[],
  options: { candidateCap?: number; offShadowInvariant?: boolean } = {},
): EvalSummary {
  const candidateCap = Number.isInteger(options.candidateCap) && (options.candidateCap ?? 0) > 0
    ? options.candidateCap as number
    : 12;
  let positiveWindows = 0;
  let positiveMatchedWindows = 0;
  let gamingMatchedWindows = 0;
  let gamingCases = 0;
  let asIsPositiveWindows = 0;
  let asIsMatchedWindows = 0;
  let negativeWindows = 0;
  let negativeMatchedWindows = 0;
  const capOk = cases.every((item) =>
    Number.isInteger(item.candidateCount) && item.candidateCount >= 0 && item.candidateCount <= candidateCap,
  );
  for (const item of cases) {
    const positiveMatched = matchedCount(item.positiveWindows, item.nominatedWindows);
    positiveWindows += item.positiveWindows.length;
    positiveMatchedWindows += positiveMatched;
    if (item.kind === "gaming") {
      gamingCases += 1;
      gamingMatchedWindows += positiveMatched;
    }
    if (item.kind === "as_is") {
      asIsPositiveWindows += item.positiveWindows.length;
      asIsMatchedWindows += positiveMatched;
    }
    negativeWindows += item.negativeWindows.length;
    negativeMatchedWindows += matchedCount(item.negativeWindows, item.nominatedWindows);
  }
  const gates = {
    gamingMinimum: gamingCases > 0 && gamingMatchedWindows >= 2,
    asIsRetention: asIsPositiveWindows > 0 && asIsMatchedWindows === asIsPositiveWindows,
    candidateCap: capOk,
    offShadowInvariant: options.offShadowInvariant === true,
  };
  const failureReasons: string[] = [];
  if (!gates.gamingMinimum) failureReasons.push("gaming_positive_recall_below_two_windows");
  if (!gates.asIsRetention) failureReasons.push("as_is_positive_window_not_retained");
  if (!gates.candidateCap) failureReasons.push("candidate_cap_exceeded");
  if (!gates.offShadowInvariant) failureReasons.push("off_shadow_invariance_not_verified");
  return {
    positiveRecall: ratio(positiveMatchedWindows, positiveWindows),
    positiveMatchedWindows,
    positiveWindows,
    gamingMatchedWindows,
    asIsMatchedWindows,
    asIsPositiveWindows,
    negativeWindowHitRate: negativeWindows > 0 ? ratio(negativeMatchedWindows, negativeWindows) : null,
    negativeControlsAvailable: negativeWindows > 0,
    gates,
    failureReasons,
    pass: Object.values(gates).every(Boolean),
  };
}

function defaultIo(): VisualRecallEvalIo {
  return {
    stat: async (path) => fsStat(path),
    readFile: async (path) => readFile(path),
    open: async (path) => fsOpen(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

async function boundedRegularFileHandle(
  handle: EvalFileHandle,
  maximumBytes: number,
): Promise<number> {
  const info = await handle.stat();
  const regular = typeof info.isFile === "function" ? info.isFile() : info.isFile;
  if (!Number.isFinite(info.size) || info.size < 0 || info.size > maximumBytes || regular !== true) {
    throw new Error("not a bounded regular file");
  }
  return info.size;
}

async function openBoundedFile(
  io: VisualRecallEvalIo,
  path: string,
  maximumBytes: number,
): Promise<EvalFileHandle> {
  if (!io.open) {
    // Legacy test doubles may expose path stat/read only. Production's
    // defaultIo always supplies open(), so real evaluations remain descriptor
    // stable; this branch exists solely for older pure-CLI tests.
    const info = await io.stat(path);
    const regular = typeof info.isFile === "function" ? info.isFile() : info.isFile;
    if (!Number.isFinite(info.size) || info.size < 0 || info.size > maximumBytes || regular !== true) {
      throw new Error("not a bounded regular file");
    }
    return {
      fd: -1,
      stat: async () => ({ size: info.size, isFile: () => true }),
      readFile: () => io.readFile(path),
      close: async () => undefined,
    };
  }
  const handle = await io.open(path);
  try {
    await boundedRegularFileHandle(handle, maximumBytes);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function defaultCurrentCommit(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    maxBuffer: 4096,
  });
  return stdout.trim();
}

async function defaultWorktreeDirty(): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
    maxBuffer: 64 * 1024,
  });
  return stdout.trim().length > 0;
}

async function defaultVideoEnvelopesFromFd(sourceFd: number): Promise<VideoEnvelopes> {
  return videoEnvelopesFromFd(sourceFd);
}

function textBytes(raw: string | Buffer): number {
  return typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
}

function parseTranscription(value: unknown): TranscriptionResult {
  if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.segments)) {
    throw new Error("transcript must contain text and segments");
  }
  const segments = value.segments.map((segment) => {
    if (!isRecord(segment) || typeof segment.text !== "string" ||
        typeof segment.start !== "number" || typeof segment.end !== "number" ||
        !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        segment.start < 0 || segment.end <= segment.start) {
      throw new Error("transcript segment is malformed");
    }
    if (segment.words !== undefined) {
      if (!Array.isArray(segment.words)) throw new Error("transcript words are malformed");
      for (const word of segment.words) {
        if (!isRecord(word) || typeof word.text !== "string" ||
            typeof word.start !== "number" || typeof word.end !== "number" ||
            !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
            word.start < 0 || word.end <= word.start) {
          throw new Error("transcript word is malformed");
        }
      }
    }
    return segment as unknown as TranscriptionResult["segments"][number];
  });
  return { text: value.text, segments };
}

function normalizedConfig(overrides: Partial<AnalyzeConfig>): AnalyzeConfig {
  // Evaluation always nominates in shadow semantics, regardless of the
  // deployment's ANALYZE_VISUAL_RECALL_V1 setting. Tuning values still come
  // from the closed production config and cannot be set per manifest case.
  return {
    ...loadAnalyzeConfig(),
    ...overrides,
    visualRecallMode: "shadow",
  };
}

function reportCase(
  item: EvalCaseResult,
  nominations: Array<{ start: number; end: number; peakSec: number; peakValue: number }>,
  ordinal: number,
): EvalCaseReport {
  const positiveMatched = matchedCount(item.positiveWindows, item.nominatedWindows);
  const negativeMatched = matchedCount(item.negativeWindows, item.nominatedWindows);
  return {
    caseKey: `case-${ordinal}`,
    kind: item.kind,
    candidateCount: item.candidateCount,
    positive: {
      total: item.positiveWindows.length,
      matched: positiveMatched,
      recall: ratio(positiveMatched, item.positiveWindows.length),
    },
    negative: {
      total: item.negativeWindows.length,
      matched: negativeMatched,
      hitRate: item.negativeWindows.length > 0 ? ratio(negativeMatched, item.negativeWindows.length) : null,
      available: item.negativeWindows.length > 0,
    },
    nominations,
  };
}

function errorResult(io: VisualRecallEvalIo, message: string): VisualRecallCliResult {
  const stderr = `${message}\n`;
  io.stderr?.(stderr);
  return { exitCode: 1, stdout: "", stderr };
}

export const VISUAL_RECALL_HELP = `Usage: eval-visual-recall.ts <private-manifest.json>

Manifest JSON (version 1):
  {"version":1,"invarianceEvidencePath":"/private/invariance.json","cases":[
    {"caseKey":"gaming-a","kind":"gaming","sourcePath":"/private/a.mp4",
     "transcriptPath":"/private/a.json","positiveWindows":[{"start":10,"end":20}],
     "negativeWindows":[]}
  ]}

caseKey is an anonymous input label and is never printed. Paths and transcript text stay private.
invarianceEvidencePath points to separate local JSON evidence from the off/shadow replay gate.
The command computes local video envelopes and exits 1 when any release gate fails.
Negative controls are reported as negativeWindowHitRate (higher is worse); with
no negative windows, the rate is null and negativeControlsAvailable is false.
`;

function nominationWindows(
  transcription: TranscriptionResult,
  cfg: AnalyzeConfig,
  motionEnvelope: unknown,
): { nominatedWindows: EvalWindow[]; nominations: EvalCaseReport["nominations"]; candidateCount: number } {
  const nodes = buildSentenceGraph(transcription.segments, cfg);
  const visual = nominateVisualCandidates(nodes, motionEnvelope, cfg);
  const nominations = visual.nominations.map((nomination) => {
    const start = nodes[nomination.startNode]?.start;
    const end = nodes[nomination.endNode]?.end;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return {
      start,
      end,
      peakSec: nomination.peakSec,
      peakValue: nomination.peakValue,
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null);
  return {
    nominatedWindows: nominations.map(({ start, end }) => ({ start, end })),
    nominations,
    candidateCount: visual.candidates.length,
  };
}

/** Testable CLI runner. It does not call OpenAI, Prisma, or any production pipeline. */
export async function runVisualRecallCli(
  argv: string[] = process.argv,
  io: VisualRecallEvalIo = defaultIo(),
  deps: CliDependencies = {},
): Promise<VisualRecallCliResult> {
  if (argv.length === 3 && argv[2] === "--help") {
    io.stdout?.(VISUAL_RECALL_HELP);
    return { exitCode: 0, stdout: VISUAL_RECALL_HELP, stderr: "" };
  }
  if (argv.length !== 3 || argv[2].startsWith("-")) return errorResult(io, "usage");
  const manifestPath = argv[2];
  try {
    parsePath(manifestPath, "manifestPath");
  } catch {
    return errorResult(io, "manifest_invalid");
  }
  let manifestRaw: string | Buffer;
  try {
    const handle = await openBoundedFile(io, manifestPath, MAX_MANIFEST_BYTES);
    try {
      manifestRaw = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (textBytes(manifestRaw) > MAX_MANIFEST_BYTES) return errorResult(io, "manifest_invalid");
  } catch {
    return errorResult(io, "manifest_unreadable");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(typeof manifestRaw === "string" ? manifestRaw : manifestRaw.toString("utf8"));
  } catch {
    return errorResult(io, "manifest_invalid");
  }
  let manifest: EvalManifest;
  try {
    manifest = parseEvalManifest(manifestValue);
  } catch {
    return errorResult(io, "manifest_invalid");
  }

  let invarianceRaw: string | Buffer;
  try {
    const handle = await openBoundedFile(io, manifest.invarianceEvidencePath, MAX_MANIFEST_BYTES);
    try {
      invarianceRaw = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (textBytes(invarianceRaw) > MAX_MANIFEST_BYTES) return errorResult(io, "manifest_invalid");
  } catch {
    return errorResult(io, "invariance_unreadable");
  }
  let invariance: InvarianceEvidence;
  try {
    invariance = parseInvarianceEvidence(JSON.parse(
      typeof invarianceRaw === "string" ? invarianceRaw : invarianceRaw.toString("utf8"),
    ));
  } catch {
    return errorResult(io, "invariance_invalid");
  }

  let currentCommit: string;
  let worktreeDirty: boolean;
  try {
    currentCommit = await (deps.resolveCurrentCommit ?? defaultCurrentCommit)();
    worktreeDirty = await (deps.resolveWorktreeDirty ?? defaultWorktreeDirty)();
  } catch {
    return errorResult(io, "invariance_unavailable");
  }
  const invariancePassed = invarianceGate(invariance, currentCommit, worktreeDirty);

  const cfg = normalizedConfig(deps.loadConfig?.() ?? {});
  const candidateCap = cfg.visualRecallMaxCandidates;
  const caseResults: EvalCaseResult[] = [];
  const caseReports: EvalCaseReport[] = [];
  try {
    for (const item of manifest.cases) {
      const sourceHandle = await openBoundedFile(io, item.sourcePath, MAX_SOURCE_BYTES);
      try {
        const transcriptHandle = await openBoundedFile(io, item.transcriptPath, MAX_TRANSCRIPT_BYTES);
        try {
          const rawTranscript = await transcriptHandle.readFile();
          if (textBytes(rawTranscript) > MAX_TRANSCRIPT_BYTES) throw new Error("transcript too large");
          const transcription = parseTranscription(JSON.parse(
            typeof rawTranscript === "string" ? rawTranscript : rawTranscript.toString("utf8"),
          ));
          const envelope = deps.videoEnvelopesFromFd
            ? await deps.videoEnvelopesFromFd(sourceHandle.fd)
            : deps.videoEnvelopes
              ? await deps.videoEnvelopes(item.sourcePath)
              : await defaultVideoEnvelopesFromFd(sourceHandle.fd);
          const nominated = nominationWindows(transcription, cfg, envelope.motionEnvelope);
          const evaluated: EvalCaseResult = {
            caseKey: item.caseKey,
            kind: item.kind,
            positiveWindows: item.positiveWindows,
            negativeWindows: item.negativeWindows,
            nominatedWindows: nominated.nominatedWindows,
            candidateCount: nominated.candidateCount,
          };
          caseResults.push(evaluated);
          caseReports.push(reportCase(evaluated, nominated.nominations, caseReports.length + 1));
        } finally {
          await transcriptHandle.close();
        }
      } finally {
        await sourceHandle.close();
      }
    }
  } catch {
    return errorResult(io, "case_invalid");
  }
  const summary = summarizeCases(caseResults, {
    candidateCap,
    offShadowInvariant: invariancePassed,
  });
  const report: EvalReport = {
    schemaVersion: 1,
    candidateCap,
    offShadowInvariant: {
      required: true,
      passed: invariancePassed,
      separatelyVerified: true,
    },
    cases: caseReports,
    summary,
    pass: summary.pass,
  };
  const stdout = `${JSON.stringify(report)}\n`;
  io.stdout?.(stdout);
  return { exitCode: report.pass ? 0 : 1, stdout, stderr: "" };
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const result = await runVisualRecallCli(argv);
  process.exitCode = result.exitCode;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  void main().catch(() => {
    process.exitCode = 1;
    process.stderr.write("case_invalid\n");
  });
}
