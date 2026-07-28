import tempfile
import unittest
from pathlib import Path

import app


class TaskbookFocusTests(unittest.TestCase):
    def setUp(self):
        self.original_focus_file = app.FOCUS_FILE
        self.temp_dir = tempfile.TemporaryDirectory()
        app.FOCUS_FILE = Path(self.temp_dir.name) / "focus.json"

    def tearDown(self):
        app.FOCUS_FILE = self.original_focus_file
        self.temp_dir.cleanup()

    def _session(self, session_id="task-segment-stable"):
        return {
            "id": session_id,
            "mode": "countup",
            "durationSec": 75,
            "taskId": "taskbook:task-root-1:node-1",
            "taskTitle": "整理资料",
            "goal": "论文初稿",
            "endedAt": "2026-07-28T08:30:00+08:00",
            "source": {
                "kind": "taskbook",
                "rootId": "task-root-1",
                "rootTitle": "论文初稿",
                "canvasPath": str(Path(self.temp_dir.name) / "old.canvas"),
                "nodeId": "node-1",
            },
        }

    def test_single_append_is_idempotent_and_keeps_v2_source(self):
        first = app.append_focus_session(self._session())
        second = app.append_focus_session(self._session())

        self.assertEqual(len(first["sessions"]), 1)
        self.assertEqual(len(second["sessions"]), 1)
        source = first["sessions"][0]["source"]
        self.assertEqual(source["kind"], "taskbook")
        self.assertEqual(source["rootId"], "task-root-1")
        self.assertEqual(source["rootTitle"], "论文初稿")
        self.assertEqual(source["nodeId"], "node-1")

    def test_canvas_rename_rewrites_passive_focus_source(self):
        app.append_focus_session(self._session())
        old_path = Path(self.temp_dir.name) / "old.canvas"
        new_path = Path(self.temp_dir.name) / "renamed.canvas"

        changed = app.rewrite_taskbook_focus_canvas_path(old_path, new_path)
        payload = app.load_focus()

        self.assertEqual(changed, 1)
        self.assertEqual(
            Path(payload["sessions"][0]["source"]["canvasPath"]),
            new_path,
        )

    def test_v1_completion_source_is_not_kept(self):
        legacy = self._session("legacy")
        legacy["source"] = {
            "kind": "taskbook",
            "completionId": "completion-1",
            "canvasPath": str(Path(self.temp_dir.name) / "old.canvas"),
            "groupNodeId": "group-1",
        }
        payload = app.append_focus_session(legacy)
        self.assertNotIn("source", payload["sessions"][0])

    def test_managed_ids_are_read_from_v2_members(self):
        payload = {
            "taskbook": {
                "version": 2,
                "roots": [
                    {"id": "root-a", "members": [{"nodeId": "a"}, {"nodeId": "b"}]},
                    {"id": "root-b", "members": [{"nodeId": "c"}]},
                ],
            }
        }
        self.assertEqual(app._taskbook_managed_node_ids(payload), {"a", "b", "c"})


if __name__ == "__main__":
    unittest.main()
