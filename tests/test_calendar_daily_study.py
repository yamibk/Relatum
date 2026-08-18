import unittest
from unittest import mock

import app


class CalendarDailySummaryTests(unittest.TestCase):
    """日历页「每日打卡」栏：day.daily 聚合结构与排序。"""

    def setUp(self):
        self.patchers = [
            mock.patch.object(app, "load_focus", return_value={}),
            mock.patch.object(app, "study_activity_records", return_value=([], [])),
            mock.patch.object(app, "diary_index", return_value=[]),
            mock.patch.object(app, "load_diary", return_value=None),
            mock.patch.object(app, "load_countdown", return_value=app._default_countdown()),
            mock.patch.object(app, "canvas_activity_snapshot", return_value={"canvases": {}, "days": {}}),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.load_daily = mock.patch.object(app, "load_daily")
        self.load_daily_mock = self.load_daily.start()
        self.load_study = mock.patch.object(app, "load_study")
        self.load_study_mock = self.load_study.start()

    def tearDown(self):
        self.load_study.stop()
        self.load_daily.stop()
        for patcher in self.patchers:
            patcher.stop()

    def payload(self, daily=None, study=None):
        self.load_daily_mock.return_value = daily if daily is not None else {"tasks": []}
        self.load_study_mock.return_value = study if study is not None else {"tasks": []}
        return app.calendar_payload(2026, 8, "2026-08-18")

    def test_unchecked_tasks_are_filtered_out(self):
        data = self.payload(daily={"tasks": [
            {"id": "a", "name": "背单词", "doneDates": ["2026-08-18", "2026-08-17"], "totalDays": 12},
            {"id": "b", "name": "跑步", "doneDates": ["2026-08-17"], "totalDays": 5},
        ]})
        daily = data["day"]["daily"]
        # 只记录已打卡：未打卡的“跑步”不出现
        self.assertEqual(daily["checkedCount"], 1)
        self.assertEqual(daily["totalCount"], 2)
        self.assertEqual(len(daily["items"]), 1)
        item = daily["items"][0]
        self.assertEqual(item["name"], "背单词")
        self.assertTrue(item["checked"])
        self.assertEqual(item["totalDays"], 12)

    def test_checked_items_sorted_by_name(self):
        data = self.payload(daily={"tasks": [
            {"id": "a", "name": "甲任务", "doneDates": ["2026-08-18"], "totalDays": 1},
            {"id": "b", "name": "乙任务", "doneDates": ["2026-08-18"], "totalDays": 2},
            {"id": "c", "name": "未打卡", "doneDates": [], "totalDays": 0},
        ]})
        daily = data["day"]["daily"]
        names = [item["name"] for item in daily["items"]]
        self.assertEqual(names, ["乙任务", "甲任务"])

    def test_empty_daily(self):
        data = self.payload(daily={"tasks": []})
        self.assertEqual(data["day"]["daily"], {"checkedCount": 0, "totalCount": 0, "items": []})

    def test_month_bucket_marks_daily_checked_days(self):
        data = self.payload(daily={"tasks": [
            {"id": "a", "name": "背单词", "doneDates": ["2026-08-18", "2026-08-16"], "totalDays": 3},
        ]})
        days = data["days"]
        self.assertEqual(days["2026-08-18"]["daily"], 1)
        self.assertEqual(days["2026-08-16"]["daily"], 1)
        self.assertNotIn("2026-08-17", days)


class CalendarStudyCompletedTests(unittest.TestCase):
    """日历页「学习任务」栏：day.studyCompleted 只读学习归档（kind=study）落在选中日的条目。"""

    def setUp(self):
        self.patchers = [
            mock.patch.object(app, "load_focus", return_value={}),
            mock.patch.object(app, "diary_index", return_value=[]),
            mock.patch.object(app, "load_diary", return_value=None),
            mock.patch.object(app, "load_countdown", return_value=app._default_countdown()),
            mock.patch.object(app, "canvas_activity_snapshot", return_value={"canvases": {}, "days": {}}),
            mock.patch.object(app, "load_daily", return_value={"tasks": []}),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.activity_records = mock.patch.object(app, "study_activity_records")
        self.activity_mock = self.activity_records.start()

    def tearDown(self):
        self.activity_records.stop()
        for patcher in self.patchers:
            patcher.stop()

    def payload(self, records):
        self.activity_mock.return_value = ({}, records)
        return app.calendar_payload(2026, 8, "2026-08-18")

    def test_filters_study_archives_of_selected_day(self):
        data = self.payload([
            {"kind": "study", "title": "线性代数", "completedAt": "2026-08-18T09:30:00", "day": "2026-08-18"},
            {"kind": "study", "title": "英语阅读", "completedAt": "2026-08-17T21:00:00", "day": "2026-08-17"},
            {"kind": "canvas", "title": "画布归档", "completedAt": "2026-08-18T10:00:00", "day": "2026-08-18"},
        ])
        completed = data["day"]["studyCompleted"]
        self.assertEqual(completed["count"], 1)
        self.assertEqual(completed["items"][0]["title"], "线性代数")
        self.assertEqual(completed["items"][0]["time"], "09:30")

    def test_sorted_by_time_ascending(self):
        data = self.payload([
            {"kind": "study", "title": "晚", "completedAt": "2026-08-18T21:00:00", "day": "2026-08-18"},
            {"kind": "study", "title": "早", "completedAt": "2026-08-18T08:00:00", "day": "2026-08-18"},
        ])
        titles = [item["title"] for item in data["day"]["studyCompleted"]["items"]]
        self.assertEqual(titles, ["早", "晚"])

    def test_no_study_archives_yields_empty(self):
        data = self.payload([
            {"kind": "canvas", "title": "画布归档", "completedAt": "2026-08-18T10:00:00", "day": "2026-08-18"},
        ])
        self.assertEqual(data["day"]["studyCompleted"], {"count": 0, "items": []})

    def test_month_bucket_marks_study_archive_days(self):
        data = self.payload([
            {"kind": "study", "title": "线性代数", "completedAt": "2026-08-18T09:30:00", "day": "2026-08-18"},
            {"kind": "study", "title": "英语阅读", "completedAt": "2026-08-16T21:00:00", "day": "2026-08-16"},
            {"kind": "canvas", "title": "画布归档", "completedAt": "2026-08-17T10:00:00", "day": "2026-08-17"},
        ])
        days = data["days"]
        self.assertEqual(days["2026-08-18"]["study"], 1)
        self.assertEqual(days["2026-08-16"]["study"], 1)
        # 非学习归档不点亮 study 标记（archives 桶仍正常计数）
        self.assertEqual(days["2026-08-17"]["study"], 0)
        self.assertEqual(days["2026-08-17"]["archives"], 1)


if __name__ == "__main__":
    unittest.main()
