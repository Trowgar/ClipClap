"""Measurement probe: what could `find_cam_rect` find if it were allowed to look?

    python3 probe_insert_rect.py --frames-dir DIR --shots shots.json --fps 2 \
        --detected detected.json --source-width 1920 --source-height 1080

NOT part of the pipeline. Nothing imports it, `faces.ts` does not invoke it, and
it writes JSON to stdout for `eval-insert-rect.ts` to read. It exists to answer
one question with numbers instead of opinion: the engine anchored a clip's
opening on a still portrait inside a graphic insert, and the proposal on the
table is to reuse the webcam-inset detector as a general "face inside a graphic"
layer. Before that is designed, it has to be known what that detector can and
cannot see.

WHY A SEPARATE FILE INSTEAD OF A FLAG ON THE SIDECAR
----------------------------------------------------

`detect_faces.py` is production. A probe flag on it would be a branch in the
path that renders every clip, and the measurement would be arguing about its own
apparatus from then on. This imports `detect_faces` as a module and calls the
SAME `median_edge_map` and `find_cam_rect`, so what it measures is genuinely
that feature class and not a reimplementation of it - while the shipped file
stays byte-identical.

THE THREE CONFIGURATIONS, AND WHY EACH EXISTS
---------------------------------------------

`detect_faces.py` gates the rect search twice over, and both gates decide the
answer before the detector is consulted:

1. **The size gate.** The search runs only when the DOMINANT track (most
   samples) is already narrower than `face_small_frac * source_width` - 6%, or
   115px on a 1920 source. A guest-portrait card holds a LARGE face, so on the
   motivating shot the dominant track is 241px and `find_cam_rect` is never
   called at all. Reporting "the detector found nothing" there would be true and
   useless: it never looked.
2. **The edge map is clip-wide.** `edge_frames` accumulates the first
   EDGE_SAMPLE_MAX frames of the WHOLE clip and `edge_vx/edge_hy` is computed
   once and reused for every shot. At 2 fps that is the first 12 seconds. A card
   that appears at 0:40 contributes nothing to the map it would have to be found
   in.

So each track is probed three ways:

  shipped_like  gate honoured, clip-wide edge map   - today, per track
  ungated       no size gate, clip-wide edge map    - what lifting gate 1 buys
  pershot       no size gate, this shot's own map   - what lifting both buys

The rect is reported with its score whenever one is found, and the score is
reported even when it fails `--pip-edge-min`, because "found nothing" and
"found something at 3.1 against a threshold of 4.0" are different results and
only the second one tells you where the threshold should be.

WHAT THIS CANNOT ANSWER
-----------------------

Whether a rectangle it found is a graphic insert, a webcam, a doorway or a
television in the background. `find_cam_rect` scores border edge energy; a
picture frame on a wall is a rectangle with strong borders. The roles and the
false positives are decided by looking at the frames, which is what the script
driving this does with the output.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from detect_faces import (  # noqa: E402
    CAM_EDGE_MIN,
    EDGE_SAMPLE_MAX,
    find_cam_rect,
    median_edge_map,
)


def probe_track(vx, hy, box, scale, det_w, det_h, pip_max_frac, edge_min):
    """`find_cam_rect` anchored on one track's median box.

    `box` is in SOURCE pixels, as the sidecar renders it; the search runs in
    detection pixels and the result is scaled back out, exactly as
    `detect_faces.main` does it. Getting this backwards would search for a
    rectangle three times too large and find nothing, which is indistinguishable
    from a true negative.
    """
    if vx is None or hy is None:
        return None
    face = (box["x"] / scale, box["y"] / scale, box["w"] / scale, box["h"] / scale)
    r = find_cam_rect(vx, hy, face, det_w, det_h, pip_max_frac, edge_min)
    if r is None:
        return None
    return {
        "x": r["x"] * scale,
        "y": r["y"] * scale,
        "w": r["w"] * scale,
        "h": r["h"] * scale,
        "score": r["score"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--shots", required=True)
    ap.add_argument("--fps", type=float, required=True)
    ap.add_argument("--detected", required=True,
                    help="the shipped sidecar's JSON, for its track boxes")
    ap.add_argument("--source-width", type=int, required=True)
    ap.add_argument("--source-height", type=int, required=True)
    ap.add_argument("--face-small-frac", type=float, default=0.06)
    ap.add_argument("--pip-max-frac", type=float, default=0.50)
    ap.add_argument("--pip-edge-min", type=float, default=CAM_EDGE_MIN)
    # The floor the probe searches at. Deliberately BELOW --pip-edge-min so a
    # near miss is reported as a number rather than as silence; the shipped
    # threshold is then applied by the reader, not by the search.
    ap.add_argument("--probe-edge-min", type=float, default=1.0)
    args = ap.parse_args()

    with open(args.shots) as f:
        shots = json.load(f)
    with open(args.detected) as f:
        detected = json.load(f)

    frames = sorted(f for f in os.listdir(args.frames_dir) if f.endswith(".jpg"))

    # Frame -> shot exactly as the sidecar assigns it: t = idx / fps, first shot
    # whose half-open span contains t, else the last. A different rule here
    # would build the per-shot edge map from the wrong frames and the pershot
    # column would measure nothing.
    per_shot_grays = [[] for _ in shots]
    clip_grays = []
    det_w = det_h = 0
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
        if det_w == 0:
            det_h, det_w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        if len(clip_grays) < EDGE_SAMPLE_MAX:
            clip_grays.append(gray)
        if len(per_shot_grays[shot_i]) < EDGE_SAMPLE_MAX:
            per_shot_grays[shot_i].append(gray)

    if det_w == 0:
        json.dump({"shots": [], "error": "no_frames"}, sys.stdout)
        return

    scale = args.source_width / float(det_w)
    clip_vx, clip_hy = median_edge_map(clip_grays)

    out = {"detWidth": det_w, "detHeight": det_h, "shots": []}
    for shot in detected.get("shots", []):
        i = shot["shotIndex"]
        grays = per_shot_grays[i] if i < len(per_shot_grays) else []
        shot_vx, shot_hy = median_edge_map(grays) if grays else (None, None)
        rows = []
        for tr in shot.get("tracks", []):
            box = tr["box"]
            dominant = box["w"] <= args.face_small_frac * args.source_width
            rows.append({
                "id": tr["id"],
                "box": box,
                "samples": tr["samples"],
                "passesSizeGate": dominant,
                # Same call, three inputs. `shippedLike` differs from the real
                # camRect in one way only: the sidecar probes the dominant track
                # and this probes every track, so a shot can show a hit here
                # that production never asked for.
                "shippedLike": probe_track(
                    clip_vx, clip_hy, box, scale, det_w, det_h,
                    args.pip_max_frac, args.pip_edge_min
                ) if dominant else None,
                # AT THE SHIPPED THRESHOLD. These are the columns that answer
                # "would the detector accept a rectangle here", and they are
                # separate calls rather than a filter on the ones below,
                # because `find_cam_rect` selects the LARGEST rectangle clearing
                # its threshold, not the strongest. Lower the threshold and a
                # bigger, weaker box wins and reports ITS score - so filtering
                # a probe-floor result by score answers a different question
                # and answers it too pessimistically. Measured on the Booster
                # stream: at a floor of 1.0 the winner was a box whose right
                # edge had run off the webcam into the game HUD, scoring 1.35.
                "ungatedAt": probe_track(
                    clip_vx, clip_hy, box, scale, det_w, det_h,
                    args.pip_max_frac, args.pip_edge_min
                ),
                "pershotAt": probe_track(
                    shot_vx, shot_hy, box, scale, det_w, det_h,
                    args.pip_max_frac, args.pip_edge_min
                ),
                # At the probe floor: near misses, and the geometry that a
                # relaxed threshold would actually pick. Kept because "found
                # nothing" and "found something weak" are different results.
                "ungated": probe_track(
                    clip_vx, clip_hy, box, scale, det_w, det_h,
                    args.pip_max_frac, args.probe_edge_min
                ),
                "pershot": probe_track(
                    shot_vx, shot_hy, box, scale, det_w, det_h,
                    args.pip_max_frac, args.probe_edge_min
                ),
            })
        out["shots"].append({
            "shotIndex": i,
            "edgeFrames": len(grays),
            "camRect": shot.get("camRect"),
            "tracks": rows,
        })
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
