import copy
import http.client
import http.server
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from unittest.mock import patch

if not os.environ.get("RELATUM_DATA_ROOT"):
    os.environ["RELATUM_DATA_ROOT"] = tempfile.mkdtemp(prefix="relatum-review-import-runtime-")

import app
from feature_profile import LaunchProfile


class ReviewImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="relatum-review-import-")
        self.data_patch = patch.object(app, "DATA", Path(self.temp.name))
        self.db_patch = patch.object(app, "REVIEW_DB_FILE", Path(self.temp.name) / "review.db")
        self.data_patch.start()
        self.db_patch.start()

    def tearDown(self):
        self.db_patch.stop()
        self.data_patch.stop()
        self.temp.cleanup()

    def payload(self, rows=None, **values):
        result = {"rows": rows or [{"sourceRow": 2, "prompt": "001", "answer": "第一", "notes": "line one\nline two",
                                    "deckName": "Vocabulary", "tags": ["English", "#Exam"]}],
                  "duplicateMode": "skip", "batchId": "batch-00000000000001"}
        result.update(values)
        return result

    def query(self, sql):
        conn = app._review_connect()
        try:
            return [dict(row) for row in conn.execute(sql)]
        finally:
            conn.close()

    def test_preview_does_not_create_organizers_or_cards(self):
        preview = app.preview_review_import(self.payload())
        self.assertEqual(preview["counts"]["new"], 1)
        for table in ("review_cards", "review_decks", "review_tags", "review_imports"):
            self.assertEqual(self.query(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"], 0)

    def test_new_card_keeps_text_and_normal_initial_schedule(self):
        result = app.import_review_cards(self.payload())
        self.assertEqual(result["created"], 1)
        card = app.review_cards_payload()["cards"][0]
        self.assertEqual((card["prompt"], card["notes"], card["deckName"]), ("001", "line one\nline two", "Vocabulary"))
        self.assertEqual((card["type"], card["status"], card["level"], card["reviewCount"], card["due"]),
                         ("basic", "active", 0, 0, date.today().isoformat()))
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM review_events")[0]["n"], 0)

    def test_exact_duplicates_include_tags_and_deck_but_not_progress_or_status(self):
        app.import_review_cards(self.payload())
        card = app.review_cards_payload()["cards"][0]
        app.mark_review_card(card["id"], "remembered")
        before = app.review_cards_payload()["cards"][0]
        row = self.payload()["rows"][0]
        same = {**row, "deckName": "vocabulary", "tags": ["exam", "english"]}
        other_answer = {**row, "answer": "another meaning"}
        other_deck = {**row, "deckName": "Other"}
        other_case = {**row, "prompt": "WORD"}
        result = app.import_review_cards(self.payload([same, same, other_answer, other_deck, other_case], batchId="batch-00000000000002"))
        self.assertEqual((result["created"], result["duplicates"]), (3, 2))
        after = next(item for item in app.review_cards_payload()["cards"] if item["id"] == card["id"])
        self.assertEqual(before, after)

    def test_invalid_rows_require_explicit_choice_and_blank_rows_are_counted(self):
        rows = [{"sourceRow": 3, "prompt": "word", "tags": []},
                {"sourceRow": 4, "prompt": "", "answer": "missing question"},
                {"sourceRow": 5, "blank": True},
                {"sourceRow": 6, "prompt": "x", "tags": [str(i) for i in range(13)]},
                {"sourceRow": 7, "prompt": "x", "sourceError": "formula-cache"},
                {"sourceRow": 8, "prompt": "x" * (app.REVIEW_PROMPT_MAX + 1)}]
        payload = self.payload(rows)
        preview = app.preview_review_import(payload)
        self.assertEqual(preview["counts"], {"new": 1, "duplicate": 0, "invalid": 4, "blank": 1, "total": 6})
        self.assertEqual(preview["rows"][1]["sourceRow"], 4)
        with self.assertRaises(app.ReviewImportError):
            app.import_review_cards(payload)
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM review_cards")[0]["n"], 0)
        result = app.import_review_cards({**payload, "skipInvalid": True})
        self.assertEqual((result["created"], result["invalid"], result["blank"]), (1, 4, 1))

    def test_retries_are_idempotent_even_when_duplicates_are_allowed(self):
        payload = self.payload(duplicateMode="keep")
        first = app.import_review_cards(payload)
        second = app.import_review_cards(payload)
        self.assertEqual(first["created"], second["created"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(len(app.review_cards_payload()["cards"]), 1)
        changed = copy.deepcopy(payload)
        changed["rows"][0]["answer"] = "changed"
        with self.assertRaises(app.ReviewImportError) as context:
            app.import_review_cards(changed)
        self.assertEqual(context.exception.code, "batch-conflict")
        third = app.import_review_cards({**payload, "batchId": "batch-00000000000003"})
        self.assertEqual(third["created"], 1)
        self.assertEqual(len(app.review_cards_payload()["cards"]), 2)

    def test_database_error_rolls_back_cards_tags_decks_and_receipt(self):
        conn = app._review_connect()
        conn.execute("""CREATE TRIGGER fail_import BEFORE INSERT ON review_cards WHEN NEW.prompt = 'explode'
                        BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
        conn.close()
        rows = self.payload()["rows"] + [{"prompt": "explode", "deckName": "new deck", "tags": ["new tag"]}]
        with self.assertRaises(sqlite3.Error):
            app.import_review_cards(self.payload(rows))
        for table in ("review_cards", "review_decks", "review_tags", "review_imports"):
            self.assertEqual(self.query(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"], 0)

    def test_concurrent_same_batch_only_commits_once(self):
        self.query("SELECT 1")
        payload = self.payload([{"prompt": str(i), "answer": str(i)} for i in range(100)], duplicateMode="keep")
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(app.import_review_cards, [payload, payload]))
        self.assertEqual(sum(bool(result.get("idempotent")) for result in results), 1)
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM review_cards")[0]["n"], 100)

    def test_v3_upgrade_preserves_existing_cards_and_events(self):
        app.create_review_card({"prompt": "existing", "answer": "keep"})
        card = app.review_cards_payload()["cards"][0]
        app.mark_review_card(card["id"], "remembered")
        before = app.review_cards_payload()["cards"][0]
        conn = app._review_connect()
        conn.execute("DROP TABLE review_imports")
        conn.execute("PRAGMA user_version = 3")
        conn.commit()
        conn.close()
        self.assertEqual(app.review_cards_payload()["cards"][0], before)
        self.assertEqual(self.query("PRAGMA user_version")[0]["user_version"], 5)
        self.assertEqual(self.query("SELECT COUNT(*) AS n FROM review_events")[0]["n"], 1)

    def test_ten_thousand_rows_use_one_transaction_and_no_single_create_calls(self):
        statements = []
        connect = app._review_connect
        connect().close()
        def traced():
            conn = connect()
            conn.set_trace_callback(statements.append)
            return conn
        rows = [{"sourceRow": i + 2, "prompt": f"word-{i:05}", "answer": f"释义 {i}",
                 "deckName": "Large", "tags": ["English", "Imported"]} for i in range(10000)]
        started = time.perf_counter()
        with patch.object(app, "_review_connect", traced), patch.object(app, "create_review_card", side_effect=AssertionError("single create")):
            result = app.import_review_cards(self.payload(rows))
        elapsed = time.perf_counter() - started
        self.assertEqual(result["created"], 10000)
        self.assertEqual(sum(sql == "COMMIT" for sql in statements), 1)
        self.assertLess(sum(sql.lstrip().upper().startswith("SELECT") for sql in statements), 12)
        print(f"review import 10000 rows: {elapsed:.3f}s")

    def test_limits_and_feature_resources(self):
        with self.assertRaises(app.ReviewImportError):
            app.preview_review_import(self.payload([{}] * 10001))
        disabled = LaunchProfile({"canvas.review": False}, restricted=True)
        for name in ("review-import.js", "review-import-model.js", "review-import-worker.js", "review-import.css", "vendor/sheetjs/xlsx.full.min.js"):
            self.assertFalse(disabled.resource_allowed(name), name)
        self.assertFalse(disabled.write_allowed("/api/review-import"))
        self.assertFalse(disabled.write_allowed("/api/review-import-preview"))

    def test_http_feature_gate_and_body_limit_precede_database_access(self):
        class QuietHandler(app.Handler):
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        server.launch_profile = LaunchProfile({"canvas.review": False}, restricted=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(path, length=None):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                payload = json.dumps(self.payload()).encode("utf-8")
                conn.request("POST", path, body=b"" if length else payload,
                             headers={"Content-Type": "application/json", "Content-Length": str(length or len(payload))})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally:
                conn.close()
        try:
            for path in ("/api/review-import-preview", "/api/review-import"):
                status, result = request(path)
                self.assertEqual((status, result["code"]), (403, "feature-disabled"))
            self.assertFalse(app.REVIEW_DB_FILE.exists())
            server.launch_profile = app.FULL_PROFILE
            status, result = request("/api/review-import", app.REVIEW_IMPORT_BODY_MAX + 1)
            self.assertEqual((status, result["code"]), (413, "body-limit"))
            self.assertFalse(app.REVIEW_DB_FILE.exists())
            status, result = request("/api/review-import-preview")
            self.assertEqual((status, result["counts"]["new"]), (200, 1))
            self.assertEqual(self.query("SELECT COUNT(*) AS n FROM review_cards")[0]["n"], 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
