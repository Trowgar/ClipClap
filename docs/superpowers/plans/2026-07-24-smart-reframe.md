# Smart Reframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blind center crop in 9:16 conversion with a scene-aware layout engine: per-shot face-centered crop, split-screen for far-apart duets, center fallback - per spec `docs/superpowers/specs/2026-07-24-smart-reframe-design.md`.

**Architecture:** Three deterministic steps inside RENDER per highlight: ffmpeg scdet shot detection (TS) -> YuNet face tracks (thin Python sidecar) -> pure-TS layout plan compiled to a single-pass ffmpeg filtergraph. Plan persisted on `Clip.cropPlan`; every failure falls back to today's center crop. Env flag `REFRAME_ENGINE=off|faces`, code default `off`.

**Tech Stack:** TypeScript (worker), ffmpeg (scdet, frame extraction, encode), Python 3 + OpenCV YuNet (apk `py3-opencv` on Alpine 3.23, verified), Prisma migration, vitest.

**Environment notes (read first):**
- Host Node is v18 and cannot run vitest. ALL tests, typechecks, prisma commands run INSIDE containers.
- Test command: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/<file>"` (worker containers share one image; source is bind-mounted, tsx hot-reloads - no rebuild for TS changes).
- Typecheck: `docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"`.
- Prisma migrations only, never `db push`. `migrate deploy` runs in the `web` container.
- Commits: identity `Trowgar <trowgar@yahoo.com>`, NO Claude attribution trailer, plain hyphens in messages.
- Do NOT touch `apps/web/lib/auth.ts` or `apps/web/lib/telegram-provider.ts` (uncommitted WIP by the owner). Commit only files you created/modified for your task.

---

### Task 1: Worker image dependencies, YuNet model, env scaffolding

**Files:**
- Modify: `apps/worker/Dockerfile:4`
- Create: `apps/worker/assets/reframe/face_detection_yunet_2023mar.onnx` (downloaded binary)
- Modify: `.env.example` (after the `TRANSCRIPT_MIN_COVERAGE` line)

- [ ] **Step 1: Add OpenCV to the base image layer**

In `apps/worker/Dockerfile` change line 4 from:

```dockerfile
RUN apk add --no-cache ffmpeg python3 py3-pip openssl fontconfig
```

to:

```dockerfile
RUN apk add --no-cache ffmpeg python3 py3-pip openssl fontconfig py3-opencv py3-numpy
```

- [ ] **Step 2: Vendor the YuNet model**

```bash
mkdir -p apps/worker/assets/reframe
curl -L -o apps/worker/assets/reframe/face_detection_yunet_2023mar.onnx \
  https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
ls -l apps/worker/assets/reframe/
```

Expected: file size ~232000 bytes. If it is ~134 bytes you downloaded a Git-LFS pointer - the `media.githubusercontent.com` URL above is the LFS-resolving one, retry with it exactly.

- [ ] **Step 3: Add env knobs to `.env.example`**

Insert after the `TRANSCRIPT_MIN_COVERAGE=0.9` line:

```bash
# --- Smart reframe (scene-aware face crop) ---
REFRAME_ENGINE=off               # off | faces
REFRAME_SAMPLE_FPS=2
REFRAME_SCENE_THRESHOLD=0.4      # scdet scene score cut (0..1)
REFRAME_MIN_SHOT_SEC=1.0
REFRAME_FACE_MIN_SCORE=0.7
REFRAME_MAX_DETECT_SEC=30
```

- [ ] **Step 4: Rebuild worker images (real rebuild - new apk layer)**

```bash
docker compose up -d --build
```

Then the mandatory post-recreate ritual (containers were recreated):

```bash
for s in web worker-download worker-transcribe worker-analyze worker-render worker-finalize bot; do
  docker compose exec $s sh -c "cd /app && npx prisma generate" >/dev/null 2>&1 || true
done
docker compose exec web sh -c "cd /app && npm run build -w @clipclap/shared"
```

- [ ] **Step 5: Verify cv2 + YuNet inside the rebuilt image**

```bash
docker compose exec worker-render python3 -c "import cv2; print(cv2.__version__, hasattr(cv2, 'FaceDetectorYN'))"
```

Expected: `4.12.0 True`

- [ ] **Step 6: Commit**

```bash
git add apps/worker/Dockerfile apps/worker/assets/reframe/face_detection_yunet_2023mar.onnx .env.example
git commit -m "feat(reframe): worker image opencv deps, vendored YuNet model, env knobs"
```

---

### Task 2: Prisma migration - Clip.cropPlan

**Files:**
- Modify: `prisma/schema.prisma` (model Clip)
- Create: `prisma/migrations/20260724110000_clip_crop_plan/migration.sql`

- [ ] **Step 1: Add the column to the schema**

In `prisma/schema.prisma`, model `Clip`, add directly after the `subtitleTrack` field:

```prisma
  cropPlan      Json?
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20260724110000_clip_crop_plan/migration.sql`:

```sql
ALTER TABLE "clips" ADD COLUMN "cropPlan" JSONB;
```

(The Clip model has `@@map("clips")` - the mapped table name is the real one, matching `20260611200000_add_clip_subtitle_track`.)

- [ ] **Step 3: Deploy and regenerate**

```bash
docker compose exec web sh -c "cd /app && npx prisma migrate deploy"
for s in web worker-download worker-transcribe worker-analyze worker-render worker-finalize bot; do
  docker compose exec $s sh -c "cd /app && npx prisma generate" >/dev/null 2>&1 || true
done
```

Expected: `migrate deploy` reports `20260724110000_clip_crop_plan` applied.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260724110000_clip_crop_plan/migration.sql
git commit -m "feat(reframe): Clip.cropPlan column"
```

---

### Task 3: reframe types and config

**Files:**
- Create: `apps/worker/src/reframe/types.ts`
- Create: `apps/worker/src/reframe/config.ts`
- Test: `apps/worker/src/__tests__/reframe-config.test.ts`

- [ ] **Step 1: Write the types**

Create `apps/worker/src/reframe/types.ts`:

```typescript
export interface Shot {
  start: number; // clip-relative seconds
  end: number;
}

export interface FaceTrack {
  id: number;
  /** Median box across the track's samples, SOURCE pixels. */
  box: { x: number; y: number; w: number; h: number };
  score: number; // mean detection confidence
  samples: number; // detections associated into this track
  mouthActivity: number; // mean abs mouth-region diff between samples, 0..1
}

export interface ShotTracks {
  shotIndex: number;
  tracks: FaceTrack[];
}

export type ShotLayout =
  | { start: number; end: number; layout: "center"; x: number }
  | { start: number; end: number; layout: "single"; x: number }
  | {
      start: number;
      end: number;
      layout: "split";
      top: { x: number };
      bottom: { x: number };
    };

export interface CropPlan {
  version: 1;
  engine: "faces";
  source: { width: number; height: number };
  shots: ShotLayout[];
}

export type FilterSpec =
  | { kind: "vf"; graph: string }
  | { kind: "complex"; graph: string };
```

- [ ] **Step 2: Write the failing config test**

Create `apps/worker/src/__tests__/reframe-config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { loadReframeConfig } from "../reframe/config";

describe("loadReframeConfig", () => {
  it("defaults to off with documented knob values", () => {
    const cfg = loadReframeConfig({});
    expect(cfg).toEqual({
      engine: "off",
      sampleFps: 2,
      sceneThreshold: 0.4,
      minShotSec: 1.0,
      faceMinScore: 0.7,
      maxDetectSec: 30,
    });
  });

  it("reads env overrides and only accepts the literal 'faces' engine", () => {
    const cfg = loadReframeConfig({
      REFRAME_ENGINE: "faces",
      REFRAME_SAMPLE_FPS: "4",
      REFRAME_SCENE_THRESHOLD: "0.3",
      REFRAME_MIN_SHOT_SEC: "2",
      REFRAME_FACE_MIN_SCORE: "0.8",
      REFRAME_MAX_DETECT_SEC: "15",
    });
    expect(cfg.engine).toBe("faces");
    expect(cfg.sampleFps).toBe(4);
    expect(cfg.sceneThreshold).toBe(0.3);
    expect(cfg.minShotSec).toBe(2);
    expect(cfg.faceMinScore).toBe(0.8);
    expect(cfg.maxDetectSec).toBe(15);
    expect(loadReframeConfig({ REFRAME_ENGINE: "yes" }).engine).toBe("off");
  });

  it("falls back to defaults on junk numbers", () => {
    const cfg = loadReframeConfig({ REFRAME_SAMPLE_FPS: "-1", REFRAME_SCENE_THRESHOLD: "abc" });
    expect(cfg.sampleFps).toBe(2);
    expect(cfg.sceneThreshold).toBe(0.4);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/reframe-config.test.ts"`
Expected: FAIL - cannot resolve `../reframe/config`.

- [ ] **Step 4: Implement the config loader**

Create `apps/worker/src/reframe/config.ts`:

```typescript
export interface ReframeConfig {
  engine: "off" | "faces";
  sampleFps: number;
  sceneThreshold: number;
  minShotSec: number;
  faceMinScore: number;
  maxDetectSec: number;
}

function positive(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadReframeConfig(
  env: NodeJS.ProcessEnv = process.env
): ReframeConfig {
  return {
    engine: env.REFRAME_ENGINE === "faces" ? "faces" : "off",
    sampleFps: positive(env.REFRAME_SAMPLE_FPS, 2),
    sceneThreshold: positive(env.REFRAME_SCENE_THRESHOLD, 0.4),
    minShotSec: positive(env.REFRAME_MIN_SHOT_SEC, 1.0),
    faceMinScore: positive(env.REFRAME_FACE_MIN_SCORE, 0.7),
    maxDetectSec: positive(env.REFRAME_MAX_DETECT_SEC, 30),
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Same command. Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/reframe/types.ts apps/worker/src/reframe/config.ts apps/worker/src/__tests__/reframe-config.test.ts
git commit -m "feat(reframe): types and env config loader"
```

---

### Task 4: Shot detection (ffmpeg scdet)

**Files:**
- Create: `apps/worker/src/reframe/shots.ts`
- Test: `apps/worker/src/__tests__/reframe-shots.test.ts`

- [ ] **Step 1: Write the failing tests for the pure splitter**

Create `apps/worker/src/__tests__/reframe-shots.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { cutsToShots } from "../reframe/shots";

describe("cutsToShots", () => {
  it("splits the clip at scene cuts", () => {
    expect(cutsToShots([12.4, 31.0], 57.5, 1.0)).toEqual([
      { start: 0, end: 12.4 },
      { start: 12.4, end: 31.0 },
      { start: 31.0, end: 57.5 },
    ]);
  });

  it("returns a single shot when there are no cuts", () => {
    expect(cutsToShots([], 30, 1.0)).toEqual([{ start: 0, end: 30 }]);
  });

  it("merges micro-shots forward into the next segment", () => {
    // cuts at 5.0 and 5.4: the 0.4s middle segment folds into [5.0, 9.0]
    expect(cutsToShots([5.0, 5.4], 9.0, 1.0)).toEqual([
      { start: 0, end: 5.0 },
      { start: 5.0, end: 9.0 },
    ]);
  });

  it("merges a too-short tail backward into the last shot", () => {
    expect(cutsToShots([5.0], 5.6, 1.0)).toEqual([{ start: 0, end: 5.6 }]);
  });

  it("ignores cuts outside (0, duration) and duplicates", () => {
    expect(cutsToShots([0, 5, 5, 60], 30, 1.0)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 30 },
    ]);
  });

  it("treats a clip shorter than minShotSec as one shot", () => {
    expect(cutsToShots([], 0.8, 1.0)).toEqual([{ start: 0, end: 0.8 }]);
  });

  it("returns empty for a non-positive duration", () => {
    expect(cutsToShots([], 0, 1.0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/reframe-shots.test.ts"`
Expected: FAIL - cannot resolve `../reframe/shots`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/reframe/shots.ts`:

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import type { ReframeConfig } from "./config";
import type { Shot } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Pure: scene-cut times (clip-relative) -> shot list covering [0, duration].
 * Segments shorter than minShotSec merge forward into the next segment
 * (the cut is simply dropped); a too-short tail merges backward into the
 * last shot. Anti-flicker per spec §5.1.
 */
export function cutsToShots(
  cutTimes: number[],
  duration: number,
  minShotSec: number
): Shot[] {
  if (!(duration > 0)) return [];
  const cuts = [...new Set(cutTimes)]
    .filter((t) => t > 0 && t < duration)
    .sort((a, b) => a - b);
  const shots: Shot[] = [];
  let pendingStart = 0;
  for (const t of [...cuts, duration]) {
    if (t - pendingStart < minShotSec) {
      if (t === duration) {
        if (shots.length > 0) shots[shots.length - 1].end = duration;
        else shots.push({ start: pendingStart, end: duration });
      }
      continue; // drop the cut - segment keeps growing into the next one
    }
    shots.push({ start: pendingStart, end: t });
    pendingStart = t;
  }
  return shots;
}

/**
 * Runs ffmpeg scene detection on the highlight window only, at 320px width.
 * Timestamps in showinfo output are clip-relative because -ss precedes -i.
 */
export async function detectShots(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig,
  timeoutMs: number
): Promise<Shot[]> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin",
      "-ss", String(startSec),
      "-to", String(endSec),
      "-i", sourcePath,
      "-vf", `scale=320:-2,select='gte(scene,${cfg.sceneThreshold})',showinfo`,
      "-f", "null", "-",
    ],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
  );
  const cuts = [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)].map(
    (m) => Number(m[1])
  );
  return cutsToShots(cuts, endSec - startSec, cfg.minShotSec);
}
```

- [ ] **Step 4: Run to verify pass**

Same command. Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/shots.ts apps/worker/src/__tests__/reframe-shots.test.ts
git commit -m "feat(reframe): shot detection via ffmpeg scdet with micro-shot merge"
```

---

### Task 5: Python face-detection sidecar

**Files:**
- Create: `apps/worker/assets/reframe/detect_faces.py`

- [ ] **Step 1: Write the sidecar**

Create `apps/worker/assets/reframe/detect_faces.py`:

```python
#!/usr/bin/env python3
"""YuNet face-detection sidecar for the smart-reframe pipeline.

Reads pre-extracted JPEG frames, detects faces per frame, associates them
into per-shot tracks by greedy IoU, and measures mouth-region motion as a
cheap active-speaker proxy. Prints one JSON document to stdout.

Deliberately thin: NO layout decisions live here (those are TypeScript and
unit-tested). Boxes are reported in SOURCE pixels.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

IOU_MIN = 0.3
MOUTH_PATCH = (32, 16)  # w, h - fixed size so motion energy is comparable


def iou(a, b):
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    iy = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def mouth_patch(gray, det):
    # YuNet row: x,y,w,h, re_x,re_y, le_x,le_y, nose_x,nose_y,
    #            mr_x,mr_y, ml_x,ml_y, score
    mrx, mry, mlx, mly = det[10], det[11], det[12], det[13]
    cx, cy = (mrx + mlx) / 2.0, (mry + mly) / 2.0
    w = max(8.0, abs(mlx - mrx) * 1.6)
    h = w * 0.6
    x1, y1 = int(cx - w / 2), int(cy - h / 2)
    x2, y2 = int(cx + w / 2), int(cy + h / 2)
    H, W = gray.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(W, x2), min(H, y2)
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    patch = gray[y1:y2, x1:x2]
    return cv2.resize(patch, MOUTH_PATCH).astype(np.float32) / 255.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--shots", required=True, help="JSON file: [{start,end}] clip-relative")
    ap.add_argument("--fps", type=float, required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--min-score", type=float, default=0.7)
    ap.add_argument("--source-width", type=int, required=True)
    ap.add_argument("--source-height", type=int, required=True)
    args = ap.parse_args()

    with open(args.shots) as f:
        shots = json.load(f)
    frames = sorted(
        f for f in os.listdir(args.frames_dir) if f.endswith(".jpg")
    )

    detector = None
    scale = 1.0
    states = [[] for _ in shots]  # per-shot list of track dicts

    for idx, name in enumerate(frames):
        t = idx / args.fps
        shot_i = len(shots) - 1
        for i, s in enumerate(shots):
            if s["start"] <= t < s["end"]:
                shot_i = i
                break
        img = cv2.imread(os.path.join(args.frames_dir, name))
        if img is None:
            continue
        h, w = img.shape[:2]
        if detector is None:
            detector = cv2.FaceDetectorYN.create(
                args.model, "", (w, h), score_threshold=args.min_score
            )
            scale = args.source_width / float(w)
        detector.setInputSize((w, h))
        _, dets = detector.detect(img)
        if dets is None:
            dets = np.zeros((0, 15), np.float32)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        tracks = states[shot_i]
        for det in dets:
            box = det[0:4]
            best, best_iou = None, IOU_MIN
            for tr in tracks:
                v = iou(box, tr["last_box"])
                if v > best_iou:
                    best, best_iou = tr, v
            patch = mouth_patch(gray, det)
            if best is None:
                tracks.append({
                    "boxes": [box],
                    "scores": [float(det[14])],
                    "last_box": box,
                    "mouth": [],
                    "last_patch": patch,
                })
            else:
                best["boxes"].append(box)
                best["scores"].append(float(det[14]))
                best["last_box"] = box
                if patch is not None and best["last_patch"] is not None:
                    best["mouth"].append(
                        float(np.mean(np.abs(patch - best["last_patch"])))
                    )
                best["last_patch"] = patch

    out = {"shots": []}
    for i, tracks in enumerate(states):
        rendered = []
        for tid, tr in enumerate(tracks):
            boxes = np.array(tr["boxes"], np.float32)
            med = np.median(boxes, axis=0)
            rendered.append({
                "id": tid,
                "box": {
                    "x": float(med[0]) * scale,
                    "y": float(med[1]) * scale,
                    "w": float(med[2]) * scale,
                    "h": float(med[3]) * scale,
                },
                "score": float(np.mean(tr["scores"])),
                "samples": len(tr["boxes"]),
                "mouthActivity": float(np.mean(tr["mouth"])) if tr["mouth"] else 0.0,
            })
        out["shots"].append({"shotIndex": i, "tracks": rendered})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Structural smoke in the container (loads the real model)**

```bash
docker compose exec worker-render sh -c '
  D=$(mktemp -d) && mkdir $D/frames &&
  echo "[{\"start\":0,\"end\":5}]" > $D/shots.json &&
  ffmpeg -nostdin -f lavfi -i color=black:size=640x360 -frames:v 1 $D/frames/frame-00001.jpg -y -loglevel error &&
  python3 /app/apps/worker/assets/reframe/detect_faces.py \
    --frames-dir $D/frames --shots $D/shots.json --fps 2 \
    --model /app/apps/worker/assets/reframe/face_detection_yunet_2023mar.onnx \
    --min-score 0.7 --source-width 1920 --source-height 1080 &&
  echo && rm -rf $D'
```

Expected output: `{"shots": [{"shotIndex": 0, "tracks": []}]}` - the detector loaded the vendored model and found no faces on a black frame. Any traceback here means the model file or cv2 install is broken - stop and fix before proceeding.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/assets/reframe/detect_faces.py
git commit -m "feat(reframe): YuNet detection sidecar with IoU tracks and mouth activity"
```

---

### Task 6: faces.ts - sidecar contract and invocation

**Files:**
- Create: `apps/worker/src/reframe/faces.ts`
- Test: `apps/worker/src/__tests__/reframe-faces.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Create `apps/worker/src/__tests__/reframe-faces.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseDetectorOutput } from "../reframe/faces";

const validTrack = {
  id: 0,
  box: { x: 100, y: 50, w: 200, h: 260 },
  score: 0.92,
  samples: 12,
  mouthActivity: 0.04,
};

describe("parseDetectorOutput", () => {
  it("parses a valid document", () => {
    const raw = JSON.stringify({
      shots: [
        { shotIndex: 0, tracks: [validTrack] },
        { shotIndex: 1, tracks: [] },
      ],
    });
    const parsed = parseDetectorOutput(raw, 2);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].tracks[0].box.w).toBe(200);
    expect(parsed[1].tracks).toEqual([]);
  });

  it("throws detector_invalid_json on non-JSON", () => {
    expect(() => parseDetectorOutput("not json", 1)).toThrow("detector_invalid_json");
  });

  it("throws when the shot count does not match", () => {
    const raw = JSON.stringify({ shots: [{ shotIndex: 0, tracks: [] }] });
    expect(() => parseDetectorOutput(raw, 2)).toThrow("detector_invalid_json");
  });

  it("throws on a track with a missing/invalid field", () => {
    const bad = { ...validTrack, box: { x: 1, y: 2, w: "wide", h: 4 } };
    const raw = JSON.stringify({ shots: [{ shotIndex: 0, tracks: [bad] }] });
    expect(() => parseDetectorOutput(raw, 1)).toThrow("detector_invalid_json");
  });

  it("throws on NaN smuggled through as null", () => {
    const bad = { ...validTrack, mouthActivity: null };
    const raw = JSON.stringify({ shots: [{ shotIndex: 0, tracks: [bad] }] });
    expect(() => parseDetectorOutput(raw, 1)).toThrow("detector_invalid_json");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/reframe-faces.test.ts"`
Expected: FAIL - cannot resolve `../reframe/faces`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/reframe/faces.ts`:

```typescript
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
```

- [ ] **Step 4: Run to verify pass**

Same command. Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/faces.ts apps/worker/src/__tests__/reframe-faces.test.ts
git commit -m "feat(reframe): sidecar invocation with strict output contract"
```

---

### Task 7: Layout plan (the decision core)

**Files:**
- Create: `apps/worker/src/reframe/plan.ts`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

Geometry cheat-sheet for a 1920x1080 source: `cropW = 608` (9:16 window, even-rounded), `tileW = 1216` (1080x960 tile at 9/8), `centerX = 656`, max single x = 1312, max tile x = 704.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/reframe-plan.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  buildCropPlan,
  cropWidthFor,
  evenClamp,
  planLayoutCounts,
  sliceCropPlan,
  tileWidthFor,
} from "../reframe/plan";
import type { CropPlan, FaceTrack, Shot, ShotTracks } from "../reframe/types";

const W = 1920;
const H = 1080;

function track(x: number, w: number, extra?: Partial<FaceTrack>): FaceTrack {
  return {
    id: 0,
    box: { x, y: 200, w, h: w * 1.3 },
    score: 0.9,
    samples: 10,
    mouthActivity: 0.05,
    ...extra,
  };
}

const oneShot: Shot[] = [{ start: 0, end: 30 }];
const withTracks = (tracks: FaceTrack[]): ShotTracks[] => [
  { shotIndex: 0, tracks },
];

describe("geometry helpers", () => {
  it("computes even crop and tile widths", () => {
    expect(cropWidthFor(1080)).toBe(608);
    expect(tileWidthFor(1080)).toBe(1216);
  });

  it("clamps into frame and rounds to even", () => {
    expect(evenClamp(-50, 608, W)).toBe(0);
    expect(evenClamp(5000, 608, W)).toBe(1312);
    expect(evenClamp(101, 608, W)).toBe(102);
  });
});

describe("buildCropPlan layouts", () => {
  it("screenshot 1 regression: a single off-center face gets a single face crop", () => {
    // face at 600..1000, center 800 -> window x = 800 - 304 = 496
    const plan = buildCropPlan(oneShot, withTracks([track(600, 400)]), W, H);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 496 }]);
  });

  it("screenshot 2 regression: a far-apart duet becomes a split, left on top", () => {
    // A center 275 -> tile x clamps to 0; B center 1645 -> clamps to 704
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(1570, 150, { id: 1 }), track(200, 150)]),
      W,
      H
    );
    expect(plan!.shots).toEqual([
      { start: 0, end: 30, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
    ]);
  });

  it("zero faces fall back to a centered window", () => {
    const plan = buildCropPlan(oneShot, withTracks([]), W, H);
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "center", x: 656 }]);
  });

  it("two close faces that fit one window stay single, centered on the pair", () => {
    // faces 700..850 and 950..1100: bbox 700..1100 = 400 <= 0.9*608
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(700, 150), track(950, 150, { id: 1 })]),
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 596 }]);
  });

  it("three faces with a clear dominant pair split on that pair", () => {
    const tiny = track(940, 60, { id: 2, mouthActivity: 0 });
    const plan = buildCropPlan(
      oneShot,
      withTracks([track(200, 300), tiny, track(1400, 300, { id: 1 })]),
      W,
      H
    );
    expect(plan!.shots[0].layout).toBe("split");
  });

  it("three similar faces with no dominant pair fall back to center", () => {
    const plan = buildCropPlan(
      oneShot,
      withTracks([
        track(100, 300),
        track(800, 300, { id: 1 }),
        track(1500, 300, { id: 2 }),
      ]),
      W,
      H
    );
    expect(plan!.shots[0]).toEqual({ start: 0, end: 30, layout: "center", x: 656 });
  });

  it("ignores 1-sample noise tracks", () => {
    const noise = track(1500, 200, { id: 1, samples: 1 });
    const plan = buildCropPlan(oneShot, withTracks([track(600, 400), noise]), W, H);
    expect(plan!.shots[0]).toEqual({ start: 0, end: 30, layout: "single", x: 496 });
  });

  it("returns null when the source is already 9:16 or narrower", () => {
    expect(buildCropPlan(oneShot, withTracks([]), 608, 1080)).toBeNull();
    expect(buildCropPlan([], [], W, H)).toBeNull();
  });
});

describe("adjacent-shot merging", () => {
  const twoShots: Shot[] = [
    { start: 0, end: 10 },
    { start: 10, end: 30 },
  ];

  it("merges same-layout shots with near-identical geometry, first x wins", () => {
    const plan = buildCropPlan(
      twoShots,
      [
        { shotIndex: 0, tracks: [track(600, 400)] },
        { shotIndex: 1, tracks: [track(620, 400)] }, // dx 20 < 4% of 1920
      ],
      W,
      H
    );
    expect(plan!.shots).toEqual([{ start: 0, end: 30, layout: "single", x: 496 }]);
  });

  it("keeps shots separate when the offset moves for real", () => {
    const plan = buildCropPlan(
      twoShots,
      [
        { shotIndex: 0, tracks: [track(600, 400)] },
        { shotIndex: 1, tracks: [track(1100, 400)] },
      ],
      W,
      H
    );
    expect(plan!.shots).toHaveLength(2);
  });
});

describe("sliceCropPlan (trim re-render)", () => {
  const plan: CropPlan = {
    version: 1,
    engine: "faces",
    source: { width: W, height: H },
    shots: [
      { start: 0, end: 12.4, layout: "single", x: 496 },
      { start: 12.4, end: 31, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
      { start: 31, end: 57.5, layout: "center", x: 656 },
    ],
  };

  it("re-windows shots to the trim range like sliceCues", () => {
    const sliced = sliceCropPlan(plan, 10, 40);
    expect(sliced!.shots).toEqual([
      { start: 0, end: 2.4000000000000004, layout: "single", x: 496 },
      { start: 2.4000000000000004, end: 21, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
      { start: 21, end: 30, layout: "center", x: 656 },
    ]);
  });

  it("returns null for an empty window or wrong version", () => {
    expect(sliceCropPlan(plan, 100, 120)).toBeNull();
    expect(sliceCropPlan({ ...plan, version: 2 as unknown as 1 }, 0, 10)).toBeNull();
  });
});

describe("planLayoutCounts", () => {
  it("counts layouts for telemetry", () => {
    const plan = buildCropPlan(oneShot, withTracks([track(600, 400)]), W, H);
    expect(planLayoutCounts(plan!)).toEqual({ single: 1, split: 0, center: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/reframe-plan.test.ts"`
Expected: FAIL - cannot resolve `../reframe/plan`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/reframe/plan.ts`:

```typescript
import type { CropPlan, FaceTrack, Shot, ShotLayout, ShotTracks } from "./types";

// Layout constants - tuned via fixtures, deliberately NOT env knobs (spec §7).
const FIT_MARGIN = 0.9; // face bbox must fit in 90% of the crop window
const DOMINANCE_LEAD = 1.5; // top-2 must each lead the 3rd by this factor
const MERGE_DX_FRAC = 0.04; // same-layout shots merge when |dx| < 4% of iw
const MIN_TRACK_SAMPLES = 2; // 1-sample tracks are detector noise
const W_AREA = 0.5;
const W_CENTER = 0.3;
const W_MOUTH = 0.2;

export function cropWidthFor(sourceHeight: number): number {
  return 2 * Math.round((sourceHeight * 9) / 16 / 2);
}

export function tileWidthFor(sourceHeight: number): number {
  return 2 * Math.round((sourceHeight * 9) / 8 / 2);
}

export function evenClamp(x: number, cropW: number, sourceWidth: number): number {
  const clamped = Math.min(Math.max(0, x), sourceWidth - cropW);
  return 2 * Math.round(clamped / 2);
}

export function dominance(
  t: FaceTrack,
  sourceWidth: number,
  sourceHeight: number
): number {
  const area = (t.box.w * t.box.h) / (sourceWidth * sourceHeight);
  const cx = t.box.x + t.box.w / 2;
  const centrality = 1 - Math.abs(cx - sourceWidth / 2) / (sourceWidth / 2);
  return (
    W_AREA * Math.min(1, area * 20) +
    W_CENTER * centrality +
    W_MOUTH * Math.min(1, t.mouthActivity * 10)
  );
}

export function buildCropPlan(
  shots: Shot[],
  tracksByShot: ShotTracks[],
  sourceWidth: number,
  sourceHeight: number
): CropPlan | null {
  if (shots.length === 0) return null;
  const cropW = cropWidthFor(sourceHeight);
  const tileW = tileWidthFor(sourceHeight);
  // Already vertical or narrower: nothing to reframe, let the legacy path run.
  if (cropW >= sourceWidth) return null;
  const centerX = evenClamp((sourceWidth - cropW) / 2, cropW, sourceWidth);
  const byIndex = new Map(tracksByShot.map((s) => [s.shotIndex, s.tracks]));

  const layouts = shots.map((shot, i): ShotLayout => {
    const tracks = (byIndex.get(i) ?? []).filter(
      (t) => t.samples >= MIN_TRACK_SAMPLES
    );
    if (tracks.length === 0) {
      return { start: shot.start, end: shot.end, layout: "center", x: centerX };
    }
    const minX = Math.min(...tracks.map((t) => t.box.x));
    const maxX = Math.max(...tracks.map((t) => t.box.x + t.box.w));
    if (maxX - minX <= FIT_MARGIN * cropW) {
      const x = evenClamp((minX + maxX) / 2 - cropW / 2, cropW, sourceWidth);
      return { start: shot.start, end: shot.end, layout: "single", x };
    }
    let pair = tracks;
    if (tracks.length > 2) {
      const scored = [...tracks].sort(
        (a, b) =>
          dominance(b, sourceWidth, sourceHeight) -
          dominance(a, sourceWidth, sourceHeight)
      );
      const third = dominance(scored[2], sourceWidth, sourceHeight);
      const clearLead =
        dominance(scored[0], sourceWidth, sourceHeight) >= DOMINANCE_LEAD * third &&
        dominance(scored[1], sourceWidth, sourceHeight) >= DOMINANCE_LEAD * third;
      if (!clearLead) {
        return { start: shot.start, end: shot.end, layout: "center", x: centerX };
      }
      pair = [scored[0], scored[1]];
    }
    const [left, right] = [...pair].sort(
      (a, b) => a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2)
    );
    return {
      start: shot.start,
      end: shot.end,
      layout: "split",
      top: { x: evenClamp(left.box.x + left.box.w / 2 - tileW / 2, tileW, sourceWidth) },
      bottom: {
        x: evenClamp(right.box.x + right.box.w / 2 - tileW / 2, tileW, sourceWidth),
      },
    };
  });

  return {
    version: 1,
    engine: "faces",
    source: { width: sourceWidth, height: sourceHeight },
    shots: mergeAdjacentLayouts(layouts, sourceWidth),
  };
}

/** Same layout + near-identical geometry -> one window; the FIRST shot's
 *  geometry wins so the virtual camera stays put on soft scene cuts. */
export function mergeAdjacentLayouts(
  shots: ShotLayout[],
  sourceWidth: number
): ShotLayout[] {
  const maxDx = MERGE_DX_FRAC * sourceWidth;
  const merged: ShotLayout[] = [];
  for (const shot of shots) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const same =
        (prev.layout === "center" && shot.layout === "center") ||
        (prev.layout === "single" &&
          shot.layout === "single" &&
          Math.abs(prev.x - shot.x) <= maxDx) ||
        (prev.layout === "split" &&
          shot.layout === "split" &&
          Math.abs(prev.top.x - shot.top.x) <= maxDx &&
          Math.abs(prev.bottom.x - shot.bottom.x) <= maxDx);
      if (same) {
        prev.end = shot.end;
        continue;
      }
    }
    merged.push({ ...shot });
  }
  return merged;
}

/** Re-window a stored plan to a [start, end] sub-range of the same clip
 *  (mirror of sliceCues). Null when nothing overlaps or version is unknown. */
export function sliceCropPlan(
  plan: CropPlan,
  start: number,
  end: number
): CropPlan | null {
  if (plan.version !== 1 || !(end > start)) return null;
  const shots = plan.shots
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({
      ...s,
      start: Math.max(0, s.start - start),
      end: Math.min(end - start, s.end - start),
    }));
  if (shots.length === 0) return null;
  return { ...plan, shots };
}

export function planLayoutCounts(
  plan: CropPlan
): Record<"single" | "split" | "center", number> {
  const counts = { single: 0, split: 0, center: 0 };
  for (const s of plan.shots) counts[s.layout] += 1;
  return counts;
}
```

- [ ] **Step 4: Run to verify pass**

Same command. Expected: all tests pass. If the split-vs-center dominance tests disagree with the implementation, adjust the FIXTURES' face sizes/mouth values, never weaken the constants silently - the constants are the product decision.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "feat(reframe): deterministic per-shot layout engine with merge and slice"
```

---

### Task 8: Filtergraph builder

**Files:**
- Create: `apps/worker/src/reframe/filtergraph.ts`
- Test: `apps/worker/src/__tests__/reframe-filtergraph.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/reframe-filtergraph.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildFiltergraph, piecewiseX } from "../reframe/filtergraph";
import type { CropPlan } from "../reframe/types";

const base = (shots: CropPlan["shots"]): CropPlan => ({
  version: 1,
  engine: "faces",
  source: { width: 1920, height: 1080 },
  shots,
});

describe("piecewiseX", () => {
  it("renders a single segment as a bare number", () => {
    expect(piecewiseX([{ end: 30, x: 496 }])).toBe("496");
  });

  it("nests if(lt(t,end)) with 2-decimal times, last x as the else", () => {
    expect(
      piecewiseX([
        { end: 12.4, x: 496 },
        { end: 31, x: 656 },
        { end: 57.5, x: 412 },
      ])
    ).toBe("if(lt(t,12.40),496,if(lt(t,31.00),656,412))");
  });
});

describe("buildFiltergraph", () => {
  it("stays -vf for a single static shot", () => {
    expect(buildFiltergraph(base([{ start: 0, end: 30, layout: "single", x: 496 }])))
      .toEqual({
        kind: "vf",
        graph: "crop=w=608:h=ih:x='496':y=0,scale=1080:1920",
      });
  });

  it("appends the ass snippet in vf mode", () => {
    const spec = buildFiltergraph(
      base([{ start: 0, end: 30, layout: "center", x: 656 }]),
      "ass=filename=/tmp/x.ass"
    );
    expect(spec.graph).toBe(
      "crop=w=608:h=ih:x='656':y=0,scale=1080:1920,ass=filename=/tmp/x.ass"
    );
  });

  it("uses a piecewise x for multiple non-split shots", () => {
    const spec = buildFiltergraph(
      base([
        { start: 0, end: 12.4, layout: "single", x: 496 },
        { start: 12.4, end: 30, layout: "center", x: 656 },
      ])
    );
    expect(spec).toEqual({
      kind: "vf",
      graph: "crop=w=608:h=ih:x='if(lt(t,12.40),496,656)':y=0,scale=1080:1920",
    });
  });

  it("builds the full complex graph for split shots", () => {
    const spec = buildFiltergraph(
      base([
        { start: 0, end: 12.4, layout: "single", x: 496 },
        { start: 12.4, end: 31, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
        { start: 31, end: 57.5, layout: "center", x: 656 },
      ])
    );
    expect(spec.kind).toBe("complex");
    expect(spec.graph).toBe(
      [
        "[0:v]split=3[b0][t0][m0]",
        "[b0]crop=w=608:h=ih:x='if(lt(t,12.40),496,if(lt(t,31.00),656,656))':y=0,scale=1080:1920[base]",
        "[t0]crop=w=1216:h=ih:x='if(lt(t,12.40),0,if(lt(t,31.00),0,0))':y=0,scale=1080:960[top]",
        "[m0]crop=w=1216:h=ih:x='if(lt(t,12.40),704,if(lt(t,31.00),704,704))':y=0,scale=1080:960[bottom]",
        "[base][top]overlay=x=0:y=0:enable='between(t,12.40,31.00)'[o1]",
        "[o1][bottom]overlay=x=0:y=960:enable='between(t,12.40,31.00)'[vout]",
      ].join(";")
    );
  });

  it("chains the ass snippet after the overlays in complex mode", () => {
    const spec = buildFiltergraph(
      base([{ start: 0, end: 20, layout: "split", top: { x: 100 }, bottom: { x: 600 } }]),
      "ass=filename=/tmp/x.ass"
    );
    expect(spec.kind).toBe("complex");
    expect(spec.graph.endsWith("[o2];[o2]ass=filename=/tmp/x.ass[vout]")).toBe(true);
    expect(spec.graph).toContain("overlay=x=0:y=960:enable='between(t,0.00,20.00)'[o2]");
  });

  it("joins multiple split windows with + in enable", () => {
    const spec = buildFiltergraph(
      base([
        { start: 0, end: 10, layout: "split", top: { x: 0 }, bottom: { x: 704 } },
        { start: 10, end: 20, layout: "single", x: 496 },
        { start: 20, end: 30, layout: "split", top: { x: 100 }, bottom: { x: 600 } },
      ])
    );
    expect(spec.graph).toContain(
      "enable='between(t,0.00,10.00)+between(t,20.00,30.00)'"
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/reframe-filtergraph.test.ts"`
Expected: FAIL - cannot resolve `../reframe/filtergraph`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/reframe/filtergraph.ts`:

```typescript
import type { CropPlan, FilterSpec, ShotLayout } from "./types";
import { cropWidthFor, evenClamp, tileWidthFor } from "./plan";

type SplitLayout = Extract<ShotLayout, { layout: "split" }>;

const fmt = (n: number) => n.toFixed(2);

/** Piecewise-constant x(t) over consecutive windows; the last x is the else
 *  branch, so the expression is total for every t. x values are integers. */
export function piecewiseX(segments: Array<{ end: number; x: number }>): string {
  if (segments.length === 0) throw new Error("piecewiseX: empty");
  let expr = String(segments[segments.length - 1].x);
  for (let i = segments.length - 2; i >= 0; i--) {
    expr = `if(lt(t,${fmt(segments[i].end)}),${segments[i].x},${expr})`;
  }
  return expr;
}

/**
 * Compiles a CropPlan (+ optional ass snippet) into a single-pass filter.
 * No split shots -> plain -vf chain. Any split shot -> -filter_complex with
 * two time-enabled overlay tiles; the caller must map "[vout]" + audio.
 */
export function buildFiltergraph(plan: CropPlan, assSnippet?: string): FilterSpec {
  const cropW = cropWidthFor(plan.source.height);
  const tileW = tileWidthFor(plan.source.height);
  const centerX = evenClamp(
    (plan.source.width - cropW) / 2,
    cropW,
    plan.source.width
  );
  // Type-guard filter: plain .filter() would not narrow ShotLayout, and the
  // tile-geometry reads below need the split variant.
  const splits = plan.shots.filter(
    (s): s is SplitLayout => s.layout === "split"
  );

  const baseX = piecewiseX(
    plan.shots.map((s) => ({ end: s.end, x: s.layout === "split" ? centerX : s.x }))
  );
  const baseChain = `crop=w=${cropW}:h=ih:x='${baseX}':y=0,scale=1080:1920`;

  if (splits.length === 0) {
    const ass = assSnippet ? `,${assSnippet}` : "";
    return { kind: "vf", graph: `${baseChain}${ass}` };
  }

  // Outside split windows the overlays are disabled, so tile x values there
  // are irrelevant - carry the nearest split geometry to keep expressions total.
  let lastTop = splits[0].top.x;
  let lastBottom = splits[0].bottom.x;
  const topSegs: Array<{ end: number; x: number }> = [];
  const botSegs: Array<{ end: number; x: number }> = [];
  for (const s of plan.shots) {
    if (s.layout === "split") {
      lastTop = s.top.x;
      lastBottom = s.bottom.x;
    }
    topSegs.push({ end: s.end, x: lastTop });
    botSegs.push({ end: s.end, x: lastBottom });
  }
  const enable = splits
    .map((s) => `between(t,${fmt(s.start)},${fmt(s.end)})`)
    .join("+");

  const chains = [
    `[0:v]split=3[b0][t0][m0]`,
    `[b0]${baseChain}[base]`,
    `[t0]crop=w=${tileW}:h=ih:x='${piecewiseX(topSegs)}':y=0,scale=1080:960[top]`,
    `[m0]crop=w=${tileW}:h=ih:x='${piecewiseX(botSegs)}':y=0,scale=1080:960[bottom]`,
    `[base][top]overlay=x=0:y=0:enable='${enable}'[o1]`,
    assSnippet
      ? `[o1][bottom]overlay=x=0:y=960:enable='${enable}'[o2]`
      : `[o1][bottom]overlay=x=0:y=960:enable='${enable}'[vout]`,
  ];
  if (assSnippet) chains.push(`[o2]${assSnippet}[vout]`);
  return { kind: "complex", graph: chains.join(";") };
}
```

- [ ] **Step 4: Run to verify pass**

Same command. Expected: all tests pass (exact string matches).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/reframe/filtergraph.ts apps/worker/src/__tests__/reframe-filtergraph.test.ts
git commit -m "feat(reframe): CropPlan to single-pass ffmpeg filtergraph compiler"
```

---

### Task 9: cut.ts - FilterSpec support

**Files:**
- Modify: `apps/worker/src/processors/cut.ts`
- Test: `apps/worker/src/__tests__/cut-args.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/cut-args.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildCutArgs } from "../processors/cut";

const OUT = "/tmp/out.mp4";
const LEGACY_CROP = "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920";

describe("buildCutArgs", () => {
  it("keeps the legacy center crop when no FilterSpec is given", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT);
    expect(args).toContain("-vf");
    expect(args[args.indexOf("-vf") + 1]).toBe(LEGACY_CROP);
    expect(args).not.toContain("-filter_complex");
  });

  it("appends the extra filter to the legacy crop (subtitles path)", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT, "ass=x.ass");
    expect(args[args.indexOf("-vf") + 1]).toBe(`${LEGACY_CROP},ass=x.ass`);
  });

  it("uses the FilterSpec graph verbatim in vf mode, ignoring extraFilter", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT, "ass=x.ass", {
      kind: "vf",
      graph: "crop=w=608:h=ih:x='496':y=0,scale=1080:1920,ass=x.ass",
    });
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "crop=w=608:h=ih:x='496':y=0,scale=1080:1920,ass=x.ass"
    );
  });

  it("switches to -filter_complex with explicit maps in complex mode", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT, undefined, {
      kind: "complex",
      graph: "[0:v]split=3[a][b][c]",
    });
    expect(args).toContain("-filter_complex");
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[0:v]split=3[a][b][c]");
    const firstMap = args.indexOf("-map");
    expect(args[firstMap + 1]).toBe("[vout]");
    expect(args[args.indexOf("-map", firstMap + 1) + 1]).toBe("0:a?");
    expect(args).not.toContain("-vf");
  });

  it("always seeks before the input and encodes with the house settings", () => {
    const args = buildCutArgs("/tmp/in.mp4", 10, 40, OUT);
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
    expect(args[args.length - 1]).toBe("-y");
    expect(args[args.length - 2]).toBe(OUT);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/cut-args.test.ts"`
Expected: FAIL - `buildCutArgs` is not exported.

- [ ] **Step 3: Refactor cut.ts**

Replace the whole of `apps/worker/src/processors/cut.ts` with:

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { Highlight } from "@clipclap/shared";
import type { FilterSpec } from "../reframe/types";

const execFileAsync = promisify(execFile);

export interface CutResult {
  highlight: Highlight;
  clipPath: string;
}

/**
 * Pure argv builder so the filter wiring is unit-testable. When a FilterSpec
 * is present it wins outright - its graph already contains the subtitle
 * snippet, so extraFilter is ignored. Complex specs must label their video
 * output [vout].
 */
export function buildCutArgs(
  videoPath: string,
  start: number,
  end: number,
  outPath: string,
  extraFilter?: string,
  filterSpec?: FilterSpec | null
): string[] {
  const head = ["-nostdin", "-ss", String(start), "-to", String(end), "-i", videoPath];
  const encode = [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
  ];
  if (filterSpec?.kind === "complex") {
    return [
      ...head,
      "-filter_complex", filterSpec.graph,
      "-map", "[vout]",
      "-map", "0:a?",
      ...encode,
      outPath,
      "-y",
    ];
  }
  const vf = filterSpec
    ? filterSpec.graph
    : extraFilter
      ? `${buildCropFilter()},${extraFilter}`
      : buildCropFilter();
  return [...head, "-vf", vf, ...encode, outPath, "-y"];
}

export async function cutClips(
  videoPath: string,
  highlights: Highlight[],
  extraFilter?: string,
  filterSpec?: FilterSpec | null
): Promise<CutResult[]> {
  const results: CutResult[] = [];

  for (const highlight of highlights) {
    const clipPath = join(tmpdir(), `clipclap-clip-${randomUUID()}.mp4`);
    await execFileAsync(
      "ffmpeg",
      buildCutArgs(videoPath, highlight.start, highlight.end, clipPath, extraFilter, filterSpec)
    );
    results.push({ highlight, clipPath });
  }

  return results;
}

export async function trimClipFile(
  videoPath: string,
  start: number,
  end: number
): Promise<string> {
  const clipPath = join(tmpdir(), `clipclap-trim-${randomUUID()}.mp4`);

  await execFileAsync("ffmpeg", [
    "-ss", String(start),
    "-to", String(end),
    "-i", videoPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    clipPath,
    "-y",
  ]);

  return clipPath;
}

/**
 * Builds an FFmpeg filter to crop video to 9:16 vertical format.
 * Centers the crop on the original video. Legacy fallback path - kept
 * verbatim as the REFRAME_ENGINE=off behavior and the failure fallback.
 */
function buildCropFilter(): string {
  return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920";
}
```

- [ ] **Step 4: Run cut-args plus the whole existing suite (regression)**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src"`
Expected: everything passes (the render stage tests exercise `cutClips` mocks - signature stays backward compatible).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors/cut.ts apps/worker/src/__tests__/cut-args.test.ts
git commit -m "feat(reframe): cutClips accepts a prebuilt FilterSpec, legacy path intact"
```

---

### Task 10: computeCropPlan orchestrator

**Files:**
- Create: `apps/worker/src/reframe/index.ts`

No new unit test file: every branch below is thin glue over already-tested pieces plus child processes; the smoke in Task 12 exercises it end to end. Keep it exactly this small.

- [ ] **Step 1: Implement**

Create `apps/worker/src/reframe/index.ts`:

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import { loadReframeConfig, type ReframeConfig } from "./config";
import { detectShots } from "./shots";
import { detectFaces } from "./faces";
import { buildCropPlan } from "./plan";
import type { CropPlan } from "./types";

const execFileAsync = promisify(execFile);

export type ReframeFallbackReason =
  | "scdet_failed"
  | "detector_failed"
  | "detector_invalid_json"
  | "timeout"
  | "plan_empty";

export interface ReframeResult {
  plan: CropPlan | null;
  fallbackReason?: ReframeFallbackReason;
  detectMs: number;
  shotCount: number;
}

// execFile kills on timeout with error.killed=true
function isTimeout(error: unknown): boolean {
  return Boolean((error as { killed?: boolean } | null)?.killed);
}

async function probeDimensions(
  path: string
): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=s=x:p=0",
    path,
  ]);
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

/**
 * Shots -> faces -> layout, under one wall-clock budget (cfg.maxDetectSec).
 * Never throws: every failure returns plan:null with a machine-readable
 * reason, and the caller falls back to the legacy center crop (spec §8).
 */
export async function computeCropPlan(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig = loadReframeConfig()
): Promise<ReframeResult> {
  const startedAt = Date.now();
  const deadline = startedAt + cfg.maxDetectSec * 1000;
  const remaining = () => Math.max(1000, deadline - Date.now());
  const fail = (
    fallbackReason: ReframeFallbackReason,
    shotCount: number
  ): ReframeResult => ({
    plan: null,
    fallbackReason,
    shotCount,
    detectMs: Date.now() - startedAt,
  });

  let shotCount = 0;
  try {
    const { width, height } = await probeDimensions(sourcePath);
    const shots = await detectShots(sourcePath, startSec, endSec, cfg, remaining());
    shotCount = shots.length;
    let tracks;
    try {
      tracks = await detectFaces(
        sourcePath, startSec, endSec, shots, width, height, cfg, remaining()
      );
    } catch (error) {
      if (isTimeout(error)) return fail("timeout", shotCount);
      if ((error as Error).message === "detector_invalid_json") {
        return fail("detector_invalid_json", shotCount);
      }
      return fail("detector_failed", shotCount);
    }
    const plan = buildCropPlan(shots, tracks, width, height);
    if (!plan) return fail("plan_empty", shotCount);
    return { plan, shotCount, detectMs: Date.now() - startedAt };
  } catch (error) {
    return fail(isTimeout(error) ? "timeout" : "scdet_failed", shotCount);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/reframe/index.ts
git commit -m "feat(reframe): computeCropPlan orchestrator with deadline and fallback reasons"
```

---

### Task 11: render.ts integration (clips + trim)

**Files:**
- Modify: `apps/worker/src/stages/render.ts`

- [ ] **Step 1: Add imports**

In `apps/worker/src/stages/render.ts`, extend the imports block:

```typescript
import { computeCropPlan } from "../reframe";
import { loadReframeConfig } from "../reframe/config";
import { buildFiltergraph } from "../reframe/filtergraph";
import { planLayoutCounts, sliceCropPlan } from "../reframe/plan";
import type { CropPlan, FilterSpec } from "../reframe/types";
```

- [ ] **Step 2: Wire the clips path**

In `renderClips`, before the `for (const highlight of highlights)` loop add:

```typescript
    const reframeCfg = loadReframeConfig();
    const reframeChecks: Array<{
      shotCount: number;
      detectMs: number;
      layouts?: Record<"single" | "split" | "center", number>;
      fallbackReason?: string;
    }> = [];
```

Inside the loop, replace:

```typescript
      const [cutResult] = await cutClips(
        sourcePath,
        [highlight],
        assFilter?.filter
      );
```

with:

```typescript
      // Smart reframe: per-shot face-aware crop (spec 2026-07-24). Any
      // failure degrades to the legacy center crop - never fails the render.
      let filterSpec: FilterSpec | null = null;
      let cropPlan: CropPlan | null = null;
      if (reframeCfg.engine === "faces") {
        const reframe = await computeCropPlan(
          sourcePath,
          highlight.start,
          highlight.end,
          reframeCfg
        );
        cropPlan = reframe.plan;
        if (reframe.plan) {
          filterSpec = buildFiltergraph(reframe.plan, assFilter?.filter);
        } else {
          console.warn(
            `[render] reframe fallback on job ${payload.jobId}: ${reframe.fallbackReason}`
          );
        }
        reframeChecks.push({
          shotCount: reframe.shotCount,
          detectMs: reframe.detectMs,
          ...(reframe.plan ? { layouts: planLayoutCounts(reframe.plan) } : {}),
          ...(reframe.fallbackReason
            ? { fallbackReason: reframe.fallbackReason }
            : {}),
        });
      }
      const [cutResult] = await cutClips(
        sourcePath,
        [highlight],
        assFilter?.filter,
        filterSpec
      );
```

In the `prisma.clip.create` call add after `subtitleTrack`:

```typescript
          cropPlan: cropPlan
            ? (cropPlan as unknown as Prisma.InputJsonValue)
            : undefined,
```

In the final `prisma.job.update`, extend `renderManifest`:

```typescript
        renderManifest: {
          mode: "clips",
          clipsGenerated,
          clipKeys,
          renderChecks,
          reframe: {
            engine: reframeCfg.engine,
            checks: reframeChecks,
          },
        } as Prisma.InputJsonValue,
```

- [ ] **Step 3: Wire the trim path**

In `renderTrim`, first declare the plan variable next to the existing `let finalPath: string;` (it must be in scope for the closing `prisma.clip.update`):

```typescript
    let finalPath: string;
    let slicedPlan: CropPlan | null = null;
```

Then, in the `if (cleanSource) { ... }` branch, replace:

```typescript
      const [cutResult] = await cutClips(
        sourcePath,
        [
          {
            start: payload.sourceStart!,
            end: payload.sourceEnd!,
            title: "edit",
            reason: "re-render",
          },
        ],
        assFilter?.filter
      );
```

with:

```typescript
      // Reuse the stored crop plan re-windowed to the trim range (clip-relative,
      // exactly like sliceCues) so trims keep the face-aware framing.
      const reframeCfg = loadReframeConfig();
      let filterSpec: FilterSpec | null = null;
      if (reframeCfg.engine === "faces") {
        const clipRow = await prisma.clip.findUnique({
          where: { id: payload.clipId },
          select: { cropPlan: true },
        });
        if (clipRow?.cropPlan) {
          slicedPlan = sliceCropPlan(
            clipRow.cropPlan as unknown as CropPlan,
            payload.start,
            payload.end
          );
          if (slicedPlan) {
            // assFilter is null when subtitles are off, so this composes correctly
            filterSpec = buildFiltergraph(slicedPlan, assFilter?.filter);
          }
        }
      }
      const [cutResult] = await cutClips(
        sourcePath,
        [
          {
            start: payload.sourceStart!,
            end: payload.sourceEnd!,
            title: "edit",
            reason: "re-render",
          },
        ],
        assFilter?.filter,
        filterSpec
      );
```

And in the closing `prisma.clip.update` of `renderTrim`, add after `subtitleTrack`:

```typescript
        cropPlan: slicedPlan
          ? (slicedPlan as unknown as Prisma.InputJsonValue)
          : undefined,
```

- [ ] **Step 4: Full suite + typecheck**

```bash
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"
```

Expected: all green. The existing render stage tests must still pass with `REFRAME_ENGINE` unset (engine defaults to `off`, so the new code path is dormant).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/stages/render.ts
git commit -m "feat(reframe): render integration - clips, trim reuse, manifest telemetry"
```

---

### Task 12: End-to-end smoke and rollout

**Files:**
- Modify: `.env` (live, NOT committed)

- [ ] **Step 1: Sanity-run the orchestrator against a real source in the container**

Pick any downloaded source (or a small test mp4) and run a one-off script:

Note: tsx resolves relative imports against the SCRIPT's directory, so a script in /tmp must import by absolute path.

```bash
docker compose exec worker-render sh -c 'cd /app/apps/worker && cat > /tmp/smoke-reframe.ts <<"EOF"
import { computeCropPlan } from "/app/apps/worker/src/reframe";
import { loadReframeConfig } from "/app/apps/worker/src/reframe/config";
import { buildFiltergraph } from "/app/apps/worker/src/reframe/filtergraph";

async function main() {
  const [src, start, end] = process.argv.slice(2);
  const cfg = { ...loadReframeConfig(), engine: "faces" as const };
  const r = await computeCropPlan(src, Number(start), Number(end), cfg);
  console.log(JSON.stringify(r, null, 2));
  if (r.plan) console.log(buildFiltergraph(r.plan).graph);
}
main();
EOF
npx tsx /tmp/smoke-reframe.ts /tmp/<some-source>.mp4 0 60 && rm /tmp/smoke-reframe.ts'
```

Expected: a JSON ReframeResult with shots and layouts, and a printable filtergraph. On a talking-head video expect `single` layouts; verify `detectMs` is well under 30000.

- [ ] **Step 2: Enable the engine on the live env**

In `/srv/dev/clipclap.io/.env` set `REFRAME_ENGINE=faces` (add REFRAME_ lines mirroring `.env.example`), then restart the render worker only:

```bash
docker compose restart worker-render
```

- [ ] **Step 3: Real-upload regression (owner-driven)**

The owner re-uploads the podcast video that produced both screenshots. Verify:
- close-up shots render as face-centered `single` (screenshot 1 case),
- the wide two-person shot renders as a split stack showing BOTH people (screenshot 2 case),
- subtitles are intact and positioned as before,
- `renderChecks` duration/skew warnings stay green,
- `Job.renderManifest.reframe` shows layouts and no fallbackReason,
- `Clip.cropPlan` is populated.

- [ ] **Step 4: Watch-items to report**

Report fallbackReason frequencies and layout counts to the owner after the first few jobs. Known acceptable v1 tradeoffs: captions overlay the bottom split tile; within-shot face drift is not followed; ordering in split is by source position, not by who speaks.
