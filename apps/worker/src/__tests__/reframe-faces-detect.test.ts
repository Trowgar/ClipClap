import { beforeEach, describe, expect, it, vi } from "vitest";

// A separate file from reframe-faces.test.ts on purpose, same reason as
// reframe-shots-detect.test.ts: parseDetectorOutput must stay free of module
// mocks. Here the child_process boundary is mocked so detectFaces' argv to
// the python sidecar can be pinned - specifically --stream-face-ceiling
// (spec 2026-08-19-stream-reframe-v2 D5 follow-up), which the sidecar's own
// per-shot gate on median_edge_map now reads instead of --face-small-frac.
// Without this thread, a strogo-shaped source (dominant face above the old
// 0.06 floor but under the classifier's ceiling) never even gets a rect
// search: the sidecar's gate would still be closed even though the TS
// classifier is willing to try rect-first.

const h = vi.hoisted(() => ({
  /** {cmd, args} of every child_process call, in order. */
  calls: [] as Array<{ cmd: string; args: string[] }>,
}));

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    h.calls.push({ cmd, args });
    if (cmd === "python3") {
      cb(null, {
        stdout: JSON.stringify({ shots: [{ shotIndex: 0, tracks: [] }] }),
        stderr: "",
      });
    } else {
      cb(null, { stdout: "", stderr: "" });
    }
  },
}));

import { detectFaces } from "../reframe/faces";
import type { ReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";
import { DEFAULT_STREAM_FACE_CEILING } from "../reframe/options";

// No `streamFaceCeiling` field, on purpose: this is the shape every
// ReframeConfig literal had before D5, and the field is optional precisely
// so those callers keep compiling. detectFaces must still hand the sidecar a
// real number.
const baseCfg: ReframeConfig = {
  engine: "faces",
  sampleFps: 2,
  sceneThreshold: 0.3,
  minShotSec: 1.0,
  faceMinScore: 0.7,
  maxDetectSec: 30,
  stream: true,
  camShare: 0.4,
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  motion: false,
  cutRecovery: false,
  streamVirtualCam: false,
  camera: DEFAULT_CAMERA,
  pipMaxFrac: 0.5,
  pipEdgeMin: 4.0,
};

const pythonArgs = () => h.calls.find((c) => c.cmd === "python3")!.args;
const argAfter = (flag: string) => {
  const args = pythonArgs();
  return args[args.indexOf(flag) + 1];
};

describe("detectFaces argv: --stream-face-ceiling threading", () => {
  beforeEach(() => {
    h.calls = [];
  });

  it("passes cfg.streamFaceCeiling through to --stream-face-ceiling", async () => {
    await detectFaces(
      "/x.mp4",
      0,
      10,
      [{ start: 0, end: 10 }],
      1280,
      720,
      { ...baseCfg, streamFaceCeiling: 0.2 },
      10_000
    );
    expect(argAfter("--stream-face-ceiling")).toBe("0.2");
    // The pre-existing floor is still threaded unchanged alongside it - this
    // is an ADDITION to the sidecar's gate, not a replacement of the flag.
    expect(argAfter("--face-small-frac")).toBe("0.06");
  });

  it("falls back to DEFAULT_STREAM_FACE_CEILING when the config omits it", async () => {
    await detectFaces(
      "/x.mp4",
      0,
      10,
      [{ start: 0, end: 10 }],
      1280,
      720,
      baseCfg,
      10_000
    );
    expect(argAfter("--stream-face-ceiling")).toBe(String(DEFAULT_STREAM_FACE_CEILING));
  });
});
