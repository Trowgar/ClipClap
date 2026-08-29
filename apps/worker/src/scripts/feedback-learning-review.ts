import {
  captureReviewCommandResult,
  isCliInputError,
  machineReason,
  parseReviewArguments,
  processCommandIo,
  readPrivateReasonFile,
  safeLog,
  type CommandIo,
} from "../feedback-learning/cli";
import type { FeedbackLearningRepository } from "../feedback-learning/repository";
import { reviewFeedback, type ReviewDependencies, type ReviewRequest, type SafeReviewResult } from "../feedback-learning/review";

export type ReviewCommandDependencies = Readonly<{
  repository: FeedbackLearningRepository;
  execute(input: ReviewRequest, dependencies: ReviewDependencies): Promise<SafeReviewResult>;
  disconnect(): Promise<void>;
}>;

type Outcome = Readonly<{ code: 0 | 1 | 2; stream: "stdout" | "stderr"; line: string }>;

async function requestFromArguments(argv: readonly string[]): Promise<ReviewRequest> {
  const parsed = parseReviewArguments(argv);
  if (parsed.action === "approve") return parsed;
  const reason = await readPrivateReasonFile(parsed.reasonFile);
  return parsed.action === "reject"
    ? { action: "reject", runId: parsed.runId, candidateVersion: parsed.candidateVersion, reason }
    : { action: "correct", targetEventId: parsed.targetEventId, operation: "retire", reason };
}

function failureOutcome(error: unknown): Outcome {
  const inputFailure = isCliInputError(error);
  return {
    code: inputFailure ? 2 : 1,
    stream: "stderr",
    line: safeLog({ operation: "review", reason: inputFailure ? "invalid_arguments" : machineReason(error, "review_failed") }),
  };
}

async function outcomeForRequest(request: ReviewRequest, dependencies: ReviewCommandDependencies): Promise<Outcome> {
  try {
    const result = captureReviewCommandResult(await dependencies.execute(request, { repository: dependencies.repository }));
    if (result.status === "committed" || result.status === "noop") {
      return { code: 0, stream: "stdout", line: safeLog({ operation: "review", eventId: result.eventId }) };
    }
    if (result.status === "committed_durability_uncertain") {
      return { code: 1, stream: "stderr", line: safeLog({ operation: "review", eventId: result.eventId, reason: "durability_uncertain" }) };
    }
    return { code: 1, stream: "stderr", line: safeLog({ operation: "review", eventId: result.eventId, reason: "commit_indeterminate" }) };
  } catch (error) {
    return failureOutcome(error);
  }
}

async function finishReviewOutcome(outcome: Outcome, dependencies: ReviewCommandDependencies, io: CommandIo): Promise<number> {
  try {
    await dependencies.disconnect();
  } catch {
    if (outcome.code === 0) {
      outcome = { code: 1, stream: "stderr", line: safeLog({ operation: "review", reason: "disconnect_failed" }) };
    }
  }
  io[outcome.stream](outcome.line);
  return outcome.code;
}

export async function runFeedbackLearningReview(
  argv: readonly string[],
  dependencies: ReviewCommandDependencies,
  io: CommandIo = processCommandIo,
): Promise<number> {
  let request: ReviewRequest;
  try {
    request = await requestFromArguments(argv);
  } catch (error) {
    return finishReviewOutcome(failureOutcome(error), dependencies, io);
  }
  return finishReviewOutcome(await outcomeForRequest(request, dependencies), dependencies, io);
}

export async function composeReviewCommandDependencies(): Promise<ReviewCommandDependencies> {
  const [{ prisma }, { createPrismaFeedbackLearningRepository }] = await Promise.all([
    import("@clipclap/shared/lib/prisma"),
    import("../feedback-learning/repository"),
  ]);
  return {
    repository: createPrismaFeedbackLearningRepository(prisma),
    execute: reviewFeedback,
    disconnect: () => prisma.$disconnect(),
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: CommandIo = processCommandIo,
  compose: () => Promise<ReviewCommandDependencies> = composeReviewCommandDependencies,
): Promise<number> {
  let request: ReviewRequest;
  try {
    request = await requestFromArguments(argv);
  } catch (error) {
    io.stderr(safeLog({ operation: "review", reason: isCliInputError(error) ? "invalid_arguments" : "review_failed" }));
    return isCliInputError(error) ? 2 : 1;
  }
  let dependencies: ReviewCommandDependencies;
  try {
    dependencies = await compose();
  } catch {
    io.stderr(safeLog({ operation: "review", reason: "composition_failed" }));
    return 1;
  }
  return finishReviewOutcome(await outcomeForRequest(request, dependencies), dependencies, io);
}

if (require.main === module) {
  void main().then((code) => { process.exitCode = code; });
}
