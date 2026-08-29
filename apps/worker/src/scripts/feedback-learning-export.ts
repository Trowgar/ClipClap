import {
  captureExportCommandResult,
  isCliInputError,
  machineReason,
  parseExportArguments,
  processCommandIo,
  safeLog,
  type CommandIo,
} from "../feedback-learning/cli";
import { exportFeedbackLearning, type ExportDependencies, type SafeExportResult } from "../feedback-learning/export";
import type { FeedbackLearningRepository } from "../feedback-learning/repository";

export type ExportCommandDependencies = Readonly<{
  repository: FeedbackLearningRepository;
  execute(input: ReturnType<typeof parseExportArguments>, dependencies: ExportDependencies): Promise<SafeExportResult>;
  disconnect(): Promise<void>;
}>;

type Outcome = Readonly<{ code: 0 | 1 | 2; stream: "stdout" | "stderr"; line: string }>;

export async function runFeedbackLearningExport(
  argv: readonly string[],
  dependencies: ExportCommandDependencies,
  io: CommandIo = processCommandIo,
): Promise<number> {
  let outcome: Outcome;
  try {
    const input = parseExportArguments(argv);
    const result = captureExportCommandResult(await dependencies.execute(input, { repository: dependencies.repository }));
    if (result.status === "committed" || result.status === "noop") {
      outcome = { code: 0, stream: "stdout", line: safeLog({ operation: "export", runId: result.runId }) };
    } else if (result.status === "committed_durability_uncertain") {
      outcome = { code: 1, stream: "stderr", line: safeLog({ operation: "export", runId: result.runId, reason: "durability_uncertain" }) };
    } else if (result.status === "indeterminate") {
      outcome = { code: 1, stream: "stderr", line: safeLog({ operation: "export", runId: result.runId, reason: "commit_indeterminate" }) };
    } else {
      throw new Error("invalid_safe_result");
    }
  } catch (error) {
    const inputFailure = isCliInputError(error);
    outcome = {
      code: inputFailure ? 2 : 1,
      stream: "stderr",
      line: safeLog({ operation: "export", reason: inputFailure ? "invalid_arguments" : machineReason(error, "export_failed") }),
    };
  }
  try {
    await dependencies.disconnect();
  } catch {
    if (outcome.code === 0) {
      outcome = { code: 1, stream: "stderr", line: safeLog({ operation: "export", reason: "disconnect_failed" }) };
    }
  }
  io[outcome.stream](outcome.line);
  return outcome.code;
}

export async function composeExportCommandDependencies(): Promise<ExportCommandDependencies> {
  const [{ prisma }, { createPrismaFeedbackLearningRepository }] = await Promise.all([
    import("@clipclap/shared/lib/prisma"),
    import("../feedback-learning/repository"),
  ]);
  return {
    repository: createPrismaFeedbackLearningRepository(prisma),
    execute: exportFeedbackLearning,
    disconnect: () => prisma.$disconnect(),
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: CommandIo = processCommandIo,
  compose: () => Promise<ExportCommandDependencies> = composeExportCommandDependencies,
): Promise<number> {
  try {
    parseExportArguments(argv);
  } catch (error) {
    io.stderr(safeLog({ operation: "export", reason: isCliInputError(error) ? "invalid_arguments" : "export_failed" }));
    return isCliInputError(error) ? 2 : 1;
  }
  try {
    return await runFeedbackLearningExport(argv, await compose(), io);
  } catch {
    io.stderr(safeLog({ operation: "export", reason: "composition_failed" }));
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => { process.exitCode = code; });
}
