import unittest

import numpy as np

import detect_faces as df


class TestTrackPath(unittest.TestCase):
    def test_path_carries_one_entry_per_sample_in_source_pixels(self):
        track = {
            "boxes": [
                np.array([10.0, 20.0, 30.0, 40.0], np.float32),
                np.array([12.0, 20.0, 30.0, 40.0], np.float32),
            ],
            "times": [0.0, 0.5],
        }
        path = df.render_path(track, scale=2.0)
        self.assertEqual(len(path), 2)
        self.assertEqual(path[0], {"t": 0.0, "x": 20.0, "y": 40.0, "w": 60.0, "h": 80.0})
        self.assertEqual(path[1]["t"], 0.5)
        self.assertEqual(path[1]["x"], 24.0)

    def test_path_is_sorted_by_time(self):
        track = {
            "boxes": [
                np.array([1.0, 1.0, 1.0, 1.0], np.float32),
                np.array([2.0, 2.0, 2.0, 2.0], np.float32),
            ],
            "times": [1.0, 0.5],
        }
        path = df.render_path(track, scale=1.0)
        self.assertEqual([p["t"] for p in path], [0.5, 1.0])

    def test_empty_track_yields_empty_path(self):
        self.assertEqual(df.render_path({"boxes": [], "times": []}, scale=1.0), [])


if __name__ == "__main__":
    unittest.main()
