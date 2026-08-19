import os
import unittest

import cv2
import numpy as np

import detect_faces as df

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "testdata")


def load(name):
    img = cv2.imread(os.path.join(DATA, name), cv2.IMREAD_GRAYSCALE)
    assert img is not None, name
    return img


class TestEdgeMap(unittest.TestCase):
    def test_flat_image_has_no_edges(self):
        flat = np.full((360, 640), 128, np.uint8)
        vx, hy = df.median_edge_map([flat])
        self.assertAlmostEqual(float(np.mean(vx)), 0.0, places=3)
        self.assertAlmostEqual(float(np.mean(hy)), 0.0, places=3)

    def test_median_suppresses_a_transient_edge(self):
        base = np.full((360, 640), 128, np.uint8)
        moving = base.copy()
        moving[:, 300:] = 20  # a hard edge present in ONE frame of five
        vx, _ = df.median_edge_map([base, base, moving, base, base])
        self.assertLess(float(np.max(vx[:, 295:305])), 1.0)

    def test_median_keeps_a_persistent_edge(self):
        frames = []
        for shift in range(5):
            f = np.full((360, 640), 128, np.uint8)
            f[:, 300:] = 20  # same edge every frame
            f[shift * 10 : shift * 10 + 5, :] = 200  # noise that moves
            frames.append(f)
        vx, _ = df.median_edge_map(frames)
        self.assertGreater(float(np.max(vx[:, 295:305])), 50.0)


class TestFindCamRect(unittest.TestCase):
    def test_finds_the_corner_inset_on_gameplay(self):
        img = load("pip-gameplay.jpg")
        h, w = img.shape[:2]
        vx, hy = df.median_edge_map([img])
        # Face box in 640-wide detection pixels: source 179,110,43,56 halved.
        rect = df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.5, 4.0)
        self.assertIsNotNone(rect)
        # Inset is one third of the frame, flush to the top-left corner.
        self.assertLess(rect["x"], 0.03 * w)
        self.assertLess(rect["y"], 0.03 * h)
        self.assertAlmostEqual(rect["w"] / w, 1 / 3, delta=0.06)
        self.assertAlmostEqual(rect["h"] / h, 1 / 3, delta=0.06)

    def test_agrees_across_two_different_moments(self):
        boxes = {"pip-gameplay.jpg": (90, 55, 22, 28),
                 "pip-scoreboard.jpg": (90, 55, 22, 28)}
        rects = []
        for name, face in boxes.items():
            img = load(name)
            h, w = img.shape[:2]
            vx, hy = df.median_edge_map([img])
            r = df.find_cam_rect(vx, hy, face, w, h, 0.5, 4.0)
            self.assertIsNotNone(r, name)
            rects.append(r)
        for key in ("x", "y", "w", "h"):
            self.assertLess(abs(rects[0][key] - rects[1][key]), 0.02 * 640, key)

    def test_returns_none_on_a_flat_frame(self):
        flat = np.full((360, 640), 128, np.uint8)
        vx, hy = df.median_edge_map([flat])
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), 640, 360, 0.5, 4.0))

    def test_rejects_a_rectangle_larger_than_the_cap(self):
        img = load("pip-gameplay.jpg")
        h, w = img.shape[:2]
        vx, hy = df.median_edge_map([img])
        # A 5% cap admits no rectangle that could contain the face.
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.05, 4.0))

    def test_rejects_everything_at_an_impossible_energy_bar(self):
        img = load("pip-gameplay.jpg")
        h, w = img.shape[:2]
        vx, hy = df.median_edge_map([img])
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.5, 1e6))


class TestRectConstraints(unittest.TestCase):
    """Pins the two defects that nearly shipped, plus the rule that fixed them."""

    def test_height_cap_rejects_a_tall_box_inside_the_width_cap(self):
        # 100 px wide, 310 px tall. Inside the width cap, far outside the
        # height cap. This is the shape that beat every true rectangle back
        # when pip_max_frac capped width only.
        img = np.full((360, 640), 128, np.uint8)
        img[20:330, 100:200] = 40
        face = (130, 150, 20, 26)
        vx, hy = df.median_edge_map([img])
        self.assertIsNone(df.find_cam_rect(vx, hy, face, 640, 360, 0.5, 4.0))
        # Same frame, same face, cap raised past the box: now found. The only
        # thing that changed is the cap, so the cap is what rejected it.
        loose = df.find_cam_rect(vx, hy, face, 640, 360, 1.0, 4.0)
        self.assertIsNotNone(loose)
        self.assertGreater(loose["h"], 0.5 * 360)

    def test_prefers_the_larger_rectangle_over_a_stronger_smaller_one(self):
        # Two nested boxes around the same face. The inner one has much
        # higher-contrast borders, so it scores higher; the outer one is
        # bigger. Selecting on score would take the inner - that is the
        # shrink bias. Selecting on area must take the outer.
        img = np.full((360, 640), 128, np.uint8)
        cv2.rectangle(img, (40, 30), (240, 150), 170, 1)   # outer, moderate
        cv2.rectangle(img, (80, 60), (200, 130), 255, 1)   # inner, very strong
        face = (120, 80, 20, 26)
        vx, hy = df.median_edge_map([img])
        # A cap that admits only the inner box.
        inner = df.find_cam_rect(vx, hy, face, 640, 360, 0.25, 4.0)
        # A cap that admits both.
        both = df.find_cam_rect(vx, hy, face, 640, 360, 0.5, 4.0)
        self.assertIsNotNone(inner)
        self.assertIsNotNone(both)
        # The premise: the smaller candidate really does score higher.
        self.assertGreater(inner["score"], both["score"])
        # The property: it still loses, because area decides.
        self.assertGreater(both["w"] * both["h"], inner["w"] * inner["h"])

    def test_finds_a_rectangle_flush_to_the_top_left_corner(self):
        # Sobel uses BORDER_REFLECT_101, so column 0 and row 0 are identically
        # zero. Scoring a side that lies on the canvas gives this rectangle
        # 0.00 and makes a corner-flush inset - the commonest stream layout -
        # permanently undetectable.
        img = np.full((360, 640), 128, np.uint8)
        img[0:120, 0:213] = 40
        vx, hy = df.median_edge_map([img])
        rect = df.find_cam_rect(vx, hy, (90, 55, 22, 28), 640, 360, 0.5, 4.0)
        self.assertIsNotNone(rect)
        self.assertEqual((rect["x"], rect["y"]), (0, 0))
        self.assertLess(abs(rect["w"] - 213), 4)
        self.assertLess(abs(rect["h"] - 120), 4)


class TestD1D2Selection(unittest.TestCase):
    """New coverage for the 2026-08-19 stream-reframe-v2 changes: D1 (no
    frame-relative containment margin) plus D1b (a face-relative containment
    SLOP, FACE_CONTAIN_SLOP_FRAC, added the same day once D1 alone still
    left strogo returning None over a single chin pixel), and D2
    (score-dominance-then-area selection, area rule 4x -> 1.5x). D3
    (BORDER_CANDIDATES 12 -> 24) was tried and reverted the same day - see
    the constant's comment in detect_faces.py - so there is no peaks-budget
    test here. See find_cam_rect's docstring and
    docs/superpowers/specs/2026-08-19-stream-reframe-v2.md sections 2-3 for
    the strogo/tox measurements these cases pin.
    """

    def test_margin_removed_reaches_a_border_close_to_the_face(self):
        # True border only 6px below the face's bottom edge. Under the OLD
        # 0.02*W containment margin (0.02*640 = 12.8), need_y1 would have
        # been 75 + 12.8 = 87.8, past the true border at 81 - this is
        # strogo's measured kill (need_y1 = faceBottom + 0.02*W = 82.8 >
        # true border 81). With the margin removed, need_y1 = faceBottom =
        # 75 <= 81, and the true border is reachable.
        img = np.full((360, 640), 128, np.uint8)
        img[0:81, 0:175] = 40
        face = (20, 50, 30, 25)  # faceBottom=75, gap to true border = 6
        vx, hy = df.median_edge_map([img])
        rect = df.find_cam_rect(vx, hy, face, 640, 360, 0.5, 4.0)
        self.assertIsNotNone(rect)
        self.assertEqual((rect["x"], rect["y"]), (0, 0))
        self.assertLess(abs(rect["w"] - 175), 4)
        self.assertLess(abs(rect["h"] - 81), 4)

    def test_dominant_true_rect_beats_a_sprawling_low_score_rival(self):
        # Two nested corner-flush rects: a true small one (0,0,175,81) with
        # a strong border (measured score 693.7), and a larger sprawl
        # (0,0,309,150) with a weak one (measured score 113.7, well under
        # half of 693.7). The same shape as strogo, where a 309-wide HUD
        # sprawl (score 4.04) beat the true 175-wide rect (score 15.09)
        # under plain largest-area-first. Score dominance must filter the
        # sprawl before area gets a vote.
        img = np.full((360, 640), 128, np.uint8)
        img[0:150, 0:309] = 110  # sprawl fill: weak diff (18) vs background
        img[0:81, 0:175] = 0     # true fill: strong diff (110) vs sprawl fill
        face = (20, 15, 30, 20)
        vx, hy = df.median_edge_map([img])
        rect = df.find_cam_rect(vx, hy, face, 640, 360, 0.6, 4.0)
        self.assertIsNotNone(rect)
        self.assertEqual((rect["w"], rect["h"]), (175, 81))

    def test_within_2x_the_larger_rect_still_wins_the_anti_shrink_property(self):
        # Same nested-rect shape, contrast gap narrowed so the two
        # candidates score within 2x of each other (measured 361.0 vs
        # 299.5 - both clear best_score/2 = 180.5). Both survive dominance,
        # so selection falls to area - the LARGER (sprawl-shaped) rect must
        # still win. Mutation-style companion to the test above: this is
        # the v1 anti-shrink property (see
        # test_prefers_the_larger_rectangle_over_a_stronger_smaller_one)
        # surviving the D2 rewrite.
        img = np.full((360, 640), 128, np.uint8)
        img[0:150, 0:309] = 70   # outer fill: diff 58 vs background
        img[0:81, 0:175] = 0     # inner fill: diff 70 vs outer fill
        face = (20, 15, 30, 20)
        vx, hy = df.median_edge_map([img])
        rect = df.find_cam_rect(vx, hy, face, 640, 360, 0.6, 4.0)
        self.assertIsNotNone(rect)
        self.assertEqual((rect["w"], rect["h"]), (309, 150))

    def test_tight_cam_at_one_point_six_x_face_area_is_found(self):
        # Rect area ~1.6x the face area (4410 / 2750) - inside the new 1.5x
        # floor but would have failed the old 4x rule outright (tox's
        # measured tight face-cam rect area 7728 < 4*face 10780 is the same
        # shape of failure). Corner-flush by construction (not a bordered
        # cv2.rectangle off in the middle of the frame): x0=0/y0=0 are the
        # rect's REAL sides here, not a canvas-edge candidate borrowing just
        # the real right/bottom border of an off-corner box - that shadow
        # candidate is a distinct, correctly-contained rect the search would
        # otherwise legitimately find (D1 dropped the margin that used to
        # keep it out of reach) and it would confound this area-threshold
        # assertion with an unrelated pass/fail.
        img = np.full((360, 640), 128, np.uint8)
        img[0:63, 0:70] = 40  # area 4410, ratio 1.60x
        face = (20, 8, 50, 55)  # area 2750
        vx, hy = df.median_edge_map([img])
        rect = df.find_cam_rect(vx, hy, face, 640, 360, 0.5, 4.0)
        self.assertIsNotNone(rect)

    def test_tight_cam_at_one_point_four_x_face_area_is_rejected(self):
        # Same shape, area trimmed to 1.4x (3850 / 2750) - below the new
        # 1.5x floor, must still be rejected. The floor still does an
        # anti-degenerate job, just at a lower bar than v1's 4x. Corner-flush
        # for the same reason as above.
        img = np.full((360, 640), 128, np.uint8)
        img[0:55, 0:70] = 40  # area 3850, ratio 1.40x
        face = (20, 0, 50, 55)
        vx, hy = df.median_edge_map([img])
        rect = df.find_cam_rect(vx, hy, face, 640, 360, 0.5, 4.0)
        self.assertIsNone(rect)

    def test_slop_absorbs_a_small_chin_overhang_past_the_true_border(self):
        # D1b, 2026-08-19: even with D1's margin gone, strogo still returned
        # None - the real YuNet box's bottom edge (81.0) landed exactly past
        # the true border (80), and exact containment demanded a rect deeper
        # than the true border over a single chin pixel (2.4% of face
        # height). Here the face overhangs the true border by 5% of its own
        # height (2px of 40) - within the 10% slop - so the true border must
        # still be found.
        img = np.full((360, 640), 128, np.uint8)
        img[0:100, 0:175] = 40
        face = (60, 62, 40, 40)  # faceBottom=102, true border=100, overhang=2 (5%)
        vx, hy = df.median_edge_map([img])
        rect = df.find_cam_rect(vx, hy, face, 640, 360, 0.5, 4.0)
        self.assertIsNotNone(rect)
        self.assertEqual((rect["x"], rect["y"]), (0, 0))
        self.assertLess(abs(rect["w"] - 175), 4)
        self.assertLess(abs(rect["h"] - 100), 4)
        # Mutation check: zero the slop and the SAME scenario must fail -
        # proving the slop, not something else, is what let it through.
        old = df.FACE_CONTAIN_SLOP_FRAC
        df.FACE_CONTAIN_SLOP_FRAC = 0.0
        try:
            self.assertIsNone(df.find_cam_rect(vx, hy, face, 640, 360, 0.5, 4.0))
        finally:
            df.FACE_CONTAIN_SLOP_FRAC = old

    def test_slop_does_not_absorb_a_large_chin_overhang(self):
        # Same shape, overhang widened to 20% of face height (8px of 40) -
        # past the 10% slop. The true border must NOT be accepted (pins the
        # bound both ways against the test above).
        img = np.full((360, 640), 128, np.uint8)
        img[0:100, 0:175] = 40
        face = (60, 68, 40, 40)  # faceBottom=108, true border=100, overhang=8 (20%)
        vx, hy = df.median_edge_map([img])
        rect = df.find_cam_rect(vx, hy, face, 640, 360, 0.5, 4.0)
        self.assertIsNone(rect)


if __name__ == "__main__":
    unittest.main()
