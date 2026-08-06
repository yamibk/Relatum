import json
import tempfile
import unittest
from pathlib import Path

import app


class DailyGoalTests(unittest.TestCase):
    def setUp(self):
        self.original_daily_file = app.DAILY_FILE
        self.temp_dir = tempfile.TemporaryDirectory()
        app.DAILY_FILE = Path(self.temp_dir.name) / "daily.json"

    def tearDown(self):
        app.DAILY_FILE = self.original_daily_file
        self.temp_dir.cleanup()

    def test_legacy_v3_task_defaults_to_no_cumulative_goal(self):
        app.DAILY_FILE.write_text(json.dumps({
            "version": 3,
            "date": app._today_iso(),
            "tasks": [{
                "id": "legacy",
                "name": "旧任务",
                "targetMinutes": 25,
                "totalDays": 7,
                "doneDates": [],
            }],
            "groups": [],
        }), encoding="utf-8")

        loaded = app.load_daily()
        public = app.daily_public_payload(loaded)

        self.assertEqual(loaded["version"], 3)
        self.assertEqual(loaded["tasks"][0]["targetDays"], 0)
        self.assertEqual(loaded["tasks"][0]["milestones"], [])
        self.assertEqual(public["tasks"][0]["targetDays"], 0)
        self.assertEqual(public["tasks"][0]["milestones"], [])
        self.assertEqual(public["tasks"][0]["totalDays"], 7)

    def test_create_update_cap_and_clear_cumulative_goal(self):
        created = app.daily_create({"name": "阅读", "targetDays": 30})
        task_id = created["tasks"][0]["id"]
        self.assertEqual(created["tasks"][0]["targetDays"], 30)

        capped = app.daily_update({"id": task_id, "targetDays": 999999})
        self.assertEqual(capped["tasks"][0]["targetDays"], app.DAILY_GOAL_DAYS_MAX)

        cleared = app.daily_update({"id": task_id, "targetDays": ""})
        self.assertEqual(cleared["tasks"][0]["targetDays"], 0)

        normalized = app.daily_update({"id": task_id, "targetDays": -10})
        self.assertEqual(normalized["tasks"][0]["targetDays"], 0)

    def test_check_in_and_undo_preserve_cumulative_goal(self):
        created = app.daily_create({
            "name": "练习",
            "targetDays": 100,
            "milestones": [{"name": "起步", "days": 1}, {"name": "毕业", "days": 100}],
        })
        task_id = created["tasks"][0]["id"]
        milestones = created["tasks"][0]["milestones"]

        checked = app.daily_toggle({"id": task_id, "done": True})
        self.assertTrue(checked["tasks"][0]["doneToday"])
        self.assertEqual(checked["tasks"][0]["totalDays"], 1)
        self.assertEqual(checked["tasks"][0]["targetDays"], 100)
        self.assertEqual(checked["tasks"][0]["milestones"], milestones)

        undone = app.daily_toggle({"id": task_id, "done": False})
        self.assertFalse(undone["tasks"][0]["doneToday"])
        self.assertEqual(undone["tasks"][0]["totalDays"], 0)
        self.assertEqual(undone["tasks"][0]["targetDays"], 100)
        self.assertEqual(undone["tasks"][0]["milestones"], milestones)

        focused = app.daily_add_minutes({"id": task_id, "minutes": 25})
        self.assertEqual(focused["tasks"][0]["milestones"], milestones)

    def test_create_and_update_six_sorted_milestones_with_stable_ids(self):
        source = [
            {"id": "finish", "name": "毕业", "days": 100},
            {"name": "第一周", "days": 7},
            {"name": "第一个月", "days": 30},
            {"name": "稳定", "days": 60},
            {"name": "起步", "days": 1},
            {"name": "半程", "days": 50},
        ]
        created = app.daily_create({"name": "阅读", "targetDays": 100, "milestones": source})
        task = created["tasks"][0]
        self.assertEqual([item["days"] for item in task["milestones"]], [1, 7, 30, 50, 60, 100])
        self.assertEqual(task["milestones"][-1]["id"], "finish")
        self.assertTrue(all(item["id"] for item in task["milestones"]))

        renamed = [dict(item) for item in task["milestones"]]
        renamed[1]["name"] = "坚持一周"
        updated = app.daily_update({"id": task["id"], "milestones": renamed})["tasks"][0]
        self.assertEqual(updated["milestones"][1]["name"], "坚持一周")
        self.assertEqual(updated["milestones"][1]["id"], task["milestones"][1]["id"])

        cleared = app.daily_update({"id": task["id"], "milestones": []})["tasks"][0]
        self.assertEqual(cleared["milestones"], [])

    def test_rejects_invalid_milestones_and_target_conflicts_atomically(self):
        created = app.daily_create({
            "name": "运动",
            "targetDays": 30,
            "milestones": [{"id": "week", "name": "第一周", "days": 7}],
        })
        task_id = created["tasks"][0]["id"]
        invalid_sets = [
            [{"name": str(index), "days": index + 1} for index in range(7)],
            [{"name": "", "days": 1}],
            [{"name": "x" * 41, "days": 1}],
            [{"name": "一", "days": 7}, {"name": "二", "days": 7}],
            [{"name": "零", "days": 0}],
            [{"name": "小数", "days": 1.5}],
            [{"name": "超出", "days": 31}],
        ]
        for milestones in invalid_sets:
            with self.subTest(milestones=milestones):
                with self.assertRaises(ValueError):
                    app.daily_update({"id": task_id, "milestones": milestones})
                current = app.daily_public_payload()["tasks"][0]
                self.assertEqual(current["targetDays"], 30)
                self.assertEqual(current["milestones"][0]["id"], "week")

        with self.assertRaises(ValueError):
            app.daily_update({"id": task_id, "targetDays": 5})
        with self.assertRaises(ValueError):
            app.daily_update({"id": task_id, "targetDays": 0})
        current = app.daily_public_payload()["tasks"][0]
        self.assertEqual(current["targetDays"], 30)
        self.assertEqual(current["milestones"][0]["days"], 7)

    def test_load_safely_cleans_corrupt_milestones(self):
        app.DAILY_FILE.write_text(json.dumps({
            "version": 3,
            "date": app._today_iso(),
            "tasks": [{
                "id": "corrupt",
                "name": "旧任务",
                "targetDays": 30,
                "milestones": [
                    {"id": "valid", "name": " 第一周 ", "days": 7},
                    {"id": "duplicate", "name": "重复", "days": 7},
                    {"name": "越界", "days": 31},
                    {"name": "", "days": 8},
                    {"name": "x" * 60, "days": 10},
                ],
            }],
            "groups": [],
        }), encoding="utf-8")

        task = app.load_daily()["tasks"][0]
        self.assertEqual([item["days"] for item in task["milestones"]], [7, 10])
        self.assertEqual(task["milestones"][0], {"id": "valid", "name": "第一周", "days": 7})
        self.assertEqual(len(task["milestones"][1]["name"]), app.DAILY_MILESTONE_NAME_MAX)
        self.assertTrue(task["milestones"][1]["id"].startswith("dm_"))


if __name__ == "__main__":
    unittest.main()
