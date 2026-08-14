import unittest

import app


class StickyPaletteBackendTests(unittest.TestCase):
    def test_backend_accepts_the_complete_twenty_color_palette(self):
        expected = {
            "pink", "blue", "purple", "green", "yellow", "orange",
            "teal", "sky", "lavender", "coral", "lime", "rose", "mint", "apricot",
            "paper", "stone", "sand", "sage", "indigo", "plum",
        }
        self.assertEqual(app.NOTE_COLORS, expected)

        for index, color in enumerate(sorted(expected)):
            wall_note = app._sanitize_note({
                "id": f"wall-{index}", "x": 1, "y": 2, "color": color, "text": "keep",
            })
            page_note = app._sanitize_start_sticky_note({
                "id": f"page-{index}", "scope": "recent", "x": 1, "y": 2,
                "color": color, "text": "keep",
            })
            self.assertEqual(wall_note["color"], color)
            self.assertEqual(page_note["color"], color)

    def test_unknown_colors_fall_back_without_changing_the_data_schema(self):
        wall_note = app._sanitize_note({
            "id": "wall", "x": 0, "y": 0, "color": "future", "text": "wall",
        })
        page_note = app._sanitize_start_sticky_note({
            "id": "page", "scope": "study", "x": 0, "y": 0,
            "color": "future", "text": "page",
        })

        self.assertEqual(wall_note["color"], "yellow")
        self.assertEqual(page_note["color"], "yellow")
        self.assertNotIn("version", wall_note)
        self.assertNotIn("version", page_note)


if __name__ == "__main__":
    unittest.main()
