import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ download: vi.fn(), upload: vi.fn(), update: vi.fn(), updateMany: vi.fn(), find: vi.fn(), job: vi.fn() }));
vi.mock("@clipclap/shared", () => ({
  prisma: { clip: { update: mocks.update, updateMany: mocks.updateMany, findUnique: mocks.find }, job: { findUniqueOrThrow: mocks.job } },
  uploadFile: mocks.upload, computeClipExpiresAt: vi.fn(), getStageQueue: vi.fn(),
  jobStepService: { startJobStep: vi.fn(), completeJobStep: vi.fn(), failJobStep: vi.fn() },
}));
vi.mock("../processors/download", () => ({ downloadVideo: mocks.download }));
import { runRenderStage } from "../stages/render";

const exec = promisify(execFile);
let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe.skipIf(!hasFfmpeg)("source repair with real FFmpeg", () => {
  it.each([2, 5] as const)("adds +%is, captions the tail and preserves both frame edges", async extendEndSeconds => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    const dir = await mkdtemp(join(tmpdir(), "clipclap-repair-test-")); dirs.push(dir);
    const source = join(dir, "source.mp4");
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=320x180:r=25:d=12,drawbox=x=0:y=0:w=80:h=180:color=red:t=fill,drawbox=x=240:y=0:w=80:h=180:color=blue:t=fill", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
    const duration = 3 + extendEndSeconds;
    mocks.download.mockImplementation(async () => {
      const downloaded = join(dir, "downloaded.mp4");
      await copyFile(source, downloaded);
      return downloaded;
    });
    mocks.find.mockResolvedValue({ language: "en", job: { language: "en" } });
    mocks.job.mockResolvedValue({ language: "en", transcriptJson: { text: "Tail words", segments: [{ start: 4.2, end: 5.5, text: "Tail words", words: [{ start: 4.2, end: 4.8, text: "Tail" }, { start: 4.8, end: 5.5, text: "words" }] }] } });
    await expect(runRenderStage({ mode: "trim", jobId: "j", userId: "u", clipId: "new", originalClipStorageKey: "old", originalHasBurnedSubtitles: false,
      start: 0, end: 12, sourceArtifactKey: "source", sourceStart: 1, sourceEnd: 13, extendEndSeconds: 2, subtitles: false })).rejects.toThrow("exceeds");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "new", userId: "u", storageKey: "" } }));
    mocks.upload.mockImplementation(async (_key, path) => {
      const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", path]);
      const media = JSON.parse(stdout);
      expect(Number(media.format.duration)).toBeCloseTo(duration, 1);
      expect(media.streams.find((s: { codec_type: string }) => s.codec_type === "video")).toMatchObject({ width: 1080, height: 1920 });
      expect(Number(media.streams.find((s: { codec_type: string }) => s.codec_type === "audio").duration)).toBeGreaterThan(duration - 0.1);
      for (const [x, channel] of [[40, 0], [1030, 2]]) {
        const { stdout: rgb } = await exec("ffmpeg", ["-v", "error", "-ss", String(duration - 0.2), "-i", path, "-frames:v", "1", "-vf", `crop=2:2:${x}:960,format=rgb24`, "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
        expect(rgb[channel]).toBeGreaterThan(180);
        expect(rgb[channel === 0 ? 2 : 0]).toBeLessThan(60);
      }
      // The static source has no bright pixels here. The restored tail must
      // contain actual burned caption pixels, not only a database cue.
      const { stdout: caption } = await exec("ffmpeg", ["-v", "error", "-ss", "3.5", "-i", path, "-frames:v", "1", "-vf", "crop=800:350:140:1500,format=gray", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
      expect(caption.filter(value => value > 220).length).toBeGreaterThan(100);
    });
    await runRenderStage({ mode: "trim", jobId: "j", userId: "u", clipId: "new", originalClipStorageKey: "old", originalHasBurnedSubtitles: true,
      start: 0, end: duration, sourceArtifactKey: "source", sourceStart: 1, sourceEnd: 4 + extendEndSeconds, extendEndSeconds, framing: "safe-fit", subtitles: true,
      subtitleTrack: { cues: [{ id: "edited", start: 0.2, end: 1.2, text: "My edited caption" }] } });
    expect(mocks.upload).toHaveBeenCalledOnce();
    const data = mocks.update.mock.calls[0][0].data;
    expect(mocks.update.mock.calls[0][0].where).toEqual({ id: "new" });
    expect(data.subtitleTrack.cues).toEqual(expect.arrayContaining([expect.objectContaining({ text: "My edited caption" }), expect.objectContaining({ text: "Tail words", start: 3.2, end: 4.5 })]));
    expect(data.cropPlan.shots).toEqual([{ start: 0, end: duration, layout: "safe-fit", reason: "coverage" }]);
    expect(data.deletedAt).toBeNull(); // retry clears the failed placeholder
  }, 60000);
});
