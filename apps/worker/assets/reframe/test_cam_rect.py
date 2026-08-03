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


if __name__ == "__main__":
    unittest.main()
