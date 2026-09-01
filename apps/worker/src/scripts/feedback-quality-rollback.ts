import { createProductionRollbackDependencies, executeRollback, type ProductionReleaseDependencies } from "../feedback-quality/release";
import { DEFAULT_QUALITY_ROOT } from "../feedback-quality/store";

const ID = /^rollback:sha256:[0-9a-f]{64}$/;

export async function runFeedbackQualityRollback(argv: readonly string[], dependencies?: Pick<ProductionReleaseDependencies, "exec" | "inspectImage" | "inspectService">): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--rollback" || !ID.test(argv[1])) { process.stderr.write(JSON.stringify({ operation: "rollback", status: "failed", reasons: ["invalid_request"] }) + "\n"); return 2; }
  try {
    const root = process.env.FEEDBACK_QUALITY_ROOT ?? DEFAULT_QUALITY_ROOT;
    await executeRollback(argv[1], root, dependencies ?? createProductionRollbackDependencies(undefined, root));
    process.stdout.write(JSON.stringify({ operation: "rollback", rollbackArtifactId: argv[1], status: "rolled_back" }) + "\n");
    return 0;
  } catch {
    process.stderr.write(JSON.stringify({ operation: "rollback", rollbackArtifactId: argv[1], status: "failed", reasons: ["rollback_failed"] }) + "\n");
    return 1;
  }
}

if (require.main === module) runFeedbackQualityRollback(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
