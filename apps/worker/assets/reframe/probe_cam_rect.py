#!/usr/bin/env python3
"""Autopsy for find_cam_rect: WHY does a known-true cam rect fail?

Replicates the production extraction exactly (fps=2, scale=640:-2, median
Sobel over up to 24 frames), then walks the constraint chain for a hand
labeled ground-truth rect and face, both given at SOURCE scale.

This tool produced the baseline measurements in
docs/superpowers/specs/2026-08-19-stream-reframe-v2.md section 2 (strogo's
margin overshoot, tox's crowded peaks and borderless sides) and the D1-D3
acceptance figures in section 5, task A.

  python3 probe_cam_rect.py --video V --start S --end E \
      --gt x,y,w,h --face x,y,w,h --source-width W [--edge-min 4.0]
"""
import argparse, os, subprocess, sys, tempfile
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from detect_faces import (
    median_edge_map, _peaks, find_cam_rect,
    BORDER_CANDIDATES, MIN_RECT_PX, EDGE_SAMPLE_MAX,
)


def rect(s):
    x, y, w, h = [float(v) for v in s.split(",")]
    return x, y, w, h


ap = argparse.ArgumentParser()
ap.add_argument("--video", required=True)
ap.add_argument("--start", type=float, required=True)
ap.add_argument("--end", type=float, required=True)
ap.add_argument("--gt", required=True, help="cam rect at SOURCE scale x,y,w,h")
ap.add_argument("--face", required=True, help="face box at SOURCE scale x,y,w,h")
ap.add_argument("--source-width", type=float, required=True)
ap.add_argument("--edge-min", type=float, default=4.0)
ap.add_argument("--pip-max-frac", type=float, default=0.5)
args = ap.parse_args()

with tempfile.TemporaryDirectory() as td:
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", str(args.start),
         "-to", str(args.end), "-i", args.video,
         "-vf", "fps=2,scale=640:-2", "-q:v", "5",
         os.path.join(td, "f-%05d.jpg"), "-y"],
        check=True,
    )
    files = sorted(os.listdir(td))[:EDGE_SAMPLE_MAX]
    grays = [
        cv2.cvtColor(cv2.imread(os.path.join(td, f)), cv2.COLOR_BGR2GRAY)
        for f in files
    ]

H, W = grays[0].shape
sc = W / args.source_width
gx, gy, gw, gh = [v * sc for v in rect(args.gt)]
fx, fy, fw, fh = [v * sc for v in rect(args.face)]
print(f"det space {W}x{H}, {len(grays)} frames, scale {sc:.4f}")
print(f"GT rect  det: x={gx:.0f} y={gy:.0f} w={gw:.0f} h={gh:.0f}")
print(f"face     det: x={fx:.0f} y={fy:.0f} w={fw:.0f} h={fh:.0f}")

vx, hy = median_edge_map(grays)
gmean = (float(np.mean(vx)) + float(np.mean(hy))) / 2.0
print(f"gmean={gmean:.3f}")

xs = sorted(set([0, W] + _peaks(vx.sum(axis=0), BORDER_CANDIDATES)))
ys = sorted(set([0, H] + _peaks(hy.sum(axis=1), BORDER_CANDIDATES)))
print(f"x peaks ({len(xs)}): {xs}")
print(f"y peaks ({len(ys)}): {ys}")


def near(peaks, v, tol=4):
    hits = [p for p in peaks if abs(p - v) <= tol]
    return hits if hits else "MISSING"


print(f"GT x0={gx:.0f} in peaks(+-4): {near(xs, gx)}   GT x1={gx+gw:.0f}: {near(xs, gx+gw)}")
print(f"GT y0={gy:.0f} in peaks(+-4): {near(ys, gy)}   GT y1={gy+gh:.0f}: {near(ys, gy+gh)}")

# D1, 2026-08-19: containment margin removed. need_* now equal the face box
# exactly - no more FACE_MARGIN_FRAC padding (that constant no longer
# exists in detect_faces.py; its anti-degenerate job moved to selection).
ok = lambda b: "OK" if b else "FAIL"
print(
    f"containment (D1, no margin): need x0<={fx:.1f} (gt {gx:.0f} {ok(gx<=fx)}), "
    f"x1>={fx+fw:.1f} (gt {gx+gw:.0f} {ok(gx+gw>=fx+fw)}), "
    f"y0<={fy:.1f} (gt {gy:.0f} {ok(gy<=fy)}), "
    f"y1>={fy+fh:.1f} (gt {gy+gh:.0f} {ok(gy+gh>=fy+fh)})"
)
print(
    f"size caps: w {gw:.0f} <= {args.pip_max_frac*W:.0f} {ok(gw<=args.pip_max_frac*W)}, "
    f"h {gh:.0f} <= {args.pip_max_frac*H:.0f} {ok(gh<=args.pip_max_frac*H)}, "
    f"min px {MIN_RECT_PX}"
)
# D2, 2026-08-19: area floor relaxed 4x -> 1.5x face area.
fa = max(1.0, fw * fh)
print(f"area vs face: rect {gw*gh:.0f} >= 1.5*face {1.5*fa:.0f} {ok(gw*gh>=1.5*fa)}")

x0i, y0i = int(round(gx)), int(round(gy))
x1i, y1i = int(round(gx + gw)), int(round(gy + gh))
sides = {}
if x0i > 0:
    sides["left"] = float(np.mean(vx[y0i:y1i, x0i]))
if x1i < W:
    sides["right"] = float(np.mean(vx[y0i:y1i, x1i - 1]))
if y0i > 0:
    sides["top"] = float(np.mean(hy[y0i, x0i:x1i]))
if y1i < H:
    sides["bottom"] = float(np.mean(hy[y1i - 1, x0i:x1i]))
for k, v in sides.items():
    verdict = "OK" if v / gmean >= args.edge_min else "BELOW edge_min"
    print(f"GT side {k}: raw={v:.2f} norm={v/gmean:.2f} {verdict}")
if sides:
    worst = min(v / gmean for v in sides.values())
    print(f"GT score (min side / gmean) = {worst:.2f} vs edge_min {args.edge_min}")

best = find_cam_rect(vx, hy, (fx, fy, fw, fh), W, H, args.pip_max_frac, args.edge_min)
print(f"find_cam_rect -> {best}")
