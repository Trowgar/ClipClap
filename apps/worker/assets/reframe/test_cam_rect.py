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
        rect = df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.5, 3.0)
        self.assertIsNotNone(rect)
        # Inset is one third of the frame, flush to the top-left corner.
        self.assertLess(rect["x"], 0.03 * w)
        self.assertLess(rect["y"], 0.03 * h)
        self.assertAlmostEqual(rect["w"] / w, 1 / 3, delta=0.06)
        self.assertAlmostEqual(rect["h"] / h, 1 / 3, delta=0.06)

    # KNOWN DEFECT, assertion deliberately left as written.
    # Each border is a MEAN over the rectangle's own span, so shrinking a
    # rectangle inward can raise the score by excluding the weakest part of a
    # border. Among rectangles sharing the true right/bottom edges, the one
    # that trims the weakest sub-span wins, and which sub-span is weakest
    # varies by moment - so x0 lands at 12 on one frame and 43 on the other.
    # Measured on the real VOD: right, bottom and top edges are exact in 26 of
    # 26 sampled windows; the left edge is exact in 16 of 26 and trims by
    # 12-61 px in the other 10. Feeding more frames reduces but does not
    # remove it. Fixing this needs a scoring change the owner has not
    # approved; expectedFailure so a future fix reports as an unexpected pass.
    @unittest.expectedFailure
    def test_agrees_across_two_different_moments(self):
        boxes = {"pip-gameplay.jpg": (90, 55, 22, 28),
                 "pip-scoreboard.jpg": (90, 55, 22, 28)}
        rects = []
        for name, face in boxes.items():
            img = load(name)
            h, w = img.shape[:2]
            vx, hy = df.median_edge_map([img])
            r = df.find_cam_rect(vx, hy, face, w, h, 0.5, 3.0)
            self.assertIsNotNone(r, name)
            rects.append(r)
        for key in ("x", "y", "w", "h"):
            self.assertLess(abs(rects[0][key] - rects[1][key]), 0.02 * 640, key)

    def test_returns_none_on_a_flat_frame(self):
        flat = np.full((360, 640), 128, np.uint8)
        vx, hy = df.median_edge_map([flat])
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), 640, 360, 0.5, 3.0))

    def test_rejects_a_rectangle_larger_than_the_cap(self):
        img = load("pip-gameplay.jpg")
        h, w = img.shape[:2]
        vx, hy = df.median_edge_map([img])
        # A 5% cap admits no rectangle that could contain the face.
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.05, 3.0))

    def test_rejects_everything_at_an_impossible_energy_bar(self):
        img = load("pip-gameplay.jpg")
        h, w = img.shape[:2]
        vx, hy = df.median_edge_map([img])
        self.assertIsNone(df.find_cam_rect(vx, hy, (90, 55, 22, 28), w, h, 0.5, 1e6))


if __name__ == "__main__":
    unittest.main()
