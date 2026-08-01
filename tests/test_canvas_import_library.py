import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app as target


class CanvasImportLibraryTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.data_dir = self.root / "data"
        self.canvases_dir = self.root / "canvases"
        self.trash_dir = self.canvases_dir / "回收站"
        self.data_dir.mkdir()
        self.canvases_dir.mkdir()
        self.trash_dir.mkdir()
        self.recent_file = self.data_dir / "recent.json"
        self.backup_file = self.data_dir / "recent.backup.json"
        self.patchers = [
            mock.patch.object(target, "ROOT", self.root),
            mock.patch.object(target, "DATA", self.data_dir),
            mock.patch.object(target, "CANVASES", self.canvases_dir),
            mock.patch.object(target, "TRASH", self.trash_dir),
            mock.patch.object(target, "RECENT_FILE", self.recent_file),
            mock.patch.object(target, "RECENT_BACKUP_FILE", self.backup_file),
            mock.patch.object(target, "ALLOWED_EXTRA_DIRS", []),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp_dir.cleanup()

    def write_canvas(self, path, payload=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        data = payload if payload is not None else {"version": 2, "nodes": [], "edges": []}
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def write_recent(self, files, groups=None):
        self.recent_file.write_text(
            json.dumps({
                "version": 3,
                "groups": groups or [],
                "files": files,
            }, ensure_ascii=False),
            encoding="utf-8",
        )

    @staticmethod
    def entry(file_id, path, **extra):
        item = {
            "id": file_id,
            "path": str(path),
            "title": extra.pop("title", path.stem),
            "lastOpenedAt": extra.pop("lastOpenedAt", "2026-07-27T10:00:00"),
            "groupId": extra.pop("groupId", ""),
            "groupRank": extra.pop("groupRank", 0),
        }
        item.update(extra)
        return item

    def test_library_filters_to_live_top_level_managed_canvases(self):
        current = self.write_canvas(self.canvases_dir / "当前.canvas")
        managed = self.write_canvas(self.canvases_dir / "内部.canvas")
        external = self.write_canvas(self.root / "外部.canvas")
        trashed = self.write_canvas(self.trash_dir / "已删除.canvas")
        nested = self.write_canvas(self.canvases_dir / "子目录" / "嵌套.canvas")
        missing = self.canvases_dir / "不存在.canvas"
        self.write_recent([
            self.entry("cf_current", current, groupId="g_work"),
            self.entry(
                "cf_managed",
                managed,
                groupId="g_work",
                favorite=True,
                favoriteRank=3,
            ),
            self.entry("cf_external", external),
            self.entry("cf_trash", trashed),
            self.entry("cf_nested", nested),
            self.entry("cf_missing", missing),
        ], groups=[{"id": "g_work", "name": "研究"}])

        payload = target.canvas_import_library_payload(str(current))

        self.assertEqual([item["id"] for item in payload["files"]], ["cf_managed"])
        self.assertEqual(payload["currentId"], "cf_current")
        self.assertEqual(payload["currentGroupId"], "g_work")
        self.assertEqual(payload["groups"], [{"id": "g_work", "name": "研究"}])
        self.assertNotIn("path", payload["files"][0])
        self.assertTrue(payload["files"][0]["favorite"])
        self.assertEqual(payload["files"][0]["favoriteRank"], 3)

    def test_ungrouped_current_defaults_to_inbox_and_source_read_is_side_effect_free(self):
        source_payload = {
            "version": 2,
            "nodes": [{"id": "node-a", "kind": "card", "text": "A"}],
            "edges": [],
        }
        source = self.write_canvas(self.canvases_dir / "来源.canvas", source_payload)
        current = self.write_canvas(self.canvases_dir / "当前.canvas")
        self.write_recent([
            self.entry("cf_source", source, lastOpenedAt="2026-07-20T08:00:00"),
            self.entry("cf_current", current, lastOpenedAt="2026-07-27T08:00:00"),
        ])
        before = self.recent_file.read_bytes()

        library = target.canvas_import_library_payload(str(current))
        result = target.canvas_import_source_payload("cf_source")

        self.assertEqual(library["currentGroupId"], "__inbox__")
        self.assertEqual(result["data"], source_payload)
        self.assertNotIn("path", result)
        self.assertEqual(
            result["revision"],
            hashlib.sha256(source.read_bytes()).hexdigest(),
        )
        self.assertEqual(self.recent_file.read_bytes(), before)

    def test_dual_open_returns_managed_canvas_path_without_recent_side_effects(self):
        source_payload = {
            "version": 2,
            "nodes": [{"id": "node-a", "kind": "card", "text": "A"}],
            "edges": [],
        }
        source = self.write_canvas(self.canvases_dir / "dual-source.canvas", source_payload)
        current = self.write_canvas(self.canvases_dir / "current.canvas")
        self.write_recent([
            self.entry("cf_source", source, title="Dual Source", lastOpenedAt="2026-07-20T08:00:00"),
            self.entry("cf_current", current, lastOpenedAt="2026-07-27T08:00:00"),
        ])
        before = self.recent_file.read_bytes()

        result = target.canvas_dual_open_payload("cf_source", str(current))

        self.assertEqual(result["id"], "cf_source")
        self.assertEqual(result["title"], "Dual Source")
        self.assertEqual(Path(result["path"]).resolve(), source.resolve())
        self.assertEqual(result["revision"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual(result["data"], source_payload)
        self.assertEqual(self.recent_file.read_bytes(), before)

    def test_dual_open_rejects_current_canvas(self):
        current = self.write_canvas(self.canvases_dir / "current.canvas")
        self.write_recent([self.entry("cf_current", current)])

        with self.assertRaises(target.CanvasImportLibraryError) as rejected:
            target.canvas_dual_open_payload("cf_current", str(current))

        self.assertEqual(rejected.exception.code, "SAME_CANVAS")

    def test_dual_open_rejects_unmanaged_non_top_level_missing_and_damaged_sources(self):
        managed = self.write_canvas(self.canvases_dir / "managed.canvas")
        external = self.write_canvas(self.root / "external.canvas")
        nested = self.write_canvas(self.canvases_dir / "nested" / "nested.canvas")
        missing = self.canvases_dir / "missing.canvas"
        damaged = self.canvases_dir / "damaged.canvas"
        damaged.write_text("{", encoding="utf-8")
        self.write_recent([
            self.entry("cf_managed", managed),
            self.entry("cf_external", external),
            self.entry("cf_nested", nested),
            self.entry("cf_missing", missing),
            self.entry("cf_damaged", damaged),
        ])

        with self.assertRaises(target.CanvasImportLibraryError) as unknown:
            target.canvas_dual_open_payload("cf_unknown", "")
        self.assertEqual(unknown.exception.code, "SOURCE_NOT_MANAGED")

        for file_id in ["cf_external", "cf_nested", "cf_missing"]:
            with self.assertRaises(target.CanvasImportLibraryError) as rejected:
                target.canvas_dual_open_payload(file_id, "")
            self.assertEqual(rejected.exception.code, "SOURCE_NOT_MANAGED")

        with self.assertRaises(target.CanvasImportLibraryError) as invalid:
            target.canvas_dual_open_payload("cf_damaged", "")
        self.assertEqual(invalid.exception.code, "INVALID_JSON")

    def test_registered_external_target_can_default_to_its_group(self):
        managed = self.write_canvas(self.canvases_dir / "内部来源.canvas")
        external_current = self.write_canvas(self.root / "外部当前.canvas")
        self.write_recent([
            self.entry("cf_source", managed, groupId="g_work"),
            self.entry("cf_external", external_current, groupId="g_work"),
        ], groups=[{"id": "g_work", "name": "工作"}])

        library = target.canvas_import_library_payload(str(external_current))

        self.assertEqual(library["currentId"], "cf_external")
        self.assertEqual(library["currentGroupId"], "g_work")
        self.assertEqual([item["id"] for item in library["files"]], ["cf_source"])

    def test_source_rejects_unknown_and_invalid_node_ids(self):
        duplicate = self.write_canvas(
            self.canvases_dir / "重复.canvas",
            {"nodes": [{"id": "same"}, {"id": "same"}], "edges": []},
        )
        self.write_recent([self.entry("cf_duplicate", duplicate)])

        with self.assertRaises(target.CanvasImportLibraryError) as unknown:
            target.canvas_import_source_payload("cf_unknown")
        self.assertEqual(unknown.exception.code, "SOURCE_NOT_MANAGED")

        with self.assertRaises(target.CanvasImportLibraryError) as invalid:
            target.canvas_import_source_payload("cf_duplicate")
        self.assertEqual(invalid.exception.code, "DUPLICATE_NODE_ID")

    def test_source_rejects_files_over_the_shared_json_limit(self):
        oversized = self.canvases_dir / "过大.canvas"
        with oversized.open("wb") as handle:
            handle.seek(target.MAX_JSON_BODY_BYTES)
            handle.write(b"\0")
        self.write_recent([self.entry("cf_large", oversized)])

        with self.assertRaises(target.CanvasImportLibraryError) as rejected:
            target.canvas_import_source_payload("cf_large")

        self.assertEqual(rejected.exception.code, "SOURCE_TOO_LARGE")
        self.assertEqual(rejected.exception.status, 413)

    def test_assets_copy_once_with_collision_and_without_annotations(self):
        source = self.write_canvas(
            self.canvases_dir / "来源.canvas",
            {
                "nodes": [
                    {"id": "image-a", "kind": "image", "assetPath": "images/photo.png"},
                    {"id": "image-b", "kind": "image", "assetPath": "images/photo.png"},
                    {"id": "pdf", "kind": "attachment", "assetPath": "attachments/paper.pdf"},
                    {"id": "md", "kind": "attachment", "assetPath": "attachments/note.md"},
                ],
                "edges": [],
            },
        )
        target_canvas = self.write_canvas(self.canvases_dir / "目标.canvas")
        source_assets = target.canvas_assets_root(source)
        (source_assets / "images").mkdir(parents=True)
        (source_assets / "attachments").mkdir(parents=True)
        (source_assets / "images" / "photo.png").write_bytes(b"png")
        (source_assets / "images" / "photo.png.annot.json").write_text("{}", encoding="utf-8")
        (source_assets / "attachments" / "paper.pdf").write_bytes(b"pdf")
        (source_assets / "attachments" / "paper.pdf.annot.json").write_text("{}", encoding="utf-8")
        (source_assets / "attachments" / "note.md").write_text("# note", encoding="utf-8")
        (source_assets / "node-annotations.json").write_text("{}", encoding="utf-8")
        target_assets = target.canvas_assets_root(target_canvas)
        (target_assets / "images").mkdir(parents=True)
        (target_assets / "images" / "photo.png").write_bytes(b"existing")
        self.write_recent([
            self.entry("cf_source", source),
            self.entry("cf_target", target_canvas),
        ])
        source_result = target.canvas_import_source_payload("cf_source")

        result = target.copy_canvas_import_assets(
            "cf_source",
            source_result["revision"],
            str(target_canvas),
            ["images/photo.png", "attachments/paper.pdf", "attachments/note.md"],
        )

        self.assertEqual(result["assetCount"], 3)
        self.assertNotEqual(result["mapping"]["images/photo.png"], "images/photo.png")
        for copied in result["mapping"].values():
            self.assertTrue((target_assets / copied).is_file())
        self.assertFalse((target_assets / "node-annotations.json").exists())
        self.assertFalse(any(target_assets.rglob("*.annot.json")))

    def test_assets_can_copy_to_an_authorized_external_target(self):
        source = self.write_canvas(
            self.canvases_dir / "来源.canvas",
            {"nodes": [{"id": "image", "assetPath": "images/source.png"}], "edges": []},
        )
        external_target = self.write_canvas(self.root / "外部目标.canvas")
        source_asset = target.canvas_assets_root(source) / "images" / "source.png"
        source_asset.parent.mkdir(parents=True)
        source_asset.write_bytes(b"image")
        self.write_recent([
            self.entry("cf_source", source),
            self.entry("cf_external", external_target),
        ])
        revision = target.canvas_import_source_payload("cf_source")["revision"]

        result = target.copy_canvas_import_assets(
            "cf_source",
            revision,
            str(external_target),
            ["images/source.png"],
        )

        copied = target.canvas_assets_root(external_target) / result["mapping"]["images/source.png"]
        self.assertEqual(copied.read_bytes(), b"image")

    def test_revision_missing_asset_and_unsafe_path_fail_before_visible_copy(self):
        source = self.write_canvas(
            self.canvases_dir / "来源.canvas",
            {
                "nodes": [{"id": "image", "assetPath": "images/missing.png"}],
                "edges": [],
            },
        )
        target_canvas = self.write_canvas(self.canvases_dir / "目标.canvas")
        self.write_recent([
            self.entry("cf_source", source),
            self.entry("cf_target", target_canvas),
        ])
        revision = target.canvas_import_source_payload("cf_source")["revision"]

        with self.assertRaises(target.CanvasImportLibraryError) as changed:
            target.copy_canvas_import_assets(
                "cf_source", "0" * 64, str(target_canvas), ["images/missing.png"],
            )
        self.assertEqual(changed.exception.code, "SOURCE_CHANGED")

        with self.assertRaises(target.CanvasImportLibraryError) as missing:
            target.copy_canvas_import_assets(
                "cf_source", revision, str(target_canvas), ["images/missing.png"],
            )
        self.assertEqual(missing.exception.code, "ASSET_MISSING")
        self.assertFalse(target.canvas_assets_root(target_canvas).exists())

        unsafe = self.write_canvas(
            self.canvases_dir / "越界.canvas",
            {"nodes": [{"id": "bad", "assetPath": "../outside.png"}], "edges": []},
        )
        self.write_recent([
            self.entry("cf_unsafe", unsafe),
            self.entry("cf_target", target_canvas),
        ])
        unsafe_revision = target.canvas_import_source_payload("cf_unsafe")["revision"]
        with self.assertRaises(target.CanvasImportLibraryError) as invalid:
            target.copy_canvas_import_assets(
                "cf_unsafe", unsafe_revision, str(target_canvas), ["../outside.png"],
            )
        self.assertEqual(invalid.exception.code, "INVALID_ASSET_PATH")

    def test_partial_copy_failure_rolls_back_created_files(self):
        source = self.write_canvas(
            self.canvases_dir / "来源.canvas",
            {
                "nodes": [
                    {"id": "a", "assetPath": "images/a.png"},
                    {"id": "b", "assetPath": "images/b.png"},
                ],
                "edges": [],
            },
        )
        target_canvas = self.write_canvas(self.canvases_dir / "目标.canvas")
        source_assets = target.canvas_assets_root(source) / "images"
        source_assets.mkdir(parents=True)
        (source_assets / "a.png").write_bytes(b"a")
        (source_assets / "b.png").write_bytes(b"b")
        self.write_recent([
            self.entry("cf_source", source),
            self.entry("cf_target", target_canvas),
        ])
        revision = target.canvas_import_source_payload("cf_source")["revision"]
        real_copy = target._atomic_copy_file
        call_count = 0

        def failing_copy(src, dst):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise OSError("simulated copy failure")
            real_copy(src, dst)

        with mock.patch.object(target, "_atomic_copy_file", side_effect=failing_copy):
            with self.assertRaises(target.CanvasImportLibraryError) as failed:
                target.copy_canvas_import_assets(
                    "cf_source",
                    revision,
                    str(target_canvas),
                    ["images/a.png", "images/b.png"],
                )
        self.assertEqual(failed.exception.code, "ASSET_COPY_FAILED")
        target_assets = target.canvas_assets_root(target_canvas)
        self.assertFalse(target_assets.exists() and any(target_assets.rglob("*")))


if __name__ == "__main__":
    unittest.main()
