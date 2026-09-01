import { createProductionDeployDependencies, parseImageReference } from "../feedback-quality/release";
import { DEFAULT_QUALITY_ROOT } from "../feedback-quality/store";
import { runFeedbackQualityDeploy, type DeployCommandIo } from "./feedback-quality-deploy";

type ReleaseArgs = Readonly<{ image: string; project: string; deploy: string[] }>;

function parse(argv: readonly string[]): ReleaseArgs {
  let image: string | undefined;
  let project: string | undefined;
  const deploy: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--image") {
      if (image !== undefined || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("invalid_flag");
      image = argv[++index];
      parseImageReference(image);
    } else if (argv[index] === "--project") {
      if (project !== undefined || !argv[index + 1] || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(argv[index + 1])) throw new Error("invalid_flag");
      project = argv[++index];
    } else deploy.push(argv[index]);
  }
  if (!image || !project) throw new Error("missing_required");
  return { image, project, deploy };
}

export async function runFeedbackQualityRelease(argv: readonly string[], io: DeployCommandIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) }): Promise<number> {
  try {
    const args = parse(argv);
    const root = process.env.FEEDBACK_QUALITY_ROOT ?? DEFAULT_QUALITY_ROOT;
    const adapter = createProductionDeployDependencies(args.image, args.project, undefined, root);
    return runFeedbackQualityDeploy(args.deploy, {
      ...adapter,
      root,
      io,
      configFileContainer: "/run/clipclap/feedback-quality-config.json",
    });
  } catch {
    io.stderr(JSON.stringify({ operation: "release", status: "failed", reasons: ["invalid_request"] }));
    return 2;
  }
}

if (require.main === module) runFeedbackQualityRelease(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
