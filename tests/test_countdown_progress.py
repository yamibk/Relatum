import json
import tempfile
import unittest
from pathlib import Path

import app


class CountdownProgressLengthTests(unittest.TestCase):
    """日历页倒数日进度条的 lengthDays 字段：合法整数保留、非法值丢弃、读写往返一致。"""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_countdown_file = app.COUNTDOWN_FILE
        root = Path(self.temp_dir.name)
        app.COUNTDOWN_FILE = root / "countdown.json"

    def tearDown(self):
        app.COUNTDOWN_FILE = self.original_countdown_file
        self.temp_dir.cleanup()

    def event(self, **extra):
        base = {"id": "e1", "event": "考试", "date": "2026-12-31"}
        base.update(extra)
        return base

    def test_valid_length_days_is_kept(self):
        clean = app._sanitize_countdown_event(self.event(lengthDays=60), {}, 0)
        self.assertEqual(clean["lengthDays"], 60)

    def test_missing_length_days_stays_unset(self):
        clean = app._sanitize_countdown_event(self.event(), {}, 0)
        self.assertNotIn("lengthDays", clean)

    def test_invalid_length_days_is_dropped(self):
        for bad in (True, False, 0, -3, 10000, 1.5, "60", None):
            clean = app._sanitize_countdown_event(self.event(lengthDays=bad), {}, 0)
            self.assertNotIn("lengthDays", clean, msg=f"lengthDays={bad!r} 应被丢弃")

    def test_save_load_round_trip_keeps_length_days(self):
        payload = {
            "version": 2,
            "selectedId": "e1",
            "events": [
                {"id": "e1", "event": "考试", "date": "2026-12-31", "lengthDays": 60},
                {"id": "e2", "event": "生日", "date": "2027-01-01"},
            ],
            "event": "考试",
            "date": "2026-12-31",
        }
        saved = app.save_countdown(payload)
        self.assertEqual(saved["events"][0]["lengthDays"], 60)
        self.assertNotIn("lengthDays", saved["events"][1])
        loaded = app.load_countdown()
        self.assertEqual(loaded["events"][0]["lengthDays"], 60)

    def test_legacy_single_event_without_events_list(self):
        saved = app.save_countdown({"id": "legacy", "event": "目标事件", "date": "2026-12-31"})
        self.assertEqual(saved["events"][0]["id"], "legacy")
        self.assertNotIn("lengthDays", saved["events"][0])


if __name__ == "__main__":
    unittest.main()
