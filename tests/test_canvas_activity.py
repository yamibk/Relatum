import json
import tempfile
import unittest
from pathlib import Path

import app


class CanvasActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.data = self.root / "data"
        self.canvases = self.root / "canvases"
        self.trash = self.canvases / "回收站"
        self.data.mkdir(parents=True)
        self.canvases.mkdir(parents=True)
        self.originals = {
            "ROOT": app.ROOT,
            "DATA": app.DATA,
            "CANVASES": app.CANVASES,
            "TRASH": app.TRASH,
            "RECENT_FILE": app.RECENT_FILE,
            "RECENT_BACKUP_FILE": app.RECENT_BACKUP_FILE,
            "CANVAS_ACTIVITY_FILE": app.CANVAS_ACTIVITY_FILE,
        }
        app.ROOT = self.root
        app.DATA = self.data
        app.CANVASES = self.canvases
        app.TRASH = self.trash
        app.RECENT_FILE = self.data / "recent.json"
        app.RECENT_BACKUP_FILE = self.data / "recent.backup.json"
        app.CANVAS_ACTIVITY_FILE = self.data / "canvas-activity.json"
        self.canvas = self.canvases / "ideas.canvas"

    def tearDown(self):
        for name, value in self.originals.items():
            setattr(app, name, value)
        self.temp_dir.cleanup()

    def write_canvas(self):
        payload = {
            "version": 2,
            "createdAt": "2025-02-03T09:00:00",
            "updatedAt": "2025-04-05T18:30:00",
            "nodes": [],
            "edges": [],
        }
        self.canvas.write_text(json.dumps(payload), encoding="utf-8")
        app.register_recent(self.canvas)
        return payload

    def interval(self, started, ended, session="session-123456"):
        return app.record_canvas_activity_interval({
            "path": str(self.canvas),
            "sessionId": session,
            "startedAt": started,
            "endedAt": ended,
        })

    def test_backfill_marks_dates_without_inventing_duration(self):
        self.write_canvas()
        snapshot = app.canvas_activity_snapshot()
        payload = app._canvas_activity_payload(snapshot, 2025)

        self.assertEqual(payload["days"]["2025-02-03"]["createdCount"], 1)
        self.assertEqual(payload["days"]["2025-04-05"]["modifiedCount"], 1)
        self.assertEqual(payload["stats"]["yearSec"], 0)
        self.assertTrue(payload["days"]["2025-02-03"]["inferred"])

    def test_overlapping_heartbeats_are_merged(self):
        self.write_canvas()
        app.canvas_activity_register_path(self.canvas)
        self.interval("2025-06-01T10:00:00", "2025-06-01T10:01:00")
        totals = self.interval("2025-06-01T10:00:30", "2025-06-01T10:01:30")

        snapshot = app.canvas_activity_snapshot()
        payload = app._canvas_activity_payload(snapshot, 2025)
        self.assertEqual(payload["days"]["2025-06-01"]["durationSec"], 90)
        self.assertEqual(totals["totalSec"], 90)

    def test_interval_is_split_at_local_midnight(self):
        self.write_canvas()
        app.canvas_activity_register_path(self.canvas)
        self.interval("2025-06-01T23:59:50", "2025-06-02T00:00:10")

        snapshot = app.canvas_activity_snapshot()
        payload = app._canvas_activity_payload(snapshot, 2025)
        self.assertEqual(payload["days"]["2025-06-01"]["durationSec"], 10)
        self.assertEqual(payload["days"]["2025-06-02"]["durationSec"], 10)

    def test_managed_move_preserves_canvas_identity(self):
        self.write_canvas()
        before = app.canvas_activity_register_path(self.canvas)
        renamed = self.canvases / "renamed.canvas"
        self.canvas.rename(renamed)
        app.move_canvas_activity_path(self.canvas, renamed)
        after = app.canvas_activity_register_path(renamed)

        self.assertEqual(before["canvasId"], after["canvasId"])
        snapshot = app.canvas_activity_snapshot()
        self.assertEqual(snapshot["canvases"][before["canvasId"]]["path"], str(renamed.resolve()))

        # 原路径若日后被另一个文件复用，不能错误继承已重命名画布的历史。
        self.canvas.write_text(json.dumps({"version": 2, "nodes": [], "edges": []}), encoding="utf-8")
        replacement = app.canvas_activity_register_path(self.canvas)
        self.assertNotEqual(before["canvasId"], replacement["canvasId"])

    def test_corrupt_ledger_and_invalid_interval_degrade_safely(self):
        self.write_canvas()
        app.CANVAS_ACTIVITY_FILE.write_text("{not-json", encoding="utf-8")
        registered = app.canvas_activity_register_path(self.canvas)
        self.assertTrue(registered["canvasId"])
        json.loads(app.CANVAS_ACTIVITY_FILE.read_text(encoding="utf-8"))

        with self.assertRaises(ValueError):
            self.interval("2025-06-01T10:00:00", "2025-06-01T10:11:00")

    def test_unauthorized_path_is_rejected(self):
        outside = self.root / "outside.canvas"
        outside.write_text(json.dumps({"version": 2, "nodes": []}), encoding="utf-8")
        with self.assertRaises(PermissionError):
            app.record_canvas_activity_interval({
                "path": str(outside),
                "sessionId": "session-123456",
                "startedAt": "2025-06-01T10:00:00",
                "endedAt": "2025-06-01T10:00:30",
            })


if __name__ == "__main__":
    unittest.main()
