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

export async function runFeedbackLearningReview(
  argv: readonly string[],
  dependencies: ReviewCommandDependencies,
  io: CommandIo = processCommandIo,
): Promise<number> {
  let outcome: Outcome;
  try {
    const request = await requestFromArguments(argv);
    const result = captureReviewCommandResult(await dependencies.execute(request, { repository: dependencies.repository }));
    if (result.status === "committed" || result.status === "noop") {
      outcome = { code: 0, stream: "stdout", line: safeLog({ operation: "review", eventId: result.eventId }) };
    } else if (result.status === "committed_durability_uncertain") {
      outcome = { code: 1, stream: "stderr", line: safeLog({ operation: "review", eventId: result.eventId, reason: "durability_uncertain" }) };
    } else if (result.status === "indeterminate") {
      outcome = { code: 1, stream: "stderr", line: safeLog({ operation: "review", eventId: result.eventId, reason: "commit_indeterminate" }) };
    } else {
      throw new Error("invalid_safe_result");
    }
  } catch (error) {
    const inputFailure = isCliInputError(error);
    outcome = {
      code: inputFailure ? 2 : 1,
      stream: "stderr",
      line: safeLog({ operation: "review", reason: inputFailure ? "invalid_arguments" : machineReason(error, "review_failed") }),
    };
  }
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
  try {
    parseReviewArguments(argv);
  } catch (error) {
    io.stderr(safeLog({ operation: "review", reason: isCliInputError(error) ? "invalid_arguments" : "review_failed" }));
    return isCliInputError(error) ? 2 : 1;
  }
  try {
    return await runFeedbackLearningReview(argv, await compose(), io);
  } catch {
    io.stderr(safeLog({ operation: "review", reason: "composition_failed" }));
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => { process.exitCode = code; });
}
