import OpenAI from "openai";
import { prisma } from "@clipclap/shared/lib/prisma";
import { downloadFile, getObjectSize } from "@clipclap/shared/lib/r2";

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { readOutcomeObservationConfig } from "./outcome-observe";
import { createPrismaOutcomePromotionRepository } from "../feedback-quality/outcome-promote";
import { captureOutcomeDecisionAssist, parseOutcomeCaptureReview, readOutcomeCaptureFile } from "../feedback-quality/outcome-capture";
import { materializeOutcomeLiveLane } from "../feedback-quality/outcome-observe";
import { promoteOutcomeCase } from "../feedback-quality/outcome-promote";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { Sha256 } from "../feedback-learning/types";
import { writeOutcomePrivateFile } from "../feedback-quality/outcome-capture";

export type OutcomeCaptureIo = Readonly<{ stdout(line: string): void; stderr(line: string): void }>;
const processIo: OutcomeCaptureIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) };

export async function readOutcomeCaptureReviewFile(path: string): Promise<ReturnType<typeof parseOutcomeCaptureReview>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== 0o600 || initial.size <= 0 || initial.size > 64 * 1024) throw new Error();
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) { const item = await handle.read(bytes, offset, bytes.length - offset, null); if (!item.bytesRead) break; offset += item.bytesRead; }
    const final = await handle.stat();
    if (offset !== bytes.length || final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size || final.nlink !== 1 || (final.mode & 0o7777) !== 0o600) throw new Error();
    return parseOutcomeCaptureReview(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
  } catch { throw new Error("private_review_invalid"); }
  finally { await handle?.close().catch(() => undefined); }
}

export type OutcomeCaptureArguments = Readonly<{ jobId: string; analyzeStepId: string; configFile: string; outputDir: string; attempts: 1 | 3; liveLaneName?: string; reviewFile?: string; root?: string }>;
function parse(argv: readonly string[]): Arguments {
  if (argv.length < 8 || argv.length > 16 || argv.length % 2 !== 0) throw new Error("invalid_arguments");
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--job-id", "--analyze-step-id", "--config-file", "--output-dir", "--attempts", "--live-lane-name", "--review-file", "--root"].includes(key) || !value || value.startsWith("--") || value.includes("\0")) throw new Error("invalid_arguments");
    if (values[key]) throw new Error("invalid_arguments");
    values[key] = value;
  }
  if (!values["--job-id"] || !values["--analyze-step-id"] || !values["--config-file"] || !values["--output-dir"] || (values["--attempts"] !== undefined && values["--attempts"] !== "1" && values["--attempts"] !== "3") || (values["--attempts"] === "3" && !values["--live-lane-name"]) || (values["--attempts"] !== "3" && values["--live-lane-name"]) || (values["--review-file"] && !values["--root"])) throw new Error("invalid_arguments");
  return Object.freeze({ jobId: values["--job-id"], analyzeStepId: values["--analyze-step-id"], configFile: values["--config-file"], outputDir: values["--output-dir"], attempts: (values["--attempts"] === "3" ? 3 : 1) as 1 | 3, ...(values["--live-lane-name"] ? { liveLaneName: values["--live-lane-name"] } : {}), ...(values["--review-file"] ? { reviewFile: values["--review-file"] } : {}), ...(values["--root"] ? { root: values["--root"] } : {}) });
}

function line(value: Readonly<Record<string, unknown>>): string {
  const allowed = ["operation", "status", "responseCount", "reason"];
  return JSON.stringify(Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]])));
}

type Arguments = OutcomeCaptureArguments;
type Dependencies = Readonly<{
  capture(input: OutcomeCaptureArguments): Promise<{ responseCount: number; promoted: boolean }>;
  io?: OutcomeCaptureIo;
}>;

export type OutcomeCaptureExecutionDependencies = Readonly<{
  repository: { capture(identity: { jobId: string; analyzeStepId: string }): Promise<Parameters<typeof captureOutcomeDecisionAssist>[0]["snapshot"]> };
  loadConfig(path: string): Promise<Parameters<typeof captureOutcomeDecisionAssist>[0]["config"]>;
  loadReview(path: string): Promise<NonNullable<Parameters<typeof captureOutcomeDecisionAssist>[0]["review"]>>;
  realClient: OpenAI;
  sourceReader: NonNullable<Parameters<typeof captureOutcomeDecisionAssist>[0]["sourceReader"]>;
  capture?: (input: Parameters<typeof captureOutcomeDecisionAssist>[0]) => Promise<Awaited<ReturnType<typeof captureOutcomeDecisionAssist>>>;
}>;

export type OutcomeCaptureExecutionResult = Readonly<{ responseCount: number; promoted: boolean; captureId: Sha256; capturePath: string; caseVersion?: Sha256; liveLanePath?: string }>;

export async function executeOutcomeCapture(args: OutcomeCaptureArguments, dependencies: OutcomeCaptureExecutionDependencies): Promise<OutcomeCaptureExecutionResult> {
  if (args.reviewFile && !args.root) throw new Error("invalid_arguments");
  const snapshot = await dependencies.repository.capture({ jobId: args.jobId, analyzeStepId: args.analyzeStepId });
  const config = await dependencies.loadConfig(args.configFile);
  const review = args.reviewFile ? await dependencies.loadReview(args.reviewFile) : undefined;
  const capture = dependencies.capture ?? captureOutcomeDecisionAssist;
  const result = await capture({ snapshot, config, outputDir: args.outputDir, attempts: args.attempts, ...(args.liveLaneName ? { liveLaneName: args.liveLaneName } : {}), ...(review ? { review } : {}), realClient: dependencies.realClient, sourceReader: dependencies.sourceReader });
  if (!review) return { responseCount: result.responseCount, promoted: false, captureId: result.captureId, capturePath: result.path };
  const captured = await readOutcomeCaptureFile(result.path, result.captureId);
  const decision = {
    schemaVersion: 1 as const, eventId: review.eventId, reviewedAt: review.reviewedAt, jobId: captured.jobId, jobUpdatedAt: captured.jobUpdatedAt,
    analyzeStepId: captured.analyzeStepId, analyzeStepSha256: captured.analyzeStepSha256, analysisVersion: captured.analysisVersion,
    engineFingerprint: captured.engineFingerprint, configSha256: captured.configSha256, transcriptSha256: captured.transcriptSha256,
    sourceSha256: captured.sourceSha256, recordedResponsesSha256: captured.recordedResponsesSha256, sourceReview: review.sourceReview,
    destination: review.destination, disposition: review.disposition, confidence: review.confidence, subsystem: review.subsystem,
    expected: review.expected, recordedResponses: captured.recordedResponses,
  };
  const decisionId = sha256(canonicalJson(decision));
  const decisionDir = join(args.root!, "outcomes", "decisions");
  await writeOutcomePrivateFile(decisionDir, `${decisionId}.json`, decision);
  const promoted = await promoteOutcomeCase(decision, { repository: dependencies.repository, root: join(args.root!, "outcomes"), getObjectSize: dependencies.sourceReader.getObjectSize, downloadFile: (key) => dependencies.sourceReader.downloadFile(key), });
  if (args.attempts !== 3) return { responseCount: result.responseCount, promoted: true, captureId: result.captureId, capturePath: result.path, caseVersion: promoted.caseVersion };
  const lane = materializeOutcomeLiveLane(captured.liveLaneDraft, promoted.caseVersion);
  const laneId = sha256(canonicalJson(lane));
  const liveLanePath = await writeOutcomePrivateFile(join(args.root!, "outcomes", "live-lanes"), `${laneId}.json`, lane);
  return { responseCount: result.responseCount, promoted: true, captureId: result.captureId, capturePath: result.path, caseVersion: promoted.caseVersion, liveLanePath };
}

export async function runOutcomeCapture(argv: readonly string[], dependencies: Dependencies): Promise<number> {
  const io = dependencies.io ?? processIo;
  let args: Arguments;
  try { args = parse(argv); }
  catch { io.stderr(line({ operation: "outcome-capture", reason: "invalid_arguments" })); return 2; }
  try {
    const result = await dependencies.capture(args);
    io.stdout(line({ operation: "outcome-capture", status: result.promoted ? "promoted" : "committed", responseCount: result.responseCount }));
    return 0;
  } catch (error) {
    const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "capture_failed";
    io.stderr(line({ operation: "outcome-capture", reason }));
    return 1;
  }
}

async function main(): Promise<void> {
  const repository = createPrismaOutcomePromotionRepository(prisma);
  process.exitCode = await runOutcomeCapture(process.argv.slice(2), {
    capture: async (args) => executeOutcomeCapture(args, {
      repository,
      loadConfig: readOutcomeObservationConfig,
      loadReview: readOutcomeCaptureReviewFile,
      realClient: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
      sourceReader: { getObjectSize, downloadFile: (key) => downloadFile(key) },
    }),
  });
  await prisma.$disconnect();
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
