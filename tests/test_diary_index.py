import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import app


class DiaryIndexCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="relatum-diary-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "diary"
        self.root.mkdir()
        for patcher in (
            mock.patch.object(app, "DIARY_DIR", self.root),
            mock.patch.object(app, "_DIARY_INDEX_CACHE", {}),
            mock.patch.object(app, "_DIARY_INDEX_CACHE_ROOT", None),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def write(self, day, body="日记正文", title="标题", tags="[\"学习\"]"):
        path = self.root / (day + ".md")
        path.write_text(
            '\ufeff---\ntitle: "' + title + '"\ntags: ' + tags
            + '\nupdatedAt: "2026-10-07T12:00:00"\n---\n\n' + body,
            encoding="utf-8", newline="",
        )
        return path

    def test_summary_matches_existing_markdown_and_order(self):
        self.write("2026-10-06", "# 标题\r\n> **内容** [链接](地址)\r\n\n结尾")
        self.write("2026-10-07", "最新正文", title="最新", tags='[" A ", "", 123]')
        (self.root / "not-a-day.md").write_text("ignored", encoding="utf-8")
        (self.root / "2026-10-05.md").mkdir()
        entries = app.diary_index()
        self.assertEqual([entry["date"] for entry in entries], ["2026-10-07", "2026-10-06"])
        self.assertEqual(entries[0], {
            "date": "2026-10-07", "title": "最新", "tags": ["A", "123"],
            "updatedAt": "2026-10-07T12:00:00", "excerpt": "最新正文",
        })
        self.assertEqual(entries[1]["excerpt"], "标题 内容 链接 地址 结尾")

    def test_unchanged_index_does_not_read_bodies(self):
        for day in ("2026-10-05", "2026-10-06", "2026-10-07"):
            self.write(day)
        with mock.patch.object(app, "load_diary", wraps=app.load_diary) as load:
            expected = app.diary_index()
            self.assertEqual(load.call_count, 3)
            load.reset_mock()
            self.assertEqual(app.diary_index(), expected)
            self.assertEqual(app.diary_index(), expected)
            self.assertEqual(load.call_count, 0)

    def test_calendar_payload_reads_selected_body_and_reuses_other_summaries(self):
        self.write("2026-10-06", body="昨天正文")
        self.write("2026-10-07", body="今天完整正文")
        with mock.patch.object(app, "load_focus", return_value={}), \
                mock.patch.object(app, "study_activity_records", return_value=({}, [])), \
                mock.patch.object(app, "canvas_activity_snapshot", return_value={}), \
                mock.patch.object(app, "load_daily", return_value={"tasks": []}), \
                mock.patch.object(app, "load_countdown", return_value={}), \
                mock.patch.object(app, "load_diary", wraps=app.load_diary) as load:
            first = app.calendar_payload(2026, 10, "2026-10-07")
            self.assertEqual(first["day"]["diary"]["body"], "\n今天完整正文")
            self.assertEqual(load.call_count, 3)
            load.reset_mock()
            again = app.calendar_payload(2026, 10, "2026-10-06")
            load.assert_called_once_with("2026-10-06")
            self.assertEqual(again["diaries"], first["diaries"])
            self.assertEqual(again["day"]["diary"]["body"], "\n昨天正文")
            app.save_diary({"date": "2026-10-06", "title": "新标题", "body": "保存的新正文"})
            updated = app.calendar_payload(2026, 10, "2026-10-06")
            self.assertEqual(updated["day"]["diary"]["title"], "新标题")
            self.assertEqual(updated["diaries"][1]["excerpt"], "保存的新正文")

    def test_external_changes_and_deletion_are_detected(self):
        path = self.write("2026-10-06")
        self.write("2026-10-07")
        app.diary_index()
        self.write("2026-10-07", body="已由外部编辑器修改", title="新标题")
        path.unlink()
        with mock.patch.object(app, "load_diary", wraps=app.load_diary) as load:
            entries = app.diary_index()
        self.assertEqual(load.call_count, 1)
        self.assertEqual(entries[0]["title"], "新标题")
        self.assertEqual(len(entries), 1)
        self.assertEqual(len(app._DIARY_INDEX_CACHE), 1)

    def test_atomic_external_replacement_with_preserved_mtime(self):
        path = self.write("2026-10-07", body="旧文字")
        app.diary_index()
        before = path.stat()
        replacement = self.root / "replacement"
        replacement.write_bytes(path.read_bytes().replace("旧文字".encode(), "新文字".encode()))
        os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(replacement, path)
        self.assertEqual(path.stat().st_size, before.st_size)
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(app.diary_index()[0]["excerpt"], "新文字")

    def test_save_invalidates_even_if_file_signature_is_unchanged(self):
        path = self.write("2026-10-07")
        signature = app._diary_file_signature(path)
        with mock.patch.object(app, "_diary_file_signature", return_value=signature):
            app.diary_index()
            app.save_diary({"date": "2026-10-07", "title": "已保存", "body": "新正文"})
            self.assertEqual(app._DIARY_INDEX_CACHE, {})
            self.assertEqual(app.diary_index()[0]["title"], "已保存")

    def test_failed_save_keeps_previous_summary(self):
        self.write("2026-10-07")
        before = app.diary_index()
        with mock.patch.object(app, "_atomic_write_text", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                app.save_diary({"date": "2026-10-07", "title": "未保存"})
        self.assertEqual(app.diary_index(), before)

    def test_successful_delete_and_already_missing_file_clear_cache(self):
        first = self.write("2026-10-06")
        self.write("2026-10-07")
        app.diary_index()
        first.unlink()
        app.delete_diary("2026-10-06")
        self.assertNotIn(app._diary_cache_key(first), app._DIARY_INDEX_CACHE)
        app.delete_diary("2026-10-07")
        self.assertEqual(app._DIARY_INDEX_CACHE, {})
        self.assertEqual(app.diary_index(), [])

    def test_read_failure_discards_old_summary_and_can_recover(self):
        self.write("2026-10-07")
        app.diary_index()
        self.write("2026-10-07", body="外部更新后的正文")
        with mock.patch.object(Path, "read_text", side_effect=OSError("unreadable")):
            self.assertEqual(app.diary_index(), [])
        self.assertEqual(app._DIARY_INDEX_CACHE, {})
        self.assertEqual(app.diary_index()[0]["excerpt"], "外部更新后的正文")

    def test_stat_failure_does_not_serve_cached_summary(self):
        self.write("2026-10-07")
        app.diary_index()
        with mock.patch.object(app, "_diary_file_signature", side_effect=FileNotFoundError):
            self.assertEqual(app.diary_index(), [])
        self.assertEqual(app._DIARY_INDEX_CACHE, {})

    def test_file_changed_during_read_is_not_cached(self):
        self.write("2026-10-07", body="原正文")
        original_load = app.load_diary

        def change_after_read(day):
            item = original_load(day)
            self.write(day, body="读取期间修改的正文")
            return item

        with mock.patch.object(app, "load_diary", side_effect=change_after_read):
            self.assertEqual(app.diary_index()[0]["excerpt"], "原正文")
        self.assertEqual(app._DIARY_INDEX_CACHE, {})
        self.assertEqual(app.diary_index()[0]["excerpt"], "读取期间修改的正文")

    def test_cache_is_bounded_and_does_not_retain_body(self):
        for day in ("2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"):
            self.write(day, body="X" * 10000 + "BODY_ONLY_SENTINEL")
        with mock.patch.object(app, "DIARY_INDEX_CACHE_LIMIT", 2):
            with mock.patch.object(app, "load_diary", wraps=app.load_diary) as load:
                self.assertEqual(len(app.diary_index()), 4)
                self.assertEqual(load.call_count, 4)
                self.assertEqual(len(app._DIARY_INDEX_CACHE), 2)
                for _ in range(2):
                    load.reset_mock()
                    self.assertEqual(len(app.diary_index()), 4)
                    self.assertEqual(load.call_count, 2, "oversized scans must retain their warm summaries")
                    self.assertEqual(len(app._DIARY_INDEX_CACHE), 2)
        for signature, summary in app._DIARY_INDEX_CACHE.values():
            self.assertIsInstance(signature, tuple)
            self.assertNotIn("body", summary)
            self.assertNotIn("BODY_ONLY_SENTINEL", repr(summary))

    def test_returned_tags_and_summaries_are_independent(self):
        self.write("2026-10-07")
        entries = app.diary_index()
        entries[0]["title"] = "被调用方改动"
        entries[0]["tags"].append("不该保存")
        entries[0]["excerpt"] = "错误摘要"
        expected = app.diary_index()[0]
        self.assertEqual(expected["title"], "标题")
        self.assertEqual(expected["tags"], ["学习"])
        self.assertEqual(expected["excerpt"], "日记正文")

    def test_directory_change_and_removal_discard_old_cache(self):
        self.write("2026-10-07")
        app.diary_index()
        other = Path(self.temp.name) / "other"
        other.mkdir()
        (other / "2026-10-06.md").write_text("另一个目录", encoding="utf-8")
        with mock.patch.object(app, "DIARY_DIR", other):
            self.assertEqual(app.diary_index()[0]["excerpt"], "另一个目录")
            (other / "2026-10-06.md").unlink()
            other.rmdir()
            self.assertEqual(app.diary_index(), [])
            self.assertEqual(app._DIARY_INDEX_CACHE, {})
        self.assertEqual(app.diary_index()[0]["excerpt"], "日记正文")

    def test_parallel_requests_reuse_one_body_read(self):
        self.write("2026-10-07")
        with mock.patch.object(app, "load_diary", wraps=app.load_diary) as load:
            with ThreadPoolExecutor(max_workers=8) as pool:
                outputs = list(pool.map(lambda unused: app.diary_index(), range(16)))
        self.assertEqual(load.call_count, 1)
        self.assertTrue(all(output == outputs[0] for output in outputs))
        outputs[0][0]["tags"].append("仅第一份响应")
        self.assertEqual(outputs[1][0]["tags"], ["学习"])

    def test_save_during_index_read_cannot_leave_stale_cache(self):
        self.write("2026-10-07", body="旧正文")
        read = threading.Event()
        replaced = threading.Event()
        resume = threading.Event()
        original_load = app.load_diary
        original_write = app._atomic_write_text

        def pause_after_read(day):
            item = original_load(day)
            read.set()
            self.assertTrue(resume.wait(5), "test did not release index read")
            return item

        def notify_replace(path, content):
            original_write(path, content)
            replaced.set()

        with mock.patch.object(app, "load_diary", side_effect=pause_after_read), \
                mock.patch.object(app, "_atomic_write_text", side_effect=notify_replace):
            with ThreadPoolExecutor(max_workers=2) as pool:
                reader = pool.submit(app.diary_index)
                try:
                    self.assertTrue(read.wait(5))
                    writer = pool.submit(app.save_diary, {"date": "2026-10-07", "body": "新正文"})
                    self.assertTrue(replaced.wait(5))
                finally:
                    resume.set()
                self.assertEqual(reader.result(timeout=5)[0]["excerpt"], "旧正文")
                self.assertEqual(writer.result(timeout=5)["body"], "新正文")
        self.assertEqual(app._DIARY_INDEX_CACHE, {})
        self.assertEqual(app.diary_index()[0]["excerpt"], "新正文")


if __name__ == "__main__":
    unittest.main()
