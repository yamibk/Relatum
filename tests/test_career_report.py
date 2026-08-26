import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

import app
from notes_library import NotesStore, note_word_count


class CareerReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.canvases = self.root / "canvases"
        self.notes = self.root / "notes"
        self.data.mkdir()
        self.canvases.mkdir()
        self.notes.mkdir()
        names = [
            "ROOT", "DATA", "CANVASES", "TRASH", "NOTES", "RECENT_FILE",
            "RECENT_BACKUP_FILE", "CANVAS_ACTIVITY_FILE", "START_PAGE_ACTIVITY_FILE",
            "STUDY_FILE", "TREE_PAGE_FILE", "STUDY_ARCHIVE_DIR", "CANVAS_ARCHIVE_DIR",
            "FOCUS_FILE", "DAILY_FILE", "DIARY_DIR", "REVIEW_DB_FILE",
            "CAREER_REPORT_FILE", "NOTES_STORE",
        ]
        self.originals = {name: getattr(app, name) for name in names}
        app.ROOT = self.root
        app.DATA = self.data
        app.CANVASES = self.canvases
        app.TRASH = self.canvases / "回收站"
        app.NOTES = self.notes
        app.RECENT_FILE = self.data / "recent.json"
        app.RECENT_BACKUP_FILE = self.data / "recent.backup.json"
        app.CANVAS_ACTIVITY_FILE = self.data / "canvas-activity.json"
        app.START_PAGE_ACTIVITY_FILE = self.data / "start-page-activity.json"
        app.STUDY_FILE = self.data / "study.json"
        app.TREE_PAGE_FILE = self.data / "tree-page.json"
        app.STUDY_ARCHIVE_DIR = self.data / "学习归档"
        app.CANVAS_ARCHIVE_DIR = self.data / "画布归档"
        app.FOCUS_FILE = self.data / "focus.json"
        app.DAILY_FILE = self.data / "daily.json"
        app.DIARY_DIR = self.data / "diary"
        app.REVIEW_DB_FILE = self.data / "review.db"
        app.CAREER_REPORT_FILE = self.data / "career-report.json"
        app.NOTES_STORE = NotesStore(self.notes, recovery_root=self.data / "note-recovery")

    def tearDown(self):
        for name, value in self.originals.items():
            setattr(app, name, value)
        self.temp.cleanup()

    def write_fixture(self):
        canvas = self.canvases / "Math.canvas"
        canvas.write_text(json.dumps({
            "version": 2,
            "createdAt": "2025-01-02T08:00:00",
            "updatedAt": "2025-02-03T08:00:00",
            "nodes": [
                {"id": "n1", "kind": "card", "text": "Limits", "body": "Definition"},
                {"id": "n2", "kind": "table", "body": "|a|b|"},
            ],
            "edges": [{"id": "e1", "from": "n1", "to": "n2"}],
            "ink": {"strokes": [{"id": "s1"}], "arrows": []},
        }), encoding="utf-8")
        (self.notes / "A.md").write_text("你好 world [[B]]", encoding="utf-8")
        (self.notes / "B.md").write_text("second note", encoding="utf-8")
        app.CANVAS_ACTIVITY_FILE.write_text(json.dumps({
            "version": 1,
            "backfillVersion": 1,
            "canvases": {"canvas-1": {"path": str(canvas), "title": "Math", "aliases": [], "backfilled": True}},
            "paths": {str(canvas): "canvas-1"},
            "days": {
                "2025-02-03": {"canvas-1": {"spans": [[3600, 4200]], "seconds": 600, "created": False, "modified": True, "inferred": False}},
            },
        }), encoding="utf-8")
        app.FOCUS_FILE.write_text(json.dumps({
            "version": 1, "sessions": [],
            "days": {"2025-02-04": {"sec": 1200, "count": 1}}, "tasks": {},
        }), encoding="utf-8")
        app.DAILY_FILE.write_text(json.dumps({
            "version": 3, "tasks": [{"id": "d1", "name": "Read", "doneDates": ["2025-02-04"]}],
        }), encoding="utf-8")

    def test_word_count_matches_notes_contract(self):
        self.assertEqual(note_word_count("hello-world 你好 test_case"), 4)
        self.assertEqual(note_word_count("日本語 and français"), 5)

    def test_missing_snapshot_read_does_not_generate_or_scan(self):
        self.assertEqual(app.load_career_report(), {"version": 1, "exists": False})
        self.assertFalse(app.CAREER_REPORT_FILE.exists())

    def test_report_aggregates_without_bodies_or_paths(self):
        self.write_fixture()
        archive = app.STUDY_ARCHIVE_DIR / "quick-archive"
        archive.mkdir(parents=True)
        (archive / "notes.json").write_text(json.dumps({
            "archivedAt": "2025-02-05T09:00:00",
            "notes": [{"text": "private quick-note body"}],
        }), encoding="utf-8")
        report = app.generate_career_report()

        self.assertEqual(report["canvases"]["count"], 1)
        self.assertEqual(report["canvases"]["nodeCount"], 2)
        self.assertEqual(report["canvases"]["edgeCount"], 1)
        self.assertEqual(report["canvases"]["inkCount"], 1)
        self.assertEqual(report["overview"]["canvasSec"], 600)
        self.assertEqual(report["overview"]["focusSec"], 1200)
        self.assertEqual(report["notes"]["count"], 2)
        self.assertEqual(report["notes"]["wordCount"], 6)
        self.assertEqual(report["overview"]["activeDays"], 3)
        serialized = json.dumps(report, ensure_ascii=False)
        self.assertNotIn(str(self.root), serialized)
        self.assertNotIn("你好 world", serialized)
        self.assertNotIn("private quick-note body", serialized)
        self.assertTrue(app.CAREER_REPORT_FILE.is_file())

    def test_snapshot_stays_frozen_until_regenerated(self):
        self.write_fixture()
        first = app.generate_career_report()
        (self.notes / "A.md").write_text("你好 world [[B]] added words", encoding="utf-8")

        frozen = app.load_career_report()["report"]
        self.assertEqual(frozen["notes"]["wordCount"], first["notes"]["wordCount"])
        regenerated = app.generate_career_report()
        self.assertGreater(regenerated["notes"]["wordCount"], first["notes"]["wordCount"])

    def test_generation_failure_preserves_previous_snapshot(self):
        self.write_fixture()
        original = app.generate_career_report()
        original_bytes = app.CAREER_REPORT_FILE.read_bytes()
        with mock.patch.object(app, "_atomic_write_json", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                app.generate_career_report()
        self.assertEqual(app.CAREER_REPORT_FILE.read_bytes(), original_bytes)
        self.assertEqual(app.load_career_report()["report"]["generatedAt"], original["generatedAt"])

    def test_corrupt_optional_sources_do_not_block_report(self):
        (self.canvases / "bad.canvas").write_text("{broken", encoding="utf-8")
        app.CANVAS_ACTIVITY_FILE.write_text("{broken", encoding="utf-8")
        app.START_PAGE_ACTIVITY_FILE.write_text("{broken", encoding="utf-8")
        app.FOCUS_FILE.write_text("{broken", encoding="utf-8")
        app.DAILY_FILE.write_text("{broken", encoding="utf-8")
        bad_archive = app.STUDY_ARCHIVE_DIR / "bad"
        bad_archive.mkdir(parents=True)
        (bad_archive / "tasks.json").write_text("{broken", encoding="utf-8")
        app.REVIEW_DB_FILE.write_bytes(b"not sqlite")
        report = app.generate_career_report()
        statuses = {item["id"]: item["status"] for item in report["coverage"]}
        self.assertEqual(statuses["review"], "unavailable")
        self.assertEqual(statuses["canvases"], "unavailable")
        self.assertEqual(statuses["canvasActivity"], "unavailable")
        self.assertEqual(statuses["pageActivity"], "unavailable")
        self.assertEqual(statuses["focus"], "unavailable")
        self.assertEqual(statuses["daily"], "unavailable")
        self.assertEqual(statuses["archives"], "unavailable")
        self.assertEqual(report["canvases"]["skippedCount"], 1)

    def test_high_density_daily_series_keeps_calendar_gaps_and_caps_at_365(self):
        first = date(2024, 1, 1)
        days = {}
        for index in range(500):
            day = (first + timedelta(days=index)).isoformat()
            days[day] = {
                "canvas-1": {
                    "spans": [[index * 100, index * 100 + 60]],
                    "seconds": 60,
                    "created": False,
                    "modified": index % 4 == 0,
                    "inferred": False,
                },
            }
        app.CANVAS_ACTIVITY_FILE.write_text(json.dumps({
            "version": 1,
            "backfillVersion": 1,
            "canvases": {"canvas-1": {"title": "Dense"}},
            "paths": {},
            "days": days,
        }), encoding="utf-8")
        with mock.patch.object(app, "_study_now", return_value="2025-06-01T12:00:00"):
            report = app.generate_career_report()

        series = report["activity"]["days"]
        self.assertEqual(report["overview"]["activeDays"], 500)
        self.assertEqual(len(series), 365)
        parsed = [date.fromisoformat(item["day"]) for item in series]
        self.assertTrue(all(right - left == timedelta(days=1) for left, right in zip(parsed, parsed[1:])))
        self.assertEqual(series[-1]["day"], "2025-06-01")
        self.assertEqual(series[-1]["canvasSec"], 0)

    def test_inferred_canvas_dates_are_separate_from_real_activity(self):
        app.CANVAS_ACTIVITY_FILE.write_text(json.dumps({
            "version": 1,
            "backfillVersion": 1,
            "canvases": {"canvas-1": {"title": "Imported"}},
            "paths": {},
            "days": {
                "2025-01-02": {
                    "canvas-1": {
                        "spans": [], "seconds": 0, "created": True,
                        "modified": True, "inferred": True,
                    },
                },
                "2025-02-03": {
                    "canvas-1": {
                        "spans": [[3600, 3660]], "seconds": 60,
                        "created": False, "modified": False, "inferred": False,
                    },
                },
            },
        }), encoding="utf-8")
        with mock.patch.object(app, "_study_now", return_value="2025-02-04T12:00:00"):
            report = app.generate_career_report()

        self.assertEqual(report["overview"]["activeDays"], 1)
        self.assertEqual(report["period"]["firstDay"], "2025-02-03")
        self.assertEqual(report["activity"]["inferredDays"], [{"day": "2025-01-02", "events": 2}])


if __name__ == "__main__":
    unittest.main()
