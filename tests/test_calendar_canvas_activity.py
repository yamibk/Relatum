import unittest
from unittest import mock

import app


class CalendarCanvasActivityTests(unittest.TestCase):
    """日历页「画布活动」栏：day.canvasActivity 聚合结构、排序与过滤。"""

    def setUp(self):
        # 隔离真实用户数据：日历其它依赖全部 mock。
        self.patchers = [
            mock.patch.object(app, "load_focus", return_value={}),
            mock.patch.object(app, "study_activity_records", return_value=([], [])),
            mock.patch.object(app, "diary_index", return_value=[]),
            mock.patch.object(app, "load_diary", return_value=None),
            mock.patch.object(app, "load_countdown", return_value=app._default_countdown()),
            mock.patch.object(app, "load_daily", return_value={"tasks": []}),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.snapshot = mock.patch.object(app, "canvas_activity_snapshot")
        self.snapshot_mock = self.snapshot.start()

    def tearDown(self):
        self.snapshot.stop()
        for patcher in self.patchers:
            patcher.stop()

    def payload(self, snapshot):
        self.snapshot_mock.return_value = snapshot
        return app.calendar_payload(2026, 8, "2026-08-18")

    def test_items_carry_title_seconds_and_marks(self):
        data = self.payload({
            "canvases": {"a": {"title": "学习笔记", "path": "C:/x/学习笔记.canvas"}},
            "days": {"2026-08-18": {"a": {"seconds": 600, "created": True, "modified": False}}},
        })
        activity = data["day"]["canvasActivity"]
        self.assertEqual(activity["count"], 1)
        self.assertEqual(activity["durationSec"], 600)
        self.assertEqual(activity["items"][0]["title"], "学习笔记")
        self.assertEqual(activity["items"][0]["seconds"], 600)
        self.assertTrue(activity["items"][0]["created"])

    def test_sorted_by_seconds_desc(self):
        data = self.payload({
            "canvases": {
                "a": {"title": "短"},
                "b": {"title": "长"},
                "c": {"title": "无时长新建"},
            },
            "days": {"2026-08-18": {
                "a": {"seconds": 60, "created": False, "modified": True},
                "b": {"seconds": 1800, "created": False, "modified": True},
                "c": {"seconds": 0, "created": True, "modified": False},
            }},
        })
        titles = [item["title"] for item in data["day"]["canvasActivity"]["items"]]
        self.assertEqual(titles, ["长", "短", "无时长新建"])

    def test_created_and_modified_both_marked(self):
        data = self.payload({
            "canvases": {"a": {"title": "新建即改"}},
            "days": {"2026-08-18": {"a": {"seconds": 0, "created": True, "modified": True}}},
        })
        item = data["day"]["canvasActivity"]["items"][0]
        self.assertTrue(item["created"])
        self.assertTrue(item["modified"])

    def test_empty_day_yields_empty_activity(self):
        data = self.payload({"canvases": {}, "days": {}})
        activity = data["day"]["canvasActivity"]
        self.assertEqual(activity, {"count": 0, "durationSec": 0, "items": []})

    def test_noop_entry_is_skipped(self):
        data = self.payload({
            "canvases": {"a": {"title": "无痕"}},
            "days": {"2026-08-18": {"a": {"seconds": 0, "created": False, "modified": False}}},
        })
        self.assertEqual(data["day"]["canvasActivity"]["items"], [])

    def test_month_bucket_marks_canvas_days(self):
        data = self.payload({
            "canvases": {"a": {"title": "复盘"}, "b": {"title": "空"}},
            "days": {
                "2026-08-18": {"a": {"seconds": 600, "created": False, "modified": True}},
                "2026-08-17": {"b": {"seconds": 0, "created": False, "modified": False}},
            },
        })
        days = data["days"]
        self.assertEqual(days["2026-08-18"]["canvas"], 1)
        # 无实际活动（无时长无标记）的日期不点亮
        self.assertNotIn("2026-08-17", days)


if __name__ == "__main__":
    unittest.main()
