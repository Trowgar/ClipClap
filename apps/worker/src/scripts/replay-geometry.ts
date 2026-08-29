/**
 * Re-render one selected source interval without reframe, crop, subtitles, or
 * any job mutation. This is an operator-only diagnostic command.
 *
 * Usage:
 *   npx tsx src/scripts/replay-geometry.ts --job-id <id> --start-ms <ms> \
 *     --end-ms <ms> --output /tmp/replay.mp4
 */
import { execFile } from "child_process";
import { rename, unlink } from "fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { promisify } from "util";
import { prisma } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { trimClipFile } from "../processors/cut";
import { downloadVideo } from "../processors/download";

const execFileAsync = promisify(execFile);
const TMP_ROOT = "/tmp";
const MAX_JOB_ID_LENGTH = 255;
const OPTION_NAMES = new Set(["--job-id", "--start-ms", "--end-ms", "--output"]);

type ReplayJob = Readonly<{
  normalizedArtifactKey: string | null;
  sourceArtifactKey: string | null;
}>;

export type ReplayDependencies = Readonly<{
  prisma: Readonly<{
    job: Readonly<{
      findUnique(args: {
        where: { id: string };
        select: { normalizedArtifactKey: true; sourceArtifactKey: true };
      }): Promise<ReplayJob | null>;
    }>;
    $disconnect(): Promise<void>;
  }>;
  downloadVideo(sourceUrl: undefined, artifactKey: string): Promise<string>;
  probeDuration(path: string): Promise<number>;
  trimClipFile(path: string, startSeconds: number, endSeconds: number): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}>;

type ReplayArguments = Readonly<{
  jobId: string;
  startMs: number;
  endMs: number;
  output: string;
}>;

function invalidArguments(): never {
  throw new Error("Invalid replay arguments");
}

function parseMilliseconds(value: string | undefined): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) invalidArguments();
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) invalidArguments();
  return milliseconds;
}

function isTmpOutput(path: string): boolean {
  if (!isAbsolute(path) || path.includes("\0")) return false;
  const fromTmp = relative(TMP_ROOT, resolve(path));
  return (
    fromTmp.length > 0 &&
    fromTmp !== ".." &&
    !fromTmp.startsWith(`..${sep}`) &&
    !isAbsolute(fromTmp) &&
    // A nested directory in /tmp can be a user-controlled symlink. A direct
    // child is safe: rename replaces a destination symlink rather than
    // traversing it, while no symlinked parent can redirect the write.
    dirname(resolve(path)) === TMP_ROOT
  );
}

export function parseReplayArguments(argv: readonly string[]): ReplayArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!OPTION_NAMES.has(option) || value === undefined || values.has(option)) invalidArguments();
    values.set(option, value);
  }
  if (argv.length !== OPTION_NAMES.size * 2 || values.size !== OPTION_NAMES.size) invalidArguments();

  const jobId = values.get("--job-id");
  const output = values.get("--output");
  if (jobId === undefined || jobId.length === 0 || jobId.length > MAX_JOB_ID_LENGTH) invalidArguments();
  if (output === undefined || !isTmpOutput(output)) invalidArguments();

  const startMs = parseMilliseconds(values.get("--start-ms"));
  const endMs = parseMilliseconds(values.get("--end-ms"));
  if (startMs >= endMs) invalidArguments();
  return { jobId, startMs, endMs, output };
}

async function probeLocalDuration(path: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  return Number(stdout.trim());
}

async function ignoreUnlink(path: string | undefined, dependencies: ReplayDependencies): Promise<void> {
  if (path === undefined) return;
  await dependencies.unlink(path).catch(() => {});
}

/**
 * Makes an exact source-time clip. All dependencies are explicit so tests do
 * not need a database, R2, ffmpeg, or filesystem writes.
 */
export async function runReplay(
  argv: readonly string[],
  dependencies: ReplayDependencies = defaultReplayDependencies
): Promise<string> {
  let sourcePath: string | undefined;
  let temporaryClipPath: string | undefined;
  try {
    const input = parseReplayArguments(argv);
    const job = await dependencies.prisma.job.findUnique({
      where: { id: input.jobId },
      select: { normalizedArtifactKey: true, sourceArtifactKey: true },
    });
    if (job === null) throw new Error(`Job ${input.jobId} was not found`);

    const artifactKey = job.normalizedArtifactKey ?? job.sourceArtifactKey;
    if (artifactKey === null) {
      throw new Error(
        `Source artifact for job ${input.jobId} is no longer retained; ` +
          "exact geometry replay requires a retained source artifact"
      );
    }

    sourcePath = await dependencies.downloadVideo(undefined, artifactKey);
    const durationSeconds = await dependencies.probeDuration(sourcePath);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("Downloaded source duration could not be determined");
    }
    if (input.endMs > durationSeconds * 1000) {
      throw new Error("Requested replay range is outside the downloaded source duration");
    }

    temporaryClipPath = await dependencies.trimClipFile(
      sourcePath,
      input.startMs / 1000,
      input.endMs / 1000
    );
    await dependencies.rename(temporaryClipPath, input.output);
    temporaryClipPath = undefined;
    return input.output;
  } finally {
    await ignoreUnlink(temporaryClipPath, dependencies);
    await ignoreUnlink(sourcePath, dependencies);
    await dependencies.prisma.$disconnect();
  }
}

const defaultReplayDependencies: ReplayDependencies = {
  prisma,
  downloadVideo,
  probeDuration: probeLocalDuration,
  trimClipFile,
  rename,
  unlink,
};

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const output = await runReplay(argv);
  console.log(`Exact geometry replay written to ${output}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
