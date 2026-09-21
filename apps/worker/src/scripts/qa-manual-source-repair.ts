/** Production smoke, ONLY after the release owner's explicit signal.
 * Run in the deployed worker-render image:
 *   npx tsx apps/worker/src/scripts/qa-manual-source-repair.ts --execute
 * Creates one labelled synthetic job, one parent and two edited copies.
 * No submission/transcription/analysis/finalize calls; no model requests.
 * Leaves labelled rows/R2 media and local evidence for browser QA.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { clipService, getPresignedDownloadUrl, getStageQueue, prisma, uploadFile } from "@clipclap/shared";
import type { SubtitleTrack } from "@clipclap/shared";
import { cutClips } from "../processors/cut";
import { createAssFilter } from "../processors/subtitles";

const exec = promisify(execFile);
const report: Record<string, unknown> = { kind: "QA-MANUAL-SOURCE-REPAIR", automaticQualityFixed: false };
let directory: string | undefined;

async function download(key: string, path: string) {
  // Never log signed URLs, storage credentials or underlying fetch errors.
  const url = await getPresignedDownloadUrl(key);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert(response.ok, `Evidence download returned HTTP ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

async function pixels(path: string, seconds: number, crop: string) {
  const { stdout } = await exec("ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", path,
    "-frames:v", "1", "-vf", crop, "-f", "rawvideo", "pipe:1"], { encoding: "buffer", timeout: 30000 });
  return stdout;
}

async function main() {
  assert(process.argv.includes("--execute"), "Prepared only. Requires release-owner signal and --execute.");
  report.stage = "verify-synthetic-account";
  const user = await prisma.user.findUnique({ where: { email: "codex-browser@test.local" }, select: { id: true, isSynthetic: true } });
  assert(user?.isSynthetic, "Required QA account missing or not marked synthetic; refusing writes.");

  directory = await mkdtemp(join(tmpdir(), "clipclap-prod-repair-"));
  const label = `QA-MANUAL-SOURCE-REPAIR-${randomUUID()}`;
  report.label = label;
  report.directory = directory;
  report.stage = "build-local-fixture";
  const source = join(directory, "source.mp4");
  // Red/blue source edges prove full-frame; the yellow marker exists ONLY
  // after the parent's ending, so a frozen/looped parent cannot pass.
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "color=c=green:s=320x180:r=25:d=12,drawbox=x=0:y=0:w=80:h=180:color=red:t=fill,drawbox=x=240:y=0:w=80:h=180:color=blue:t=fill,drawbox=x=140:y=30:w=40:h=40:color=yellow:t=fill:enable='gte(t,4)'",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", source], { timeout: 60000 });
  const track: SubtitleTrack = { cues: [{ id: "parent-caption", start: 0.2, end: 1.2, text: "PARENT CAPTION" }] };
  const ass = await createAssFilter(track.cues, "en");
  const [parentMedia] = await cutClips(source, [{ start: 1, end: 4, title: label, reason: "Synthetic QA" }], ass.filter);
  const parentHash = createHash("sha256").update(await readFile(parentMedia.clipPath)).digest("hex");

  report.stage = "create-labelled-job-and-media";
  const job = await prisma.job.create({ data: {
    userId: user.id, status: "DONE", originalFilename: `${label}.mp4`, sourceDurationSec: 12,
    language: "en", subtitles: true, clipsGenerated: 1, processingEndedAt: new Date(),
    transcriptJson: { text: "PARENT CAPTION TAIL TWO TAIL FIVE", language: "en", segments: [
      { start: 1.2, end: 2.2, text: "PARENT CAPTION", words: [{ text: "PARENT", start: 1.2, end: 1.7 }, { text: "CAPTION", start: 1.7, end: 2.2 }] },
      { start: 4.2, end: 5.5, text: "TAIL TWO", words: [{ text: "TAIL", start: 4.2, end: 4.8 }, { text: "TWO", start: 4.8, end: 5.5 }] },
      { start: 6.2, end: 8.5, text: "TAIL FIVE", words: [{ text: "TAIL", start: 6.2, end: 7.2 }, { text: "FIVE", start: 7.2, end: 8.5 }] },
    ] },
  } });
  report.jobId = job.id;
  const sourceKey = `work/${user.id}/${job.id}/qa-source.mp4`;
  const parentKey = `clips/${user.id}/${job.id}/qa-parent.mp4`;
  await uploadFile(sourceKey, source, "video/mp4");
  await uploadFile(parentKey, parentMedia.clipPath, "video/mp4");
  await prisma.job.update({ where: { id: job.id }, data: { sourceArtifactKey: sourceKey, normalizedArtifactKey: sourceKey } });
  const parent = await prisma.clip.create({ data: {
    jobId: job.id, userId: user.id, title: label, storageKey: parentKey, startTime: 1, endTime: 4,
    duration: 3, language: "en", subtitles: true,
    subtitleTrack: { cues: track.cues.map(({ id, start, end, text }) => ({ id, start, end, text })) },
    expiresAt: new Date(Date.now() + 86400000),
  } });
  report.parentClipId = parent.id;
  const results: Record<string, unknown>[] = [];
  report.repairs = results;

  for (const extendEndSeconds of [2, 5] as const) {
    report.stage = `render-and-verify-plus-${extendEndSeconds}`;
    const child = await clipService.editClip({ clipId: parent.id, userId: user.id, start: 1, end: 4,
      extendEndSeconds, framing: "safe-fit", subtitles: true, subtitleTrack: track });
    const result: Record<string, unknown> = { extendEndSeconds, clipId: child.id, verified: false };
    results.push(result);
    assert.notEqual(child.id, parent.id);
    assert.equal(new Set(results.map(row => row.clipId)).size, results.length);

    let ready = child;
    const deadline = Date.now() + 300000;
    while (!ready.storageKey && !ready.deletedAt && Date.now() < deadline) {
      await delay(2000);
      ready = await prisma.clip.findUniqueOrThrow({ where: { id: child.id } });
    }
    assert(!ready.deletedAt, "Repair placeholder marked unavailable by worker");
    assert(ready.storageKey, "Repair did not finish within five minutes");
    assert.equal(ready.parentClipId, parent.id);
    assert.equal(ready.startTime, 1);
    assert.equal(ready.endTime, 4 + extendEndSeconds);
    const cues = (ready.subtitleTrack as unknown as SubtitleTrack).cues;
    assert(cues.some(c => c.text === "PARENT CAPTION"), "Original caption missing");
    const expectedTail = extendEndSeconds === 2 ? "TAIL TWO" : "TAIL FIVE";
    assert(cues.some(c => c.text === expectedTail && c.start >= 3 && c.end <= 3 + extendEndSeconds), "Restored tail captions missing/misaligned");
    const path = join(directory, `plus-${extendEndSeconds}.mp4`);
    await download(ready.storageKey, path);
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", path]);
    const media = JSON.parse(stdout);
    const video = media.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const audio = media.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
    const expectedDuration = 3 + extendEndSeconds;
    assert.equal(video?.width, 1080); assert.equal(video?.height, 1920);
    assert(Math.abs(Number(video.duration) - expectedDuration) < 0.15, "Wrong video duration");
    assert(Math.abs(Number(audio?.duration) - expectedDuration) < 0.15, "Missing/wrong audio duration");
    const last = expectedDuration - 0.2;
    const red = await pixels(path, last, "crop=2:2:40:960,format=rgb24");
    const blue = await pixels(path, last, "crop=2:2:1030:960,format=rgb24");
    const yellow = await pixels(path, last, "crop=2:2:540:820,format=rgb24");
    assert(red[0] > 180 && red[2] < 60 && blue[2] > 180 && blue[0] < 60, "Full-frame edges missing");
    assert(yellow[0] > 180 && yellow[1] > 180 && yellow[2] < 80, "Actual post-parent source content missing");
    const caption = await pixels(path, extendEndSeconds === 2 ? 3.5 : 6, "crop=800:350:140:1500,format=gray");
    assert(caption.filter(value => value > 220).length > 100, "Tail caption pixels missing");
    // Keep an inspectable representative frame beside each repaired video.
    await exec("ffmpeg", ["-v", "error", "-ss", extendEndSeconds === 2 ? "3.5" : "6", "-i", path, "-frames:v", "1", join(directory, `plus-${extendEndSeconds}.png`)]);
    Object.assign(result, { verified: true, video: path, duration: Number(video.duration), fullFrameEdges: true, tailMarker: true, tailCaptionPixels: true });
  }

  report.stage = "verify-parent-unchanged";
  assert.deepEqual(await prisma.clip.findUniqueOrThrow({ where: { id: parent.id } }), parent, "Parent row changed");
  const originalCopy = join(directory, "parent-after.mp4");
  await download(parentKey, originalCopy);
  assert.equal(createHash("sha256").update(await readFile(originalCopy)).digest("hex"), parentHash, "Parent media changed");
  report.parentUnchanged = true;
  report.passed = true;
  report.stage = "complete";
}

main().catch(() => {
  // Raw exceptions may contain storage URLs or infrastructure credentials.
  report.passed = false;
  report.failure = "Smoke failed; inspect the retained synthetic job and local evidence. No automatic cleanup was performed.";
  process.exitCode = 1;
}).finally(async () => {
  if (directory) await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  if (process.argv.includes("--execute")) await getStageQueue("render").close();
  // Shared Redis intentionally stays alive in services; this is a one-shot CLI.
  process.exit(process.exitCode ?? 0);
});
