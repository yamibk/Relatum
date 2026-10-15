"""Archive responses stay fresh and identical while reusing per-request enumeration."""
import ast
import copy
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

if __name__ == "__main__":
    _runtime_root = tempfile.TemporaryDirectory(prefix="relatum-archive-tests-")
    os.environ["RELATUM_DATA_ROOT"] = _runtime_root.name
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app


def baseline_namespace():
    source = subprocess.check_output(
        ["git", "show", os.environ.get("RELATUM_ARCHIVE_BASELINE_REF", "HEAD") + ":app.py"],
        cwd=Path(__file__).resolve().parents[1], encoding="utf-8",
    )
    names = {"study_activity_records", "_archive_folder_count", "study_activity_payload", "calendar_payload"}
    module = ast.parse(source)
    module.body = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in names]
    namespace = dict(vars(app))
    exec(compile(module, "<archive baseline>", "exec"), namespace)
    return namespace


class ArchiveActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="relatum-archive-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in {
            "STUDY_ARCHIVE_DIR": self.root / "study", "CANVAS_ARCHIVE_DIR": self.root / "canvas",
            "CANVASES": self.root / "canvases", "DIARY_DIR": self.root / "diaries",
        }.items():
            value.mkdir()
            self.stack.enter_context(mock.patch.object(app, name, value))
        for name, value in {
            "recent_paths": set(), "load_focus": {"sessions": [], "days": {}},
            "canvas_activity_snapshot": {"days": {}, "canvases": {}},
            "start_page_activity_snapshot": {"days": {}}, "load_daily": {"tasks": []},
            "diary_index": [], "load_countdown": {}, "load_diary": {},
        }.items():
            self.stack.enter_context(mock.patch.object(app, name, return_value=value))
        self.stack.enter_context(mock.patch.object(app, "usage_store", return_value=SimpleNamespace(totals=lambda year: {})))
        self.old = baseline_namespace()

    def write(self, root, folder, name, value):
        target = root / folder / name
        target.parent.mkdir(exist_ok=True)
        target.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        return target

    def fixture(self):
        canvas = app.CANVASES / "linked.canvas"
        canvas.write_text("{}", encoding="utf-8")
        self.write(app.STUDY_ARCHIVE_DIR, "mixed", "tasks.json", {"tasks": [
            {"title": "任务 B", "completedAt": "2026-10-14T12:00:00", "linkedCanvas": str(canvas)},
            {"title": "任务 A", "completedAt": "2026-10-14T12:00:00"},
        ]})
        self.write(app.STUDY_ARCHIVE_DIR, "mixed", "taskbook.json", {
            "title": "任务簿", "archivedAt": "2026-10-14T12:00:00", "canvasPath": str(canvas),
            "leafCount": 4, "durationMs": 1200, "snapshotRootNodeId": "root",
        })
        self.write(app.STUDY_ARCHIVE_DIR, "mixed", "notes.json", {
            "archivedAt": "2026-10-14T12:00:00", "notes": [{"text": "便签"}, "第二张"],
        })
        corrupt = self.write(app.STUDY_ARCHIVE_DIR, "broken", "tasks.json", {})
        corrupt.write_text("invalid JSON", encoding="utf-8")
        (app.STUDY_ARCHIVE_DIR / "stray-file").write_text("x", encoding="utf-8")
        self.write(app.CANVAS_ARCHIVE_DIR, "nodes", "canvas.json", {
            "archivedAt": "2026-10-13T10:00:00", "nodes": [{"title": "节点"}, "节点二"],
        })
        self.write(app.CANVAS_ARCHIVE_DIR, "legacy", "canvas.json", {"archivedAt": "2026-10-12", "count": 2})

    def assert_responses_equal(self):
        self.assertEqual(app.study_activity_records(), self.old["study_activity_records"]())
        self.assertEqual(app._archive_folder_count(), self.old["_archive_folder_count"]())
        self.assertEqual(app.calendar_payload(2026, 10, "2026-10-14"), self.old["calendar_payload"](2026, 10, "2026-10-14"))
        self.assertEqual(app.study_activity_payload(2026), self.old["study_activity_payload"](2026))

    def test_mixed_markers_corruption_ties_and_legacy_records_match_baseline(self):
        self.fixture()
        self.assert_responses_equal()
        self.assertEqual(app._archive_folder_count(), 6, "corrupt JSON still counts as an archive marker")

    def test_next_request_observes_external_create_replace_delete_and_root_change(self):
        self.fixture()
        counts, records = app.study_activity_records()
        records[0]["title"] = "caller mutation"
        marker = self.write(app.STUDY_ARCHIVE_DIR, "new", "tasks.json", {
            "tasks": [{"title": "新增", "completedAt": "2026-10-15T10:00:00"}],
        })
        self.assert_responses_equal()
        self.assertEqual(app.study_activity_records()[0]["2026-10-15"], 1)
        marker.write_text(json.dumps({"tasks": [{"title": "替换", "completedAt": "2026-10-16"}]}), encoding="utf-8")
        self.assert_responses_equal()
        marker.unlink()
        self.assert_responses_equal()
        other = self.root / "other"
        other.mkdir()
        with mock.patch.object(app, "STUDY_ARCHIVE_DIR", other):
            self.assertFalse(any(r["kind"] in {"study", "taskbook"} for r in app.study_activity_records()[1]))

    def test_directory_listing_failure_falls_back_to_known_files(self):
        self.fixture()
        expected = self.old["study_activity_records"]()
        original = os.scandir

        def denied(path):
            if Path(path) == app.STUDY_ARCHIVE_DIR / "mixed":
                raise PermissionError("fixture listing denied")
            return original(path)

        with mock.patch.object(app.os, "scandir", side_effect=denied):
            self.assertEqual(app.study_activity_records(), expected)

    def test_file_disappearing_after_inventory_is_skipped(self):
        self.fixture()
        inventory = app._activity_archive_inventory()
        (app.STUDY_ARCHIVE_DIR / "mixed" / "tasks.json").unlink()
        self.assertEqual(app.study_activity_records(archive_files=inventory), self.old["study_activity_records"]())

    def test_case_rules_and_directory_marker_match_platform(self):
        self.write(app.STUDY_ARCHIVE_DIR, "case", "Tasks.JSON", {"tasks": [{"completedAt": "2026-10-14"}]})
        folder = app.STUDY_ARCHIVE_DIR / "not-a-file"
        folder.mkdir()
        (folder / "notes.json").mkdir()
        self.assert_responses_equal()

    def test_activity_uses_one_inventory_for_records_and_folder_count(self):
        self.fixture()
        original = os.scandir
        paths = []

        def record(path):
            paths.append(Path(path))
            return original(path)

        with mock.patch.object(app.os, "scandir", side_effect=record):
            app.study_activity_payload(2026)
        self.assertEqual(len(paths), len(set(paths)), "the same request must not re-enumerate archive folders")


def benchmark():
    case = ArchiveActivityTests()
    case.setUp()
    try:
        for index in range(300):
            case.write(app.STUDY_ARCHIVE_DIR, str(index), "tasks.json", {"tasks": [
                {"title": "归档 " + str(index), "completedAt": "2026-10-14T12:00:00"} for _ in range(10)
            ]})
        result = {}
        for label, name, current in [
            ("records", "study_activity_records", app.study_activity_records),
            ("calendar", "calendar_payload", lambda: app.calendar_payload(2026, 10, "2026-10-14")),
            ("activity", "study_activity_payload", lambda: app.study_activity_payload(2026)),
        ]:
            old = case.old[name]
            before = old if label == "records" else (lambda: old(2026, 10, "2026-10-14")) if label == "calendar" else lambda: old(2026)
            self_check = copy.deepcopy(before())
            assert current() == self_check
            times = {"baseline": [], "current": []}
            for run in range(5):
                for version in (["baseline", "current"] if run % 2 == 0 else ["current", "baseline"]):
                    start = time.perf_counter()
                    (before if version == "baseline" else current)()
                    times[version].append((time.perf_counter() - start) * 1000)
            result[label] = {**times, "medianMs": {k: statistics.median(v) for k, v in times.items()}}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        case.doCleanups()


if __name__ == "__main__":
    if "--benchmark" in sys.argv:
        benchmark()
    else:
        unittest.main()
