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

EDGE_SAMPLE_MAX = 24     # frames fed to the median edge map
BORDER_CANDIDATES = 12   # strongest projection peaks kept per axis
MIN_RECT_PX = 16         # a rectangle thinner than this is noise
FACE_MARGIN_FRAC = 0.02  # rect must clear the face by this much of frame width

# Measured on a 55-minute CS2 VOD, 2026-08-02: 26 true detections scored
# 5.65-8.84, the strongest false candidate scored 1.54, and every threshold
# in 3.0-5.0 gave identical output. 4.0 is the middle of that empty corridor.
# One streamer, one OBS layout, one video - the corridor is real but narrow
# evidence. Re-measure before trusting it on a second source shape.
CAM_EDGE_MIN = 4.0


def median_edge_map(grays):
    """Per-pixel MEDIAN Sobel magnitude across frames.

    Median, not mean: moving game content contributes a strong edge in only
    some frames and is suppressed, while a static compositing border survives.
    """
    xs, ys = [], []
    for g in grays:
        if g is None:
            continue
        xs.append(np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)))
        ys.append(np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)))
    if not xs:
        return None, None
    return np.median(np.stack(xs), axis=0), np.median(np.stack(ys), axis=0)


def _peaks(proj, limit):
    med = float(np.median(proj))
    out = []
    for i in range(1, len(proj) - 1):
        if proj[i] > med and proj[i] >= proj[i - 1] and proj[i] >= proj[i + 1]:
            out.append(i)
    out.sort(key=lambda i: -float(proj[i]))
    return out[:limit]


def find_cam_rect(vx, hy, face, W, H, pip_max_frac, edge_min=CAM_EDGE_MIN):
    """Face-anchored rectangle search scored by border edge energy.

    face is (x, y, w, h) in the SAME pixel space as vx/hy. Returns a dict with
    x, y, w, h, score in that space, or None.

    pip_max_frac caps the inset extent on BOTH axes - width against W and
    height against H. Capping width alone is not enough: the search would then
    happily return the inset's true width run down the whole frame, a box whose
    left, top and bottom sides all lie on the canvas and are therefore skipped,
    leaving it to win on a single real border.

    Selection is LARGEST AREA among candidates clearing edge_min, tie-broken on
    score - not the highest score. Each border is a mean over the rectangle's
    own span, so scoring highest rewards shrinking inward to exclude the weakest
    part of a border; largest-area removes that incentive, and the height cap
    plus min-of-sides keeps "largest" from running away.
    """
    if vx is None or hy is None:
        return None
    gmean = (float(np.mean(vx)) + float(np.mean(hy))) / 2.0
    if gmean <= 1e-6:
        return None
    fx, fy, fw, fh = face
    margin = FACE_MARGIN_FRAC * W
    need_x0, need_y0 = fx - margin, fy - margin
    need_x1, need_y1 = fx + fw + margin, fy + fh + margin
    face_area = max(1.0, fw * fh)
    max_w = pip_max_frac * W
    max_h = pip_max_frac * H

    xs = sorted(set([0, W] + _peaks(vx.sum(axis=0), BORDER_CANDIDATES)))
    ys = sorted(set([0, H] + _peaks(hy.sum(axis=1), BORDER_CANDIDATES)))

    best, best_key = None, None
    for x0 in xs:
        if x0 > need_x0:
            continue
        for x1 in xs:
            if x1 < need_x1 or x1 - x0 < MIN_RECT_PX or x1 - x0 > max_w:
                continue
            for y0 in ys:
                if y0 > need_y0:
                    continue
                for y1 in ys:
                    if y1 < need_y1 or y1 - y0 < MIN_RECT_PX or y1 - y0 > max_h:
                        continue
                    if (x1 - x0) * (y1 - y0) < 4.0 * face_area:
                        continue
                    # A side lying ON the canvas edge is skipped, not scored.
                    # Sobel uses BORDER_REFLECT_101, so column 0 and row 0 are
                    # identically zero - the outermost pixels cannot carry edge
                    # energy. Scoring them would make a corner-flush inset (the
                    # common stream layout) permanently undetectable. The canvas
                    # edge is a real border the compositor clipped against.
                    sides = []
                    if x0 > 0:
                        sides.append(float(np.mean(vx[y0:y1, x0])))
                    if x1 < W:
                        sides.append(float(np.mean(vx[y0:y1, x1 - 1])))
                    if y0 > 0:
                        sides.append(float(np.mean(hy[y0, x0:x1])))
                    if y1 < H:
                        sides.append(float(np.mean(hy[y1 - 1, x0:x1])))
                    if not sides:
                        continue
                    # MINIMUM, not mean: one weak side must reject the
                    # rectangle rather than be averaged into acceptance.
                    score = min(sides) / gmean
                    if score < edge_min:
                        continue
                    key = ((x1 - x0) * (y1 - y0), score)
                    if best_key is None or key > best_key:
                        best_key = key
                        best = {"x": x0, "y": y0, "w": x1 - x0,
                                "h": y1 - y0, "score": score}
    return best


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
    ap.add_argument("--face-small-frac", type=float, default=0.06)
    ap.add_argument("--pip-max-frac", type=float, default=0.50)
    ap.add_argument("--pip-edge-min", type=float, default=CAM_EDGE_MIN)
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
    det_w = det_h = 0  # detection-space frame size, set from the first frame
    states = [[] for _ in shots]  # per-shot list of track dicts
    edge_frames = []  # grayscales fed to the median edge map, capped below
    edge_vx = edge_hy = None

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
            det_w, det_h = w, h
        detector.setInputSize((w, h))
        _, dets = detector.detect(img)
        if dets is None:
            dets = np.zeros((0, 15), np.float32)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # The cap lives HERE, in the caller: median_edge_map stacks every frame
        # it is handed (44 MB and 240 ms at 24 frames) and has no bound itself.
        if len(edge_frames) < EDGE_SAMPLE_MAX:
            edge_frames.append(gray)
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
        # Gate: only a SMALL dominant face can be a webcam inset. Podcasts and
        # facecams never reach median_edge_map, so they pay nothing for this.
        rect = None
        if rendered:
            dom = max(rendered, key=lambda t: t["samples"])
            if dom["box"]["w"] <= args.face_small_frac * args.source_width:
                if edge_vx is None:
                    edge_vx, edge_hy = median_edge_map(edge_frames)
                # Boxes are rendered in SOURCE pixels; the search runs in
                # detection pixels, and the rect is scaled back out again.
                face = (dom["box"]["x"] / scale, dom["box"]["y"] / scale,
                        dom["box"]["w"] / scale, dom["box"]["h"] / scale)
                r = find_cam_rect(edge_vx, edge_hy, face, det_w, det_h,
                                  args.pip_max_frac, args.pip_edge_min)
                if r is not None:
                    rect = {"x": r["x"] * scale, "y": r["y"] * scale,
                            "w": r["w"] * scale, "h": r["h"] * scale,
                            "score": r["score"]}
        out["shots"].append({"shotIndex": i, "tracks": rendered, "camRect": rect})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
