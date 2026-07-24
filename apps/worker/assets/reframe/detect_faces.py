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
