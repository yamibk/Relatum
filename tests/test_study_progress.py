import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app


class StudyProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_study_file = app.STUDY_FILE
        self.original_archive_dir = app.STUDY_ARCHIVE_DIR
        root = Path(self.temp_dir.name)
        app.STUDY_FILE = root / "study.json"
        app.STUDY_ARCHIVE_DIR = root / "archives"

    def tearDown(self):
        app.STUDY_FILE = self.original_study_file
        app.STUDY_ARCHIVE_DIR = self.original_archive_dir
        self.temp_dir.cleanup()

    def test_v1_is_not_migrated(self):
        app.STUDY_FILE.write_text(json.dumps({
            "version": 1,
            "tasks": [{"id": "old", "title": "旧任务", "status": "todo"}],
        }), encoding="utf-8")
        self.assertEqual(app.load_study(), {"version": 2, "tasks": [], "trash": []})

    def test_create_defaults_to_unset_progress(self):
        task = app._study_task({"title": "线性代数"})
        self.assertEqual(task["status"], "active")
        self.assertEqual(task["progress"], {
            "current": 0, "target": 0, "milestones": [],
        })
        self.assertNotIn("due", task)
        self.assertNotIn("linkedCanvas", task)

    def test_progress_config_is_validated(self):
        task = app._study_task({"title": "刷题"})
        updated = app._study_task({"progress": {
            "target": 20,
            "milestones": [
                {"id": "m1", "name": "基础", "at": 5},
                {"id": "m2", "name": "综合", "at": 15},
            ],
        }}, existing=task)
        self.assertEqual(updated["progress"]["target"], 20)
        self.assertEqual([item["at"] for item in updated["progress"]["milestones"]], [5, 15])
        with self.assertRaises(ValueError):
            app._study_task({"progress": {
                "target": 10,
                "milestones": [{"name": "越界", "at": 11}],
            }}, existing=task)
        with self.assertRaisesRegex(ValueError, "目标总量需要是整数"):
            app._study_task({"progress": {"target": 1.5}}, existing=task)
        with self.assertRaisesRegex(ValueError, "任务点位置需要是整数"):
            app._study_task({"progress": {
                "target": 10, "milestones": [{"name": "一半", "at": 2.5}],
            }}, existing=task)

    def test_target_cannot_drop_below_current(self):
        task = app._study_task({"title": "阅读"})
        task["progress"] = {"current": 7, "target": 10, "milestones": []}
        with self.assertRaises(ValueError):
            app._study_task({"progress": {
                "target": 6, "milestones": [],
            }}, existing=task)

    def test_completion_is_independent_from_progress(self):
        task = app._study_task({"title": "课程"})
        task["progress"] = {"current": 4, "target": 8, "milestones": []}
        done = app._study_task({"status": "done"}, existing=task)
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["progress"]["current"], 4)
        self.assertTrue(done["completedAt"])
        active = app._study_task({"status": "active"}, existing=done)
        self.assertEqual(active["progress"]["current"], 4)
        self.assertEqual(active["completedAt"], "")

    def test_milestone_name_limits_are_validated(self):
        with self.assertRaisesRegex(ValueError, "任务点名称最多"):
            app._study_task({"progress": {
                "target": 2,
                "milestones": [{"at": 1, "name": "x" * 41}],
            }})

    def test_unit_progress_boundaries_and_milestone_crossing(self):
        task = app._study_task({"title": "书", "progress": {
            "target": 2,
            "milestones": [{"id": "middle", "at": 1, "name": "过半"}],
        }})
        data = {"version": 2, "tasks": [task], "trash": []}
        first = app.change_study_progress(data, task["id"], 1)
        self.assertEqual(first["crossedMilestoneIds"], ["middle"])
        self.assertFalse(first["targetReached"])
        second = app.change_study_progress(data, task["id"], 1)
        self.assertTrue(second["targetReached"])
        capped = app.change_study_progress(data, task["id"], 1)
        self.assertEqual(capped["task"]["progress"]["current"], 2)
        app.change_study_progress(data, task["id"], -1)
        app.change_study_progress(data, task["id"], -1)
        floored = app.change_study_progress(data, task["id"], -1)
        self.assertEqual(floored["task"]["progress"]["current"], 0)

    def test_done_and_unset_tasks_reject_progress_changes(self):
        unset = app._study_task({"title": "未设置"})
        with self.assertRaisesRegex(RuntimeError, "设置目标"):
            app.change_study_progress({"tasks": [unset]}, unset["id"], 1)
        done = app._study_task({"status": "done", "progress": {"target": 1}})
        with self.assertRaisesRegex(RuntimeError, "恢复任务"):
            app.change_study_progress({"tasks": [done]}, done["id"], 1)

    def test_study_trash_is_capped_on_disk(self):
        trash = []
        for index in range(app.STUDY_TRASH_MAX + 5):
            task = app._study_task({"title": f"任务 {index}"})
            trash.append({"task": task, "deletedAt": task["updatedAt"]})
        app.save_study({"version": 2, "tasks": [], "trash": trash})
        loaded = app.load_study()
        self.assertEqual(len(loaded["trash"]), app.STUDY_TRASH_MAX)
        self.assertEqual(loaded["trash"][0]["task"]["title"], "任务 0")

    def test_archive_rolls_back_marker_when_study_save_fails(self):
        task = app._study_task({"title": "待归档", "status": "done"})
        app.save_study({"version": 2, "tasks": [task], "trash": []})

        class CaptureHandler:
            def __init__(self):
                self.response = None

            def _send_json(self, status, payload):
                self.response = (status, payload)
                return self.response

        handler = CaptureHandler()
        with mock.patch.object(app, "save_study", side_effect=OSError("disk full")):
            app.Handler._api_study_archive_done(handler)

        self.assertEqual(handler.response[0], 500)
        self.assertEqual(list(app.STUDY_ARCHIVE_DIR.iterdir()), [])
        self.assertEqual(app.load_study()["tasks"][0]["id"], task["id"])


if __name__ == "__main__":
    unittest.main()
