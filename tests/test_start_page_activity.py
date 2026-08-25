import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

import app


class StartPageActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data = Path(self.temp_dir.name) / "data"
        self.data.mkdir(parents=True)
        self.original_file = app.START_PAGE_ACTIVITY_FILE
        app.START_PAGE_ACTIVITY_FILE = self.data / "start-page-activity.json"

    def tearDown(self):
        app.START_PAGE_ACTIVITY_FILE = self.original_file
        self.temp_dir.cleanup()

    def interval(self, page, started, ended, session="start-page-session"):
        return app.record_start_page_activity_interval({
            "page": page,
            "sessionId": session,
            "startedAt": started,
            "endedAt": ended,
        })

    def test_overlapping_intervals_merge_per_page(self):
        self.interval("study", "2025-06-01T10:00:00", "2025-06-01T10:01:00")
        totals = self.interval("study", "2025-06-01T10:00:30", "2025-06-01T10:01:30")

        snapshot = app.start_page_activity_snapshot()
        self.assertEqual(snapshot["days"]["2025-06-01"]["study"]["seconds"], 90)
        self.assertEqual(totals["totalSec"], 90)

    def test_interval_splits_at_local_midnight(self):
        self.interval("tree", "2025-06-01T23:59:50", "2025-06-02T00:00:10")

        snapshot = app.start_page_activity_snapshot()
        self.assertEqual(snapshot["days"]["2025-06-01"]["tree"]["seconds"], 10)
        self.assertEqual(snapshot["days"]["2025-06-02"]["tree"]["seconds"], 10)

    def test_only_three_pages_and_valid_intervals_are_accepted(self):
        for page in app.START_PAGE_ACTIVITY_PAGES:
            self.interval(page, "2025-06-01T10:00:00", "2025-06-01T10:00:01", page)
        with self.assertRaises(ValueError):
            self.interval("cadence", "2025-06-01T10:00:00", "2025-06-01T10:00:01")
        with self.assertRaises(ValueError):
            self.interval("study", "2025-06-01T10:00:00", "2025-06-01T10:11:00")
        future = date.today() + timedelta(days=2)
        with self.assertRaises(ValueError):
            self.interval(
                "study",
                f"{future.isoformat()}T10:00:00",
                f"{future.isoformat()}T10:00:01",
            )

    def test_missing_ledger_is_an_empty_v1_snapshot(self):
        self.assertEqual(
            app.start_page_activity_snapshot(),
            {"version": app.START_PAGE_ACTIVITY_SCHEMA, "days": {}},
        )

    def test_stats_unify_days_and_count_distinct_pages(self):
        today = date.today()
        yesterday = today - timedelta(days=1)
        past_year = today.year - 1
        data = {
            "version": 1,
            "days": {
                today.isoformat(): {
                    "study": {"spans": [[0, 60]], "seconds": 60},
                    "tree": {"spans": [[100, 220]], "seconds": 120},
                },
                yesterday.isoformat(): {
                    "notes": {"spans": [[0, 30]], "seconds": 30},
                },
                f"{past_year}-02-03": {
                    "study": {"spans": [[0, 300]], "seconds": 300},
                },
                f"{past_year}-02-04": {
                    "tree": {"spans": [[0, 400]], "seconds": 400},
                    "notes": {"spans": [[500, 600]], "seconds": 100},
                },
            },
        }

        current = app._start_page_activity_stats(data, today.year)
        historical = app._start_page_activity_stats(data, past_year)
        self.assertEqual(current["yearSec"], 210)
        self.assertEqual(current["activePageCount"], 3)
        self.assertEqual(current["streak"], 2)
        self.assertEqual(historical["yearSec"], 800)
        self.assertEqual(historical["totalSec"], 1010)
        self.assertEqual(historical["activePageCount"], 3)
        self.assertEqual(historical["longestStreak"], 2)

    def test_activity_years_include_page_only_history(self):
        past_year = date.today().year - 2
        page_data = {
            "version": 1,
            "days": {
                f"{past_year}-03-01": {
                    "notes": {"spans": [[0, 60]], "seconds": 60},
                },
            },
        }
        empty_canvas = {"version": 1, "canvases": {}, "paths": {}, "days": {}}
        with (
            mock.patch.object(app, "study_activity_records", return_value=({}, [])),
            mock.patch.object(app, "load_focus", return_value={"days": {}}),
            mock.patch.object(app, "canvas_activity_snapshot", return_value=empty_canvas),
            mock.patch.object(app, "start_page_activity_snapshot", return_value=page_data),
            mock.patch.object(app, "_archive_folder_count", return_value=0),
        ):
            payload = app.study_activity_payload(past_year)

        self.assertIn(past_year, payload["years"])
        self.assertEqual(payload["year"], past_year)
        self.assertEqual(payload["startPageStats"]["yearSec"], 60)


if __name__ == "__main__":
    unittest.main()
