import { beforeEach, describe, expect, it, vi } from "vitest";

// computeCropPlan's contract is that it NEVER throws: every failure of the
// probe, the scene detector or the python sidecar comes back as plan:null plus
// a machine-readable reason, and the render stage falls back to the legacy
// center crop. Every "this degrades safely" claim in the reframe design rests
// on that, and none of it had a test. The three child-process boundaries
// (ffprobe, ffmpeg, python3) are mocked so no video is needed.

type ExecResult = { stdout: string; stderr: string };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  // Returning an Error means "the process failed"; throwing means the spawn
  // itself blew up synchronously.
  respond: (_cmd: string, _args: string[]): ExecResult | Error => ({
    stdout: "",
    stderr: "",
  }),
}));

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, result?: ExecResult) => void
  ) => {
    h.calls.push({ cmd, args });
    const result = h.respond(cmd, args);
    if (result instanceof Error) cb(result);
    else cb(null, result);
  },
}));

import { computeCropPlan } from "../reframe";
import type { ReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";

const cfg: ReframeConfig = {
  engine: "faces",
  sampleFps: 2,
  sceneThreshold: 0.3,
  minShotSec: 1.0,
  faceMinScore: 0.7,
  maxDetectSec: 30,
  stream: false,
  camShare: 0.4,
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  motion: false,
  camera: DEFAULT_CAMERA,
  pipMaxFrac: 0.5,
  pipEdgeMin: 4.0,
};

/** One off-centre face per shot, wide enough to anchor a single layout. */
const detectorJson = (shotCount: number) =>
  JSON.stringify({
    shots: Array.from({ length: shotCount }, (_, i) => ({
      shotIndex: i,
      camRect: null,
      tracks: [
        {
          id: 1,
          box: { x: 800, y: 180, w: 240, h: 240 },
          score: 0.92,
          samples: 8,
          mouthActivity: 0.3,
        },
      ],
    })),
  });

/**
 * Everything succeeds: 1280x720, no scene cuts (so one shot covering the
 * window), one usable face in it.
 */
function happyPath(cmd: string, _args: string[]): ExecResult {
  if (cmd === "ffprobe") return { stdout: "1280x720\n", stderr: "" };
  if (cmd === "ffmpeg") return { stdout: "", stderr: "" };
  if (cmd === "python3") return { stdout: detectorJson(1), stderr: "" };
  throw new Error(`unexpected command ${cmd}`);
}

const killed = (message: string) => {
  const error = new Error(message) as Error & { killed: boolean };
  error.killed = true;
  return error;
};

describe("computeCropPlan never throws", () => {
  beforeEach(() => {
    h.calls = [];
    h.respond = happyPath;
  });

  it("returns scdet_failed when probing the source fails", async () => {
    h.respond = (cmd) =>
      cmd === "ffprobe" ? new Error("boom") : { stdout: "", stderr: "" };

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("scdet_failed");
    // Nothing downstream of the probe should have run.
    expect(h.calls.map((c) => c.cmd)).toEqual(["ffprobe"]);
  });

  it("returns scdet_failed when ffprobe answers with something unparseable", async () => {
    h.respond = (cmd) =>
      cmd === "ffprobe"
        ? { stdout: "N/AxN/A\n", stderr: "" }
        : { stdout: "", stderr: "" };

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("scdet_failed");
  });

  it("returns scdet_failed when a selected frame carries no scene score", async () => {
    h.respond = (cmd, args) =>
      cmd === "ffmpeg"
        ? { stdout: "", stderr: "[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:5.0\n" }
        : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("scdet_failed");
  });

  it("maps a killed process to timeout", async () => {
    h.respond = (cmd) =>
      cmd === "ffprobe" ? killed("killed") : { stdout: "", stderr: "" };

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("timeout");
  });

  it("maps a killed detector to timeout, keeping the shots it already had", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3" ? killed("killed") : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("timeout");
    expect(r.shotCount).toBe(1);
  });

  it("returns detector_failed when the sidecar exits non-zero", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3" ? new Error("exit status 1") : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("detector_failed");
    expect(r.shotCount).toBe(1);
  });

  it("returns detector_invalid_json when the sidecar prints garbage", async () => {
    // The sidecar succeeding and answering with nonsense is a different failure
    // from it dying, and the one a half-written stdout actually produces.
    h.respond = (cmd, args) =>
      cmd === "python3"
        ? { stdout: '{"shots": [{"shotIn', stderr: "" }
        : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("detector_invalid_json");
  });

  it("returns detector_invalid_json when the sidecar answers about the wrong shots", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3"
        ? { stdout: detectorJson(4), stderr: "" } // one shot was detected
        : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("detector_invalid_json");
  });

  it("returns plan_empty when the window yields no shots at all", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3"
        ? { stdout: detectorJson(0), stderr: "" }
        : happyPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 5, 5, cfg);

    expect(r.plan).toBeNull();
    expect(r.fallbackReason).toBe("plan_empty");
    expect(r.shotCount).toBe(0);
  });

  it("survives a spawn that throws synchronously", async () => {
    h.respond = () => {
      throw new Error("sync explosion");
    };

    await expect(computeCropPlan("/x.mp4", 0, 10, cfg)).resolves.toMatchObject({
      plan: null,
      fallbackReason: "scdet_failed",
    });
  });

  it("returns a real plan when every stage succeeds", async () => {
    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.fallbackReason).toBeUndefined();
    expect(r.shotCount).toBe(1);
    expect(r.detectMs).toBeGreaterThanOrEqual(0);
    expect(r.plan).toEqual({
      version: 1,
      engine: "faces",
      source: { width: 1280, height: 720 },
      profile: { class: "normal_face", faceFrac: 240 / 1280 },
      // Face centred on x=920 of a 1280-wide source, 406-wide 9:16 window.
      shots: [{ start: 0, end: 10, layout: "single", x: 718 }],
    });
    expect(h.calls.map((c) => c.cmd)).toEqual([
      "ffprobe",
      "ffmpeg", // scene detection
      "ffmpeg", // frame extraction
      "python3",
    ]);
  });
});
