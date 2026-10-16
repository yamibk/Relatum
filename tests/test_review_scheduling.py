"""Daily relearning, durable completions and rating receipts; isolated SQLite only."""
import copy
import http.client
import http.server
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("RELATUM_DATA_ROOT", tempfile.mkdtemp(prefix="relatum-review-scheduling-runtime-"))
import app


class ReviewSchedulingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="relatum-review-scheduling-")
        self.clock = "2026-10-16T09:00:00"
        self.patches = [patch.object(app, "DATA", Path(self.temp.name)),
                        patch.object(app, "REVIEW_DB_FILE", Path(self.temp.name) / "review.db"),
                        patch.object(app, "_study_now", side_effect=lambda: self.clock)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def sql(self, statement, values=()):
        conn = app._review_connect()
        try:
            with conn:
                return [dict(row) for row in conn.execute(statement, values).fetchall()]
        finally:
            conn.close()

    def card(self, name="word", level=0, due="2026-10-16", **fields):
        card = app.create_review_card({"prompt": name, "answer": "meaning", **fields})
        self.sql("UPDATE review_cards SET level = ?, due_on = ? WHERE id = ?", (level, due, card["id"]))
        return card["id"]

    def request(self, card_id, rating, **fields):
        count = self.sql("SELECT review_count FROM review_cards WHERE id = ?", (card_id,))[0]["review_count"]
        return {"cardId": card_id, "rating": rating, "requestId": uuid.uuid4().hex,
                "expectedReviewCount": count, "reviewDay": self.clock[:10], **fields}

    def mark(self, card_id, rating):
        return app.review_mark_payload(self.request(card_id, rating))

    def test_first_remembered_completes_and_keeps_intervals(self):
        for level, days in enumerate([1, 3, 7, 16, 35, 35]):
            card_id = self.card(str(level), level)
            result = self.mark(card_id, "remembered")
            self.assertEqual(result["card"]["level"], min(level + 1, 5))
            expected = (app.date(2026, 10, 16) + app.timedelta(days=days)).isoformat()
            self.assertEqual(result["card"]["due"], expected)
            self.assertTrue(result["card"]["dailyReview"]["completed"])
            self.assertEqual(result["completedToday"], level + 1)
            with self.assertRaises(app.ReviewMarkConflict):
                self.mark(card_id, "remembered")
        self.assertEqual(app.review_pool_payload()["dueCount"], 0)

    def test_vague_only_drops_one_level_and_needs_two_consecutive_remembers(self):
        card_id = self.card(level=4)
        for rating, streak, completed in [("vague", 0, False), ("vague", 0, False),
                                           ("remembered", 1, False), ("remembered", 2, True)]:
            result = self.mark(card_id, rating)
            card = result["card"]
            self.assertEqual(card["level"], 3)
            self.assertEqual(card["dailyReview"]["streak"], streak)
            self.assertEqual(card["dailyReview"]["completed"], completed)
            self.assertEqual(result["completedToday"], int(completed))
            self.assertEqual(result["dueCount"], int(not completed))
            self.assertEqual(result["scopes"][0]["dueCount"], int(not completed))
            self.assertEqual(card["due"], "2026-10-17" if completed else "2026-10-16")
        self.assertEqual(result["reviewedToday"], 4)

    def test_failure_resets_streak_and_forgot_cannot_be_undone_by_vague(self):
        card_id = self.card(level=5)
        for rating, streak in [("forgot", 0), ("remembered", 1), ("vague", 0),
                               ("remembered", 1), ("forgot", 0), ("remembered", 1), ("remembered", 2)]:
            result = self.mark(card_id, rating)
            self.assertEqual(result["card"]["level"], 0)
            self.assertEqual(result["card"]["dailyReview"]["streak"], streak)
        self.assertEqual(result["completedToday"], 1)
        self.assertEqual(result["reviewedToday"], 7)

    def test_restart_and_cross_day_carry_only_unfinished_work(self):
        card_id = self.card(level=3)
        self.mark(card_id, "vague")
        self.mark(card_id, "remembered")
        self.assertEqual(app.review_pool_payload()["cards"][0]["dailyReview"]["streak"], 1)
        self.clock = "2026-10-17T00:00:00"
        daily = app.review_pool_payload()["cards"][0]["dailyReview"]
        self.assertEqual(daily, {"day": "2026-10-17", "needsRelearning": True, "streak": 0, "target": 2, "completed": False})
        self.assertFalse(self.mark(card_id, "remembered")["card"]["dailyReview"]["completed"])
        self.assertEqual(self.mark(card_id, "remembered")["card"]["due"], "2026-10-18")
        self.clock = "2026-10-18T09:00:00"
        result = self.mark(card_id, "remembered")
        self.assertEqual(result["card"]["level"], 3)
        self.assertEqual(result["card"]["due"], "2026-10-25")

    def test_receipt_is_checked_before_day_version_status_or_deletion(self):
        card_id = self.card()
        payload = self.request(card_id, "forgot")
        first = app.review_mark_payload(payload)
        self.clock = "2026-10-17T09:00:00"
        app.delete_review_card(card_id)
        retry = app.review_mark_payload(payload)
        self.assertEqual({key: value for key, value in retry.items() if key != "idempotent"}, first)
        self.assertTrue(retry["idempotent"])
        self.assertEqual(len(self.sql("SELECT * FROM review_events")), 1)
        changed = {**payload, "rating": "remembered"}
        with self.assertRaises(app.ReviewMarkConflict) as error:
            app.review_mark_payload(changed)
        self.assertEqual(error.exception.code, "request-conflict")

    def test_version_date_and_inactive_conflicts_do_not_write(self):
        card_id = self.card()
        for fields, code in [({"expectedReviewCount": 3}, "stale-card"),
                             ({"reviewDay": "2026-10-15"}, "day-changed")]:
            with self.assertRaises(app.ReviewMarkConflict) as error:
                app.review_mark_payload(self.request(card_id, "remembered", **fields))
            self.assertEqual(error.exception.code, code)
        self.sql("UPDATE review_cards SET status = 'suspended' WHERE id = ?", (card_id,))
        with self.assertRaises(app.ReviewMarkConflict) as error:
            self.mark(card_id, "remembered")
        self.assertEqual(error.exception.code, "card-inactive")
        self.assertEqual(self.sql("SELECT COUNT(*) AS n FROM review_events")[0]["n"], 0)

    def test_concurrent_same_request_only_scores_once(self):
        card_id = self.card()
        payload = self.request(card_id, "vague")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: app.review_mark_payload(copy.deepcopy(payload)), range(2)))
        self.assertEqual(sum(bool(result.get("idempotent")) for result in results), 1)
        self.assertEqual(self.sql("SELECT review_count FROM review_cards")[0]["review_count"], 1)
        self.assertEqual(self.sql("SELECT COUNT(*) AS n FROM review_events")[0]["n"], 1)

    def test_concurrent_different_requests_with_same_version_conflict(self):
        card_id = self.card()
        first, second = self.request(card_id, "forgot"), self.request(card_id, "forgot")
        def submit(payload):
            try:
                return app.review_mark_payload(payload)
            except app.ReviewMarkConflict as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, [first, second]))
        self.assertEqual(sum(result == "stale-card" for result in results), 1)
        self.assertEqual(self.sql("SELECT review_count FROM review_cards")[0]["review_count"], 1)

    def test_receipt_failure_rolls_back_card_history_and_daily_state(self):
        card_id = self.card(level=3)
        before = self.sql("SELECT * FROM review_cards")
        conn = app._review_connect()
        conn.execute("""CREATE TRIGGER fail_receipt BEFORE INSERT ON review_mark_requests
                        BEGIN SELECT RAISE(ABORT, 'receipt failure'); END""")
        conn.close()
        with self.assertRaises(sqlite3.DatabaseError):
            self.mark(card_id, "vague")
        self.assertEqual(self.sql("SELECT * FROM review_cards"), before)
        for table in ["review_events", "review_daily_progress", "review_mark_requests"]:
            self.assertEqual(self.sql(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"], 0)

    def test_completion_survives_delete_and_pause_keeps_relearning(self):
        first, second = self.card("first"), self.card("second")
        self.mark(first, "remembered")
        app.delete_review_card(first)
        self.mark(second, "vague")
        self.mark(second, "remembered")
        self.sql("UPDATE review_cards SET status = 'suspended' WHERE id = ?", (second,))
        self.assertEqual(app.review_pool_payload()["dueCount"], 0)
        self.sql("UPDATE review_cards SET status = 'active' WHERE id = ?", (second,))
        self.assertEqual(app.review_pool_payload()["cards"][0]["dailyReview"]["streak"], 1)
        self.assertEqual(self.mark(second, "remembered")["completedToday"], 2)

    def test_v3_and_v4_upgrade_preserve_cards_and_seed_only_legacy_today(self):
        for version in [3, 4]:
            with self.subTest(version=version):
                future = self.card("future" + str(version), level=4, due="2026-10-23")
                pending = self.card("pending" + str(version), level=0)
                conn = app._review_connect()
                for card_id, rating, due in [(future, "vague", "2026-10-23"), (future, "vague", "2026-10-23"), (pending, "forgot", "2026-10-16")]:
                    conn.execute("""INSERT INTO review_events
                        (card_id,prompt_snapshot,rating,reviewed_at,previous_level,next_level,next_due_on)
                        VALUES (?, 'legacy', ?, ?, 4, 4, ?)""", (card_id, rating, self.clock, due))
                conn.execute("DROP TABLE review_daily_progress")
                conn.execute("DROP TABLE review_mark_requests")
                if version == 3:
                    conn.execute("DROP TABLE review_imports")
                conn.execute(f"PRAGMA user_version = {version}")
                before = [dict(row) for row in conn.execute("SELECT * FROM review_cards")]
                events = [dict(row) for row in conn.execute("SELECT * FROM review_events")]
                conn.commit(); conn.close()
                self.assertEqual(self.sql("PRAGMA user_version")[0]["user_version"], 5)
                self.assertEqual(self.sql("SELECT * FROM review_cards"), before)
                self.assertEqual(self.sql("SELECT * FROM review_events"), events)
                cards = {card["id"]: card for card in app.review_cards_payload()["cards"]}
                self.assertTrue(cards[future]["dailyReview"]["completed"])
                self.assertTrue(cards[pending]["dailyReview"]["needsRelearning"])
                self.assertEqual(cards[future]["due"], "2026-10-23")
                self.assertEqual(self.mark(pending, "remembered")["card"]["dailyReview"]["streak"], 1)

    def test_pool_filters_future_cards_and_counters_use_same_read_snapshot(self):
        card_id = self.card()
        self.card("future", due="2026-10-20")
        conn = app._review_connect(); conn.execute("PRAGMA journal_mode = WAL"); conn.close()
        original = app._review_tags_by_card
        changed = False
        def tags(connection, ids):
            nonlocal changed
            if not changed:
                changed = True
                self.mark(card_id, "remembered")
            return original(connection, ids)
        with patch.object(app, "_review_tags_by_card", side_effect=tags):
            payload = app.review_pool_payload()
        self.assertEqual([card["id"] for card in payload["cards"]], [card_id])
        self.assertEqual((payload["dueCount"], payload["completedToday"]), (1, 0))
        latest = app.review_pool_payload()
        self.assertEqual((latest["cards"], latest["dueCount"], latest["completedToday"]), ([], 0, 1))

    def test_http_receipts_conflicts_and_feature_gate(self):
        class QuietHandler(app.Handler):
            def log_message(self, *args):
                pass
        card_id = self.card()
        payload = self.request(card_id, "vague")
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        server.launch_profile = app.FULL_PROFILE
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(body):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                conn.request("POST", "/api/review-mark", json.dumps(body).encode("utf-8"),
                             {"Content-Type": "application/json"})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally:
                conn.close()
        try:
            with patch.object(app, "_usage_event") as usage:
                status, result = request(payload)
                self.assertEqual((status, result["card"]["reviewCount"]), (200, 1))
                status, replay = request(payload)
                self.assertEqual((status, replay["idempotent"]), (200, True))
                self.assertEqual(usage.call_args_list[0], usage.call_args_list[1])
                for body, code in [({**payload, "rating": "forgot"}, "request-conflict"),
                                   ({**payload, "requestId": "stale-http"}, "stale-card"),
                                   ({**payload, "requestId": "day-http", "reviewDay": "2026-10-15"}, "day-changed")]:
                    status, result = request(body)
                    self.assertEqual((status, result["code"]), (409, code))
                self.assertEqual(request({**payload, "expectedReviewCount": True})[0], 400)
                self.assertEqual(usage.call_count, 2)
                from feature_profile import LaunchProfile
                server.launch_profile = LaunchProfile({"canvas.review": False}, restricted=True)
                status, result = request(payload)
                self.assertEqual((status, result["code"]), (403, "feature-disabled"))
                self.assertEqual(self.sql("SELECT COUNT(*) AS n FROM review_events")[0]["n"], 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
