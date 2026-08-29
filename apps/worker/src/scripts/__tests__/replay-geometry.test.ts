import { afterEach, describe, expect, it, vi } from "vitest";

type Job = {
  normalizedArtifactKey: string | null;
  sourceArtifactKey: string | null;
};

function loadReplay() {
  return import("../replay-geometry");
}

function makeDependencies(job: Job | null = {
  normalizedArtifactKey: "work/job-1/normalized.mp4",
  sourceArtifactKey: "work/job-1/source.mp4",
}) {
  return {
    prisma: {
      job: { findUnique: vi.fn(async () => job) },
      $disconnect: vi.fn(async () => undefined),
    },
    downloadVideo: vi.fn(async () => "/tmp/downloaded-source.mp4"),
    probeDuration: vi.fn(async () => 60),
    trimClipFile: vi.fn(async () => "/tmp/replay-trim.mp4"),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  };
}

const validArgs = [
  "--job-id", "job-1",
  "--start-ms", "1234",
  "--end-ms", "5678",
  "--output", "/tmp/exact-replay.mp4",
];

async function run(args: readonly string[], dependencies = makeDependencies()) {
  const { runReplay } = await loadReplay();
  return { result: await runReplay(args, dependencies), dependencies };
}

afterEach(() => vi.restoreAllMocks());

describe("exact-geometry replay", () => {
  it("trims the requested millisecond range and atomically renames the exact clip", async () => {
    const dependencies = makeDependencies();
    const { result } = await run(validArgs, dependencies);

    expect(result).toBe("/tmp/exact-replay.mp4");
    expect(dependencies.prisma.job.findUnique).toHaveBeenCalledWith({
      where: { id: "job-1" },
      select: { normalizedArtifactKey: true, sourceArtifactKey: true },
    });
    expect(dependencies.downloadVideo).toHaveBeenCalledWith(undefined, "work/job-1/normalized.mp4");
    expect(dependencies.probeDuration).toHaveBeenCalledWith("/tmp/downloaded-source.mp4");
    expect(dependencies.trimClipFile).toHaveBeenCalledWith("/tmp/downloaded-source.mp4", 1.234, 5.678);
    expect(dependencies.rename).toHaveBeenCalledWith("/tmp/replay-trim.mp4", "/tmp/exact-replay.mp4");
    expect(dependencies.unlink).toHaveBeenCalledWith("/tmp/downloaded-source.mp4");
    expect(dependencies.unlink).not.toHaveBeenCalledWith("/tmp/replay-trim.mp4");
    expect(dependencies.prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("uses sourceArtifactKey only when normalizedArtifactKey is absent", async () => {
    const dependencies = makeDependencies({
      normalizedArtifactKey: null,
      sourceArtifactKey: "work/job-1/original.mp4",
    });
    await run(validArgs, dependencies);
    expect(dependencies.downloadVideo).toHaveBeenCalledWith(undefined, "work/job-1/original.mp4");
  });

  it.each([
    ["unknown flag", [...validArgs, "--other", "x"]],
    ["positional extra", [...validArgs, "extra"]],
    ["duplicate option", [...validArgs, "--job-id", "job-2"]],
    ["missing option value", validArgs.slice(0, -1)],
    ["empty job", ["--job-id", "", "--start-ms", "0", "--end-ms", "1", "--output", "/tmp/x.mp4"]],
    ["too-long job", ["--job-id", "a".repeat(256), "--start-ms", "0", "--end-ms", "1", "--output", "/tmp/x.mp4"]],
    ["negative start", ["--job-id", "job-1", "--start-ms", "-1", "--end-ms", "1", "--output", "/tmp/x.mp4"]],
    ["noninteger end", ["--job-id", "job-1", "--start-ms", "0", "--end-ms", "1.5", "--output", "/tmp/x.mp4"]],
    ["unsafe start", ["--job-id", "job-1", "--start-ms", "9007199254740992", "--end-ms", "9007199254740993", "--output", "/tmp/x.mp4"]],
    ["reversed range", ["--job-id", "job-1", "--start-ms", "2", "--end-ms", "1", "--output", "/tmp/x.mp4"]],
    ["empty range", ["--job-id", "job-1", "--start-ms", "1", "--end-ms", "1", "--output", "/tmp/x.mp4"]],
    ["relative output", ["--job-id", "job-1", "--start-ms", "0", "--end-ms", "1", "--output", "replay.mp4"]],
    ["outside tmp output", ["--job-id", "job-1", "--start-ms", "0", "--end-ms", "1", "--output", "/var/tmp/replay.mp4"]],
    ["nested tmp output", ["--job-id", "job-1", "--start-ms", "0", "--end-ms", "1", "--output", "/tmp/attacker-link/replay.mp4"]],
  ])("rejects %s before reading or downloading", async (_name, args) => {
    const dependencies = makeDependencies();
    await expect(run(args, dependencies)).rejects.toThrow("Invalid replay arguments");
    expect(dependencies.prisma.job.findUnique).not.toHaveBeenCalled();
    expect(dependencies.downloadVideo).not.toHaveBeenCalled();
    expect(dependencies.prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("does not trim when the job is missing", async () => {
    const dependencies = makeDependencies(null);
    await expect(run(validArgs, dependencies)).rejects.toThrow("Job job-1 was not found");
    expect(dependencies.downloadVideo).not.toHaveBeenCalled();
    expect(dependencies.trimClipFile).not.toHaveBeenCalled();
    expect(dependencies.prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("explains when source retention leaves no replayable artifact", async () => {
    const dependencies = makeDependencies({ normalizedArtifactKey: null, sourceArtifactKey: null });
    await expect(run(validArgs, dependencies)).rejects.toThrow(
      "Source artifact for job job-1 is no longer retained; exact geometry replay requires a retained source artifact"
    );
    expect(dependencies.downloadVideo).not.toHaveBeenCalled();
    expect(dependencies.trimClipFile).not.toHaveBeenCalled();
  });

  it.each([
    ["download", (d: ReturnType<typeof makeDependencies>) => d.downloadVideo.mockRejectedValueOnce(new Error("download failed"))],
    ["probe", (d: ReturnType<typeof makeDependencies>) => d.probeDuration.mockRejectedValueOnce(new Error("probe failed"))],
    ["invalid duration", (d: ReturnType<typeof makeDependencies>) => d.probeDuration.mockResolvedValueOnce(Number.NaN)],
    ["out-of-bounds duration", (d: ReturnType<typeof makeDependencies>) => d.probeDuration.mockResolvedValueOnce(5)],
  ])("does not trim after %s failure", async (_name, configure) => {
    const dependencies = makeDependencies();
    configure(dependencies);
    await expect(run(validArgs, dependencies)).rejects.toThrow();
    expect(dependencies.trimClipFile).not.toHaveBeenCalled();
    expect(dependencies.prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("cleans the downloaded source after a probe failure", async () => {
    const dependencies = makeDependencies();
    dependencies.probeDuration.mockRejectedValueOnce(new Error("probe failed"));
    await expect(run(validArgs, dependencies)).rejects.toThrow("probe failed");
    expect(dependencies.unlink).toHaveBeenCalledWith("/tmp/downloaded-source.mp4");
  });

  it("cleans both temporary files if publishing the trimmed output fails", async () => {
    const dependencies = makeDependencies();
    dependencies.rename.mockRejectedValueOnce(new Error("rename failed"));
    await expect(run(validArgs, dependencies)).rejects.toThrow("rename failed");
    expect(dependencies.unlink).toHaveBeenCalledWith("/tmp/replay-trim.mp4");
    expect(dependencies.unlink).toHaveBeenCalledWith("/tmp/downloaded-source.mp4");
    expect(dependencies.prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("does not let cleanup failure hide the original replay failure", async () => {
    const dependencies = makeDependencies();
    dependencies.probeDuration.mockRejectedValueOnce(new Error("probe failed"));
    dependencies.unlink.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(run(validArgs, dependencies)).rejects.toThrow("probe failed");
    expect(dependencies.prisma.$disconnect).toHaveBeenCalledOnce();
  });
});
