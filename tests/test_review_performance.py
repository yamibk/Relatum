import tempfile
import unittest
from datetime import date
from pathlib import Path

import app


class ReviewEventCountPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_data = app.DATA
        self.original_review_db_file = app.REVIEW_DB_FILE
        app.DATA = Path(self.temp_dir.name)
        app.REVIEW_DB_FILE = app.DATA / "review.db"

    def tearDown(self):
        app.REVIEW_DB_FILE = self.original_review_db_file
        app.DATA = self.original_data
        self.temp_dir.cleanup()

    def test_daily_count_keeps_day_boundaries_and_uses_time_index(self):
        conn = app._review_connect()
        try:
            rows = [
                ("previous", "remembered", "2026-08-24T23:59:59"),
                ("day-start", "remembered", "2026-08-25T00:00:00"),
                ("day-end", "forgot", "2026-08-25T23:59:59"),
                ("next", "vague", "2026-08-26T00:00:00"),
            ]
            conn.executemany(
                """
                INSERT INTO review_events
                    (prompt_snapshot, rating, reviewed_at, previous_level,
                     next_level, next_due_on)
                VALUES (?, ?, ?, 0, 1, '')
                """,
                rows,
            )
            conn.commit()

            target_day = date(2026, 8, 25)
            self.assertEqual(app._review_event_count_for_day(conn, target_day), 2)

            day_start = "2026-08-25T00:00:00"
            next_day_start = "2026-08-26T00:00:00"
            query_plan = conn.execute(
                "EXPLAIN QUERY PLAN " + app.REVIEW_EVENTS_DAY_COUNT_SQL,
                (day_start, next_day_start),
            ).fetchall()
            details = " ".join(str(row[3]) for row in query_plan)
            self.assertIn("SEARCH", details.upper())
            self.assertIn("idx_review_events_reviewed_at", details)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
