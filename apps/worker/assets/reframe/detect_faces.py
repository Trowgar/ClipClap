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
# Raised to 24 (D3, 2026-08-19) on the theory that tox's true x0/y0 borders
# were ranked outside the top-12, crowded out by the watched video's static
# edges - and reverted the SAME DAY. Measured cost: on the real CS2 fixture
# (pip-gameplay.jpg / pip-scoreboard.jpg) the bigger budget admitted a weak
# sub-border at row 177 (raw mean 132, vs 452 for the true border at row
# 119), and D2's score-dominance filter passes it at 4.13/5.96 = 1.28x -
# comfortably inside the /2 band - so largest-area then picks the true cam
# PLUS 58px of gameplay below it: exactly the "gap under the cam" defect
# this spec exists to kill, regressing the v1 pin
# (test_finds_the_corner_inset_on_gameplay). Measured benefit: none. strogo
# needed only D1+D2 - its true x1=175 border was already in the top-12, and
# its sprawl candidate (x1=309) is ALSO in the top-12, filtered by D2's
# dominance rule (score 4.04 vs 15.09) with no help from a bigger budget.
# Rtt2StnXpxw and tw-recrent already resolved correctly at budget 12. tox's
# failure is not a ranking problem - its true borders are ABSENT from the
# peak list at any budget (borderless overlay, no static edge exists to
# rank) - that is task C's job, not this one's.
MIN_RECT_PX = 16         # a rectangle thinner than this is noise
# FACE_MARGIN_FRAC removed (D1, 2026-08-19): a 2%-of-frame-width containment
# margin was the SOLE kill of a true rect on strogo - need_y1 = faceBottom +
# 0.02*W = 82.8 > true border 81, while that true rect's sides scored 15-20
# against edge_min 4. The margin's anti-degenerate job (stopping the search
# collapsing onto the face itself) moved to selection - see find_cam_rect's
# docstring.

# D1b, 2026-08-19: even with D1's margin gone, strogo STILL returned None -
# a direct sidecar run showed the real dominant YuNet track's det-scale box
# is (87.9, 39.9, 42.8, 41.1), bottom edge 81.0, landing EXACTLY past the
# cam's true bottom border (the y-peak at 80). D1's exact containment
# (need_y1 = fy+fh = 81.0) then demands a rect deeper than the true border -
# a single chin pixel, 2.4% of face height, was the entire remaining kill
# (the only surviving y1 candidates jump to the next peak, ~343, and die on
# the height cap). YuNet's box edges are approximate; a chin pixel landing
# on the border must not veto a rect whose sides score 12+ against edge_min
# 4. FACE_CONTAIN_SLOP_FRAC shrinks the containment requirement by this
# fraction of the FACE'S OWN size, per side, toward its centre - this is NOT
# FACE_MARGIN_FRAC reborn: that was a frame-relative margin that PADDED the
# requirement outward (by 2% of frame width) and overshot small cams; this
# pulls the requirement INWARD by a face-relative fraction, so it cannot
# recreate the overshoot D1 fixed.
# MIRRORED in apps/worker/src/reframe/plan.ts (same name, same value): the
# TS isInsideInset predicate applies the identical face-relative shrink (its
# D1c) - two languages, one rule; change one, change the other.
FACE_CONTAIN_SLOP_FRAC = 0.10

# Measured on a 55-minute CS2 VOD, 2026-08-02: 26 true detections scored
# 5.65-8.84, the strongest false candidate scored 1.54, and every threshold
# in 3.0-5.0 gave identical output. 4.0 is the middle of that empty corridor.
# One streamer, one OBS layout, one video - the corridor is real but narrow
# evidence. Re-measure before trusting it on a second source shape.
CAM_EDGE_MIN = 4.0

# D2b, 2026-08-19: nested-dominance rule, on SCORE not area. First attempt
# used an area ratio (a survivor containing another that scored higher was
# trimmed once its area exceeded the inner's by 1.25x) and measured a DEAD
# END: area cannot separate the two sets, because they overlap. Must-NOT-
# trim area ratios measured 1.705 (test_prefers_the_larger_rectangle_over_a_
# stronger_smaller_one) and 3.27 (this file's own within-2x D2 test) sit on
# BOTH SIDES of the must-trim tw-recrent ratio, 1.85 - no threshold separates
# them, and the area rule also trimmed Rtt2StnXpxw's correct 174x124 crop
# down to a wrong 126x90 in production. SCORE ratio does separate them,
# measured on the same candidates:
#   must trim:      tw-recrent (synthetic repro)  511.27 / 306.76 = 1.67
#                    strogo sprawl (already dominance-killed) 15.09/4.04=3.7
#   must NOT trim:   test_prefers_the_larger...                 1.33
#                    test_finds_the_corner_inset_on_gameplay    1.13
#                    test_agrees_across_two_different_moments   1.41
#                    this file's own within-2x D2 test          1.21
#                    Rtt2StnXpxw (live, pre/post this change)   1.25
# Every must-NOT-trim case is < 1.5; the must-trim cases are >= 1.67. 1.5
# sits in the empty gap. The outer's weak side in a must-trim case is a junk
# edge (an overlay, a HUD sprawl) - the score collapses outright rather than
# merely dipping, which is exactly why v1's shrink bias was subtle (a few
# tens of percent) rather than catastrophic (50%+).
NESTED_SCORE_DOMINANCE = 1.5


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

    Containment requires the rect to contain the FACE BOX and nothing more
    (D1, 2026-08-19 - no margin). A 2%-of-frame-width margin used to pad
    need_x0/need_y0/need_x1/need_y1; on strogo that made need_y1 = faceBottom
    + 0.02*W = 82.8, past the true border at 81, and the margin was the SOLE
    kill of a true rect whose sides scored 15.09/20.17 against edge_min 4.0.
    The margin's anti-degenerate job (stopping the search from collapsing
    onto the face itself) moves to selection, below.

    Containment then shrinks by FACE_CONTAIN_SLOP_FRAC (D1b, 2026-08-19):
    need_x0/need_y0/need_x1/need_y1 are computed from the face box pulled in
    by 10% of its OWN width/height per side, toward its centre - not padded
    outward by a frame-relative fraction, which is what D1 just removed.
    Even with D1's margin gone, strogo still returned None: the real YuNet
    box's bottom edge (81.0) landed exactly past the true border (80), and
    exact containment demanded a rect deeper than that border over a single
    chin pixel. Detector boxes are approximate; a pixel of overhang must not
    veto a rect whose sides clear edge_min by 3-5x. face_area for the area
    rule below stays the FULL, un-shrunk face box - the slop is containment
    tolerance, not a claim that the face is smaller than detected.

    Selection is score-dominance-then-area (D2, 2026-08-19) over every
    candidate clearing edge_min: drop candidates scoring below HALF the best
    candidate's score, then take the LARGEST AREA among survivors, tie-broken
    on score. Plain largest-area-first let a false candidate win outright: on
    strogo a 309-wide HUD sprawl scored 4.04 and beat the true 175-wide rect
    at 15.09 on area alone. Plain highest-score-first reintroduces the shrink
    bias largest-area used to guard against - each border is a mean over the
    rectangle's own span, so scoring highest rewards shrinking inward to
    exclude the weakest part of a border (see
    test_prefers_the_larger_rectangle_over_a_stronger_smaller_one). Dominance
    first, then area, keeps both properties: a weak sprawling false candidate
    never reaches the area comparison, and among genuinely competitive
    candidates the larger one still wins.

    A nested-dominance rule runs after that filter (D2b, 2026-08-19): drop a
    survivor that CONTAINS another survivor scoring at least
    NESTED_SCORE_DOMINANCE times as much. tw-recrent's true cam sits
    directly above a static caption/ad-banner overlay, so "cam plus overlay"
    is itself a legitimate candidate - weaker-bordered than the cam alone,
    but not weak enough to miss the /2 dominance band, and it used to win
    outright on area. The /2 filter alone cannot fix this: it compares every
    candidate to the GLOBAL best, and the sprawling outer candidate here
    often outscores unrelated candidates by more than half while still
    losing badly to its own inner rect. Containment is the signal dominance-
    alone cannot see. This is a SCORE rule, not an area rule (see
    NESTED_SCORE_DOMINANCE's comment for the measured reason an area ratio
    was tried first and abandoned): a junk edge collapses score outright,
    while the ordinary area-vs-score tradeoff between two legitimate
    candidates (the shape
    test_prefers_the_larger_rectangle_over_a_stronger_smaller_one pins)
    never reaches this ratio.
    """
    if vx is None or hy is None:
        return None
    gmean = (float(np.mean(vx)) + float(np.mean(hy))) / 2.0
    if gmean <= 1e-6:
        return None
    fx, fy, fw, fh = face
    need_x0 = fx + FACE_CONTAIN_SLOP_FRAC * fw
    need_x1 = fx + fw - FACE_CONTAIN_SLOP_FRAC * fw
    need_y0 = fy + FACE_CONTAIN_SLOP_FRAC * fh
    need_y1 = fy + fh - FACE_CONTAIN_SLOP_FRAC * fh
    face_area = max(1.0, fw * fh)
    max_w = pip_max_frac * W
    max_h = pip_max_frac * H

    xs = sorted(set([0, W] + _peaks(vx.sum(axis=0), BORDER_CANDIDATES)))
    ys = sorted(set([0, H] + _peaks(hy.sum(axis=1), BORDER_CANDIDATES)))

    candidates = []
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
                    # 4.0x -> 1.5x (D2, 2026-08-19): the 4x floor existed to
                    # fight sprawl by area alone, but that job now belongs to
                    # dominance above, and 4x was itself killing true rects -
                    # tox's tight face-cam rect area 7728 < 4*face 10780.
                    if (x1 - x0) * (y1 - y0) < 1.5 * face_area:
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
                    candidates.append({"x": x0, "y": y0, "w": x1 - x0,
                                        "h": y1 - y0, "score": score})
    if not candidates:
        return None
    best_score = max(c["score"] for c in candidates)
    survivors = [c for c in candidates if c["score"] >= best_score / 2.0]
    # D2b, 2026-08-19: nested-dominance rule - see the docstring above and
    # NESTED_SCORE_DOMINANCE's comment for the measured score table. A
    # survivor that contains another survivor scoring
    # NESTED_SCORE_DOMINANCE times as much or more is sprawl (cam + junk
    # overlay), not a legitimate larger candidate, and is dropped before the
    # area sort. No area term: area could not separate the must-trim and
    # must-not-trim sets (they overlap), score can.
    survivors = [
        o for o in survivors
        if not any(
            i is not o
            and o["x"] <= i["x"] and o["y"] <= i["y"]
            and o["x"] + o["w"] >= i["x"] + i["w"]
            and o["y"] + o["h"] >= i["y"] + i["h"]
            and i["score"] >= NESTED_SCORE_DOMINANCE * o["score"]
            for i in survivors
        )
    ]
    if not survivors:
        return None
    survivors.sort(key=lambda c: (c["w"] * c["h"], c["score"]), reverse=True)
    return survivors[0]


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


def render_path(track, scale):
    """Per-sample boxes in SOURCE pixels, sorted by time.

    The median in `box` is what every existing consumer reads and it is
    unchanged. This is the same data before the median was taken, which is the
    whole of what Layer 0 needs: the planner could not express a moving camera
    because this was discarded here.

    Sorted explicitly rather than trusting insertion order. Frames are walked in
    order today, so the list is already sorted - but a caller that ever batches
    or parallelises frames would produce a path that silently runs backwards in
    time, and every consumer downstream assumes monotonic t.
    """
    rows = sorted(zip(track["times"], track["boxes"]), key=lambda r: r[0])
    return [
        {
            "t": float(t),
            "x": float(b[0]) * scale,
            "y": float(b[1]) * scale,
            "w": float(b[2]) * scale,
            "h": float(b[3]) * scale,
        }
        for t, b in rows
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--shots", required=True, help="JSON file: [{start,end}] clip-relative")
    ap.add_argument("--fps", type=float, required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--min-score", type=float, default=0.7)
    ap.add_argument("--face-small-frac", type=float, default=0.06)
    # 0.0 means "not passed" - keep gating on --face-small-frac, so a direct
    # CLI invocation without this flag behaves exactly as before. Real callers
    # (faces.ts) always pass the classifier's rect-first ceiling instead; see
    # the gate below for why the two used to disagree.
    ap.add_argument("--stream-face-ceiling", type=float, default=0.0)
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
                    "times": [t],
                    "scores": [float(det[14])],
                    "last_box": box,
                    "mouth": [],
                    "last_patch": patch,
                })
            else:
                best["boxes"].append(box)
                best["times"].append(t)
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
                "path": render_path(tr, scale),
            })
        # Gate: only a dominant face under the threshold can be a webcam inset.
        # Podcasts and facecams never reach median_edge_map, so they pay
        # nothing for this. The threshold used to be --face-small-frac (the
        # anchor floor), which meant a real corner-cam stream with a
        # fairly large face - strogo/tox measured 0.076-0.077, both ABOVE that
        # 0.06 floor - never even got a rect search: TS classified normal_face
        # before find_cam_rect ever ran. It now matches the classifier's D5
        # rect-first ceiling (spec 2026-08-19-stream-reframe-v2) instead, so
        # the two gates agree; --stream-face-ceiling 0.0 (unset) falls back to
        # the old --face-small-frac behaviour unchanged.
        threshold = (
            args.stream_face_ceiling if args.stream_face_ceiling > 0 else args.face_small_frac
        )
        rect = None
        if rendered:
            dom = max(rendered, key=lambda t: t["samples"])
            if dom["box"]["w"] <= threshold * args.source_width:
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
