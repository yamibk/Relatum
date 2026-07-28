import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app


class TaskbookArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.canvases = self.root / "canvases"
        self.archives = self.root / "data" / "学习归档"
        self.canvases.mkdir(parents=True)
        self.original_canvases = app.CANVASES
        self.original_archives = app.STUDY_ARCHIVE_DIR
        app.CANVASES = self.canvases
        app.STUDY_ARCHIVE_DIR = self.archives
        self.canvas_path = self.canvases / "work.canvas"

    def tearDown(self):
        app.CANVASES = self.original_canvases
        app.STUDY_ARCHIVE_DIR = self.original_archives
        self.temp_dir.cleanup()

    def source_canvas(self, *, completed=True):
        return {
            "version": 2,
            "nodes": [
                {"id": "projection", "kind": "task-root", "taskRootId": "root-1", "x": 10, "y": 20},
                {"id": "parent", "kind": "card", "text": "Parent", "strike": False},
                {"id": "leaf", "kind": "card", "text": "Leaf", "strike": completed},
                {"id": "group", "kind": "group", "groupMemberIds": ["parent", "leaf"]},
            ],
            "edges": [
                {"id": "workflow-1", "from": "projection", "to": "parent", "role": "task-workflow"},
                {"id": "workflow-2", "from": "parent", "to": "leaf", "role": "task-workflow"},
                {"id": "ordinary", "from": "leaf", "to": "group"},
            ],
            "taskbook": {
                "version": 2,
                "roots": [{
                    "id": "root-1",
                    "title": "Write paper",
                    "completed": completed,
                    "canvasNodeId": "projection",
                    "members": [
                        {"nodeId": "parent", "parentNodeId": None, "order": 0},
                        {"nodeId": "leaf", "parentNodeId": "parent", "order": 0},
                    ],
                    "sessions": [{"id": "s1", "durationMs": 90000}],
                    "activeSession": None,
                }],
            },
        }

    def transformed_canvas(self):
        return {
            "version": 2,
            "nodes": [
                {
                    "id": "snapshot-root",
                    "kind": "card",
                    "text": "Write paper",
                    "archiveCover": True,
                },
                {"id": "copy-parent", "kind": "card", "text": "Parent", "strike": True},
                {"id": "copy-leaf", "kind": "card", "text": "Leaf", "strike": True},
                {"id": "group", "kind": "group"},
            ],
            "edges": [
                {
                    "id": "copy-edge-1",
                    "from": "snapshot-root",
                    "to": "copy-parent",
                    "curve": "branch",
                    "arrow": "end",
                },
                {
                    "id": "copy-edge-2",
                    "from": "copy-parent",
                    "to": "copy-leaf",
                    "curve": "branch",
                    "arrow": "end",
                },
            ],
        }

    def write_source(self, *, completed=True):
        self.canvas_path.write_text(
            json.dumps(self.source_canvas(completed=completed), ensure_ascii=False),
            encoding="utf-8",
        )

    def archive(self, archive_id="taskbook-archive-stable"):
        return app.archive_taskbook_canvas(
            self.canvas_path,
            root_id="root-1",
            archive_id=archive_id,
            retain_snapshot=True,
            snapshot_root_node_id="snapshot-root",
            transformed_canvas=self.transformed_canvas(),
        )

    def test_archive_is_idempotent_and_appears_in_activity(self):
        self.write_source()
        first = self.archive()
        second = self.archive()

        self.assertFalse(first["idempotent"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(first["archiveId"], second["archiveId"])
        self.assertEqual(first["leafCount"], 1)
        self.assertEqual(first["durationMs"], 90000)
        self.assertEqual(
            len(list(self.archives.glob("*/taskbook.json"))),
            1,
        )
        saved = json.loads(self.canvas_path.read_text(encoding="utf-8"))
        self.assertNotIn("taskbook", saved)
        self.assertEqual({node["id"] for node in saved["nodes"]}, {
            "snapshot-root", "copy-parent", "copy-leaf", "group",
        })

        counts, records = app.study_activity_records()
        record = next(item for item in records if item["kind"] == "taskbook")
        self.assertEqual(record["title"], "Write paper")
        self.assertEqual(record["leafCount"], 1)
        self.assertEqual(record["durationMs"], 90000)
        self.assertTrue(record["canvasAvailable"])
        self.assertEqual(sum(counts.values()), 1)
        self.assertEqual(app._archive_folder_count(), 1)

    def test_incomplete_leaf_is_rejected(self):
        self.write_source(completed=False)
        with self.assertRaisesRegex(ValueError, "未完成"):
            self.archive()
        self.assertFalse(self.archives.exists())
        source = json.loads(self.canvas_path.read_text(encoding="utf-8"))
        self.assertIn("taskbook", source)

    def test_completed_standalone_root_can_be_archived(self):
        source = {
            "version": 2,
            "nodes": [
                {
                    "id": "projection",
                    "kind": "task-root",
                    "taskRootId": "root-1",
                    "x": 10,
                    "y": 20,
                },
            ],
            "edges": [],
            "taskbook": {
                "version": 2,
                "roots": [{
                    "id": "root-1",
                    "title": "Standalone",
                    "completed": True,
                    "canvasNodeId": "projection",
                    "members": [],
                    "sessions": [],
                    "activeSession": None,
                }],
            },
        }
        transformed = {
            "version": 2,
            "nodes": [{
                "id": "snapshot-root",
                "kind": "card",
                "text": "Standalone",
                "archiveCover": True,
            }],
            "edges": [],
        }
        self.canvas_path.write_text(
            json.dumps(source, ensure_ascii=False),
            encoding="utf-8",
        )

        result = app.archive_taskbook_canvas(
            self.canvas_path,
            root_id="root-1",
            archive_id="taskbook-archive-standalone",
            retain_snapshot=True,
            snapshot_root_node_id="snapshot-root",
            transformed_canvas=transformed,
        )

        self.assertEqual(result["leafCount"], 1)
        saved = json.loads(self.canvas_path.read_text(encoding="utf-8"))
        self.assertNotIn("taskbook", saved)
        self.assertEqual(saved["nodes"][0]["archiveCover"], True)

    def test_canvas_write_failure_rolls_back_marker(self):
        self.write_source()
        original_write = app._atomic_write_json

        def fail_canvas(target, data, **kwargs):
            if Path(target) == self.canvas_path:
                raise OSError("simulated canvas failure")
            return original_write(target, data, **kwargs)

        with mock.patch.object(app, "_atomic_write_json", side_effect=fail_canvas):
            with self.assertRaisesRegex(OSError, "simulated"):
                self.archive()

        self.assertEqual(list(self.archives.glob("*/taskbook.json")), [])
        source = json.loads(self.canvas_path.read_text(encoding="utf-8"))
        self.assertIn("taskbook", source)


if __name__ == "__main__":
    unittest.main()
