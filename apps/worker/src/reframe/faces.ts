import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ReframeConfig } from "./config";
import type { FaceTrack, Shot, ShotTracks } from "./types";

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
      return {
        id: tr.id,
        box: { x: tr.box.x, y: tr.box.y, w: tr.box.w, h: tr.box.h },
        score: tr.score,
        samples: tr.samples,
        mouthActivity: tr.mouthActivity,
      };
    });
    return { shotIndex: st.shotIndex, tracks };
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
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
    );
    const shotsPath = join(workDir, "shots.json");
    await writeFile(shotsPath, JSON.stringify(shots), "utf-8");
    const { stdout } = await execFileAsync(
      "python3",
      [
        join(reframeAssetsDir(), "detect_faces.py"),
        "--frames-dir", framesDir,
        "--shots", shotsPath,
        "--fps", String(cfg.sampleFps),
        "--model", join(reframeAssetsDir(), "face_detection_yunet_2023mar.onnx"),
        "--min-score", String(cfg.faceMinScore),
        "--source-width", String(sourceWidth),
        "--source-height", String(sourceHeight),
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
    );
    return parseDetectorOutput(stdout, shots.length);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
