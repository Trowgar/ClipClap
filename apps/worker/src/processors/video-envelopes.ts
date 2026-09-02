import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);
const MAX_ENVELOPE_SECOND = 7 * 24 * 60 * 60;
const VIDEO_ENVELOPE_TIMEOUT_MS = 30 * 60 * 1000;

export interface VideoEnvelopes {
  lumaEnvelope: number[];
  motionEnvelope: number[];
}

/**
 * Parse the per-second signalstats output used by both TRANSCRIBE and the
 * offline visual-recall evaluator. Each axis degrades independently: a bad
 * timestamp or missing value invalidates the affected output without leaking
 * source paths, transcript data, or production dependencies into evaluation.
 */
export function bucketVideoEnvelopesBySecond(stderr: string): VideoEnvelopes {
  const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const lumaBuckets = new Map<number, number[]>();
  const motionBuckets = new Map<number, number[]>();
  const expectedSeconds = new Set<number>();
  let sec: number | null = null;
  let invalidTimestamp = false;
  let invalidLuma = false;
  let invalidMotion = false;
  for (const line of stderr.split("\n")) {
    const ptsToken = line.match(/pts_time:([^\s]+)/);
    if (ptsToken) {
      const pts = Number(ptsToken[1]);
      if (!numberToken.test(ptsToken[1]) || !Number.isFinite(pts) || pts < 0 || pts > MAX_ENVELOPE_SECOND) {
        invalidTimestamp = true;
        sec = null;
        continue;
      }
      sec = Math.trunc(pts);
      expectedSeconds.add(sec);
      continue;
    }

    const yavgToken = line.match(/lavfi\.signalstats\.YAVG=([^\s]+)/);
    if (yavgToken) {
      const value = Number(yavgToken[1]);
      if (sec === null || !numberToken.test(yavgToken[1]) || !Number.isFinite(value)) {
        invalidLuma = true;
        continue;
      }
      const bucket = lumaBuckets.get(sec);
      if (bucket) bucket.push(value);
      else lumaBuckets.set(sec, [value]);
      continue;
    }

    const ydifToken = line.match(/lavfi\.signalstats\.YDIF=([^\s]+)/);
    if (ydifToken) {
      const value = Number(ydifToken[1]);
      if (sec === null || !numberToken.test(ydifToken[1]) || !Number.isFinite(value)) {
        invalidMotion = true;
        continue;
      }
      const bucket = motionBuckets.get(sec);
      if (bucket) bucket.push(value);
      else motionBuckets.set(sec, [value]);
    }
  }

  const seconds = [...expectedSeconds].sort((a, b) => a - b);
  if (invalidTimestamp || seconds.length === 0 || seconds[0] !== 0) {
    return { lumaEnvelope: [], motionEnvelope: [] };
  }
  const maxSecond = seconds[seconds.length - 1];
  for (let second = 0; second <= maxSecond; second++) {
    if (!expectedSeconds.has(second)) {
      return { lumaEnvelope: [], motionEnvelope: [] };
    }
  }

  const roundBuckets = (buckets: Map<number, number[]>, invalidAxis: boolean): number[] => {
    if (invalidAxis || seconds.some((second) => {
      const values = buckets.get(second);
      return !values || values.some((value) => !Number.isFinite(value));
    })) return [];
    return seconds.map((key) => {
      const values = buckets.get(key)!;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.round(mean * 10) / 10;
    });
  };
  return {
    lumaEnvelope: roundBuckets(lumaBuckets, invalidLuma),
    motionEnvelope: roundBuckets(motionBuckets, invalidMotion),
  };
}

/** One ffmpeg pass; failure is intentionally fail-open for transcription. */
export async function videoEnvelopes(videoPath: string): Promise<VideoEnvelopes> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-nostdin", "-i", videoPath,
      "-vf", "fps=1,signalstats,metadata=print",
      "-f", "null", "-",
    ], { maxBuffer: CHILD_MAX_BUFFER_BYTES, timeout: VIDEO_ENVELOPE_TIMEOUT_MS });
    return bucketVideoEnvelopesBySecond(stderr ?? "");
  } catch {
    // Keep this warning generic: eval input paths are private and must never
    // appear in process output when ffmpeg rejects a source.
    console.warn("videoEnvelopes: signalstats pass failed; continuing without visual signals");
    return { lumaEnvelope: [], motionEnvelope: [] };
  }
}

/**
 * Descriptor-backed variant for offline evaluation. fd 3 is inherited by the
 * child, so ffmpeg reads the already-validated inode rather than reopening a
 * path that could be swapped between validation and processing.
 */
export async function videoEnvelopesFromFd(sourceFd: number): Promise<VideoEnvelopes> {
  if (!Number.isInteger(sourceFd) || sourceFd < 0) return { lumaEnvelope: [], motionEnvelope: [] };
  try {
    const stderr = await runFfmpegFromFd(sourceFd);
    return bucketVideoEnvelopesBySecond(stderr ?? "");
  } catch {
    console.warn("videoEnvelopes: signalstats pass failed; continuing without visual signals");
    return { lumaEnvelope: [], motionEnvelope: [] };
  }
}

function runFfmpegFromFd(sourceFd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-nostdin", "-i", "/proc/self/fd/3",
      "-vf", "fps=1,signalstats,metadata=print",
      "-f", "null", "-",
    ], { stdio: ["ignore", "pipe", "pipe", sourceFd] });
    let stderr = "";
    let overflow = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("video envelope timeout"));
    }, VIDEO_ENVELOPE_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (overflow) return;
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr, "utf8") > CHILD_MAX_BUFFER_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
        reject(new Error("video envelope output exceeded limit"));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (overflow) return;
      if (code === 0) resolve(stderr);
      else reject(new Error("ffmpeg video envelope failed"));
    });
  });
}

export async function lumaEnvelope(videoPath: string): Promise<number[]> {
  return (await videoEnvelopes(videoPath)).lumaEnvelope;
}
