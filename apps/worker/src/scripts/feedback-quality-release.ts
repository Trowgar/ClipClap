import { createProductionDeployDependencies, parseImageReference } from "../feedback-quality/release";
import { DEFAULT_QUALITY_ROOT } from "../feedback-quality/store";
import { runFeedbackQualityDeploy, type DeployCommandIo } from "./feedback-quality-deploy";

type ReleaseArgs = Readonly<{ image: string; deploy: string[] }>;

function parse(argv: readonly string[]): ReleaseArgs {
  let image: string | undefined;
  const deploy: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--image") {
      if (image !== undefined || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("invalid_flag");
      image = argv[++index];
      parseImageReference(image);
    } else deploy.push(argv[index]);
  }
  if (!image) throw new Error("missing_image");
  return { image, deploy };
}

export async function runFeedbackQualityRelease(argv: readonly string[], io: DeployCommandIo = { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) }): Promise<number> {
  try {
    const args = parse(argv);
    const root = process.env.FEEDBACK_QUALITY_ROOT ?? DEFAULT_QUALITY_ROOT;
    const adapter = createProductionDeployDependencies(args.image, undefined, root);
    return runFeedbackQualityDeploy(args.deploy, {
      ...adapter,
      root,
      io,
      configFile: process.env.FEEDBACK_QUALITY_CONFIG_HOST,
      configFileContainer: "/run/clipclap/feedback-quality-config.json",
    });
  } catch {
    io.stderr(JSON.stringify({ operation: "release", status: "failed", reasons: ["invalid_request"] }));
    return 2;
  }
}

if (require.main === module) runFeedbackQualityRelease(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
