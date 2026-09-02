import { execFile } from "child_process";
import { promisify } from "util";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

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
      if (!numberToken.test(ptsToken[1]) || !Number.isFinite(pts) || pts < 0) {
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
    ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
    return bucketVideoEnvelopesBySecond(stderr ?? "");
  } catch {
    // Keep this warning generic: eval input paths are private and must never
    // appear in process output when ffmpeg rejects a source.
    console.warn("videoEnvelopes: signalstats pass failed; continuing without visual signals");
    return { lumaEnvelope: [], motionEnvelope: [] };
  }
}

export async function lumaEnvelope(videoPath: string): Promise<number[]> {
  return (await videoEnvelopes(videoPath)).lumaEnvelope;
}
