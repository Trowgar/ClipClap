import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ReframeConfig } from "./config";
import { DEFAULT_STREAM_FACE_CEILING } from "./options";
import type { CamRect, FaceTrack, PathSample, Shot, ShotTracks } from "./types";

import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
const execFileAsync = promisify(execFile);

// assets/ ships beside src/ in dev (tsx) and beside dist/ in the production
// image, so __dirname/../.. lands on apps/worker in both (resolveFontsDir pattern).
export function reframeAssetsDir(): string {
  return join(__dirname, "..", "..", "assets", "reframe");
}

/** Strict structural validation of the sidecar contract. Throws on violation. */
export function parseDetectorOutput(raw: string, shotCount: number): ShotTracks[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("detector_invalid_json");
  }
  const shots = (parsed as { shots?: unknown } | null)?.shots;
  if (!Array.isArray(shots) || shots.length !== shotCount) {
    throw new Error("detector_invalid_json");
  }
  const num = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  return shots.map((s) => {
    const st = s as { shotIndex?: unknown; tracks?: unknown };
    if (!num(st.shotIndex) || !Array.isArray(st.tracks)) {
      throw new Error("detector_invalid_json");
    }
    const tracks: FaceTrack[] = st.tracks.map((t) => {
      const tr = t as {
        id?: unknown;
        box?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
        score?: unknown;
        samples?: unknown;
        mouthActivity?: unknown;
      };
      if (
        !num(tr.id) ||
        !tr.box ||
        !num(tr.box.x) ||
        !num(tr.box.y) ||
        !num(tr.box.w) ||
        !num(tr.box.h) ||
        !num(tr.score) ||
        !num(tr.samples) ||
        !num(tr.mouthActivity)
      ) {
        throw new Error("detector_invalid_json");
      }
      // An ABSENT path is fine - an older sidecar must not break a newer
      // worker, the same rule camRect follows below. A PRESENT one is
      // validated as strictly as the track itself, because a NaN reaching the
      // camera solver would produce a crop expression ffmpeg accepts and
      // renders as garbage.
      let path: PathSample[] | undefined;
      const rawPath = (t as { path?: unknown }).path;
      if (rawPath != null) {
        if (!Array.isArray(rawPath)) throw new Error("detector_invalid_json");
        path = rawPath.map((p) => {
          const s = p as Record<string, unknown>;
          if (!num(s.t) || !num(s.x) || !num(s.y) || !num(s.w) || !num(s.h)) {
            throw new Error("detector_invalid_json");
          }
          return { t: s.t, x: s.x, y: s.y, w: s.w, h: s.h };
        });
      }
      return {
        id: tr.id,
        box: { x: tr.box.x, y: tr.box.y, w: tr.box.w, h: tr.box.h },
        score: tr.score,
        samples: tr.samples,
        mouthActivity: tr.mouthActivity,
        ...(path ? { path } : {}),
      };
    });
    // An ABSENT camRect is null, not a violation: an older sidecar must not
    // break a newer worker. A PRESENT one is validated as strictly as a track.
    const rawRect = (s as { camRect?: unknown }).camRect;
    let camRect: CamRect | null = null;
    if (rawRect != null) {
      const r = rawRect as Record<string, unknown>;
      if (!num(r.x) || !num(r.y) || !num(r.w) || !num(r.h) || !num(r.score)) {
        throw new Error("detector_invalid_json");
      }
      camRect = { x: r.x, y: r.y, w: r.w, h: r.h, score: r.score };
    }
    return { shotIndex: st.shotIndex, tracks, camRect };
  });
}

/**
 * Extracts sampled frames with ffmpeg (reliable seek, same tool as the encode)
 * and runs the YuNet sidecar over them. Boxes come back in source pixels.
 */
export async function detectFaces(
  sourcePath: string,
  startSec: number,
  endSec: number,
  shots: Shot[],
  sourceWidth: number,
  sourceHeight: number,
  cfg: ReframeConfig,
  timeoutMs: number
): Promise<ShotTracks[]> {
  const workDir = await mkdtemp(join(tmpdir(), "clipclap-reframe-"));
  try {
    const framesDir = join(workDir, "frames");
    await mkdir(framesDir);
    // ffmpeg and the python sidecar run sequentially; splitting the budget keeps
    // the worst case near timeoutMs instead of ~2x it.
    const startedAt = Date.now();
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-ss", String(startSec),
        "-to", String(endSec),
        "-i", sourcePath,
        "-vf", `fps=${cfg.sampleFps},scale=640:-2`,
        "-q:v", "5",
        join(framesDir, "frame-%05d.jpg"),
        "-y",
      ],
      { timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    const shotsPath = join(workDir, "shots.json");
    await writeFile(shotsPath, JSON.stringify(shots), "utf-8");
    const pythonTimeout = Math.max(1000, timeoutMs - (Date.now() - startedAt));
    const { stdout } = await execFileAsync(
      "python3",
      [
        join(reframeAssetsDir(), "detect_faces.py"),
        "--frames-dir", framesDir,
        "--shots", shotsPath,
        "--fps", String(cfg.sampleFps),
        "--model", join(reframeAssetsDir(), "face_detection_yunet_2023mar.onnx"),
        "--min-score", String(cfg.faceMinScore),
        "--face-small-frac", String(cfg.faceSmallFrac),
        // Matches the classifier's D5 rect-first ceiling (spec
        // 2026-08-19-stream-reframe-v2), so the sidecar's own gate on
        // median_edge_map does not silently exclude a face the TS side would
        // otherwise attempt rect-first for.
        "--stream-face-ceiling", String(cfg.streamFaceCeiling ?? DEFAULT_STREAM_FACE_CEILING),
        "--pip-max-frac", String(cfg.pipMaxFrac),
        "--pip-edge-min", String(cfg.pipEdgeMin),
        "--source-width", String(sourceWidth),
        "--source-height", String(sourceHeight),
      ],
      { timeout: pythonTimeout, maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    return parseDetectorOutput(stdout, shots.length);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
