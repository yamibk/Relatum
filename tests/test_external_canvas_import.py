import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app as target


class ExternalCanvasImportTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.canvases = self.root / "canvases"
        self.data = self.root / "data"
        self.sources = self.root / "sources"
        self.canvases.mkdir()
        self.data.mkdir()
        self.sources.mkdir()
        self.patchers = [
            mock.patch.object(target, "ROOT", self.root),
            mock.patch.object(target, "CANVASES", self.canvases),
            mock.patch.object(target, "TRASH", self.canvases / "回收站"),
            mock.patch.object(target, "DATA", self.data),
            mock.patch.object(target, "RECENT_FILE", self.data / "recent.json"),
            mock.patch.object(target, "RECENT_BACKUP_FILE", self.data / "recent.backup.json"),
            mock.patch.object(target, "CANVAS_ACTIVITY_FILE", self.data / "canvas-activity.json"),
            mock.patch.object(
                target,
                "record_canvas_activity_event",
                side_effect=lambda path, event, payload=None: {
                    "canvasId": "test-" + path.stem,
                    "todaySec": 0,
                    "totalSec": 0,
                },
            ),
        ]
        for patcher in self.patchers:
            patcher.start()
        target.save_recent({
            "version": 3,
            "groups": [{"id": "g_shared", "name": "朋友分享"}],
            "files": [],
        })

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp_dir.cleanup()

    def write_canvas(self, path: Path, *, asset=None, node_id="n1") -> dict:
        payload = {
            "version": 2,
            "nodes": [{"id": node_id, "text": path.stem}],
            "edges": [],
        }
        if asset:
            payload["nodes"][0]["assetPath"] = asset
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return payload

    def import_one(self, source: Path, group="") -> dict:
        plan = target._prepare_external_canvas(source, strict=False)
        return target.import_external_canvas_copies([plan], group=group)

    def test_single_import_creates_managed_copy_and_preserves_source(self):
        source = self.sources / "朋友画布.canvas"
        payload = self.write_canvas(source)
        original = source.read_bytes()

        result = self.import_one(source, "g_shared")

        imported = Path(result["items"][0]["path"])
        self.assertEqual(imported.parent, self.canvases)
        self.assertEqual(json.loads(imported.read_text(encoding="utf-8")), payload)
        self.assertEqual(source.read_bytes(), original)
        recent = target.load_recent()["files"][0]
        self.assertEqual(recent["path"], str(imported.resolve()))
        self.assertEqual(recent["groupId"], "g_shared")

    def test_single_import_copies_referenced_assets_and_annotations(self):
        source = self.sources / "附件.canvas"
        self.write_canvas(source, asset="images/photo.png")
        assets = self.sources / "附件.assets"
        (assets / "images").mkdir(parents=True)
        (assets / "images" / "photo.png").write_bytes(b"png")
        (assets / "images" / "photo.png.annot.json").write_text("{}", encoding="utf-8")
        (assets / "node-annotations.json").write_text('{"nodes":{}}', encoding="utf-8")
        (assets / "orphan.txt").write_text("not copied", encoding="utf-8")

        result = self.import_one(source)

        imported = Path(result["items"][0]["path"])
        imported_assets = target.canvas_assets_root(imported)
        self.assertEqual(result["assetCount"], 3)
        self.assertTrue((imported_assets / "images" / "photo.png").is_file())
        self.assertTrue((imported_assets / "images" / "photo.png.annot.json").is_file())
        self.assertTrue((imported_assets / "node-annotations.json").is_file())
        self.assertFalse((imported_assets / "orphan.txt").exists())

    def test_single_import_allows_missing_assets_and_reports_count(self):
        source = self.sources / "缺附件.canvas"
        self.write_canvas(source, asset="attachments/missing.pdf")

        result = self.import_one(source)

        self.assertEqual(result["missingAssetCount"], 1)
        self.assertTrue(Path(result["items"][0]["path"]).is_file())

    def test_single_import_rejects_invalid_or_oversized_canvas(self):
        invalid = self.sources / "invalid.canvas"
        invalid.write_text("not json", encoding="utf-8")
        with self.assertRaises(target.ExternalCanvasImportError):
            target._prepare_external_canvas(invalid, strict=False)

        oversized = self.sources / "oversized.canvas"
        with oversized.open("wb") as handle:
            handle.truncate(target.MAX_JSON_BODY_BYTES + 1)
        with self.assertRaisesRegex(target.ExternalCanvasImportError, "160 MiB"):
            target._prepare_external_canvas(oversized, strict=False)

    def test_collision_renames_canvas_and_companion_assets_together(self):
        (self.canvases / "重名.canvas").write_text('{"nodes":[]}', encoding="utf-8")
        source = self.sources / "重名.canvas"
        self.write_canvas(source, asset="images/p.png")
        assets = self.sources / "重名.assets" / "images"
        assets.mkdir(parents=True)
        (assets / "p.png").write_bytes(b"png")

        result = self.import_one(source)

        imported = Path(result["items"][0]["path"])
        self.assertEqual(imported.name, "重名-2.canvas")
        self.assertTrue((self.canvases / "重名-2.assets" / "images" / "p.png").is_file())
        self.assertEqual(result["renamedCount"], 1)

    def test_strict_folder_imports_top_level_canvases_as_one_batch(self):
        folder = self.sources / "any-folder-name"
        folder.mkdir()
        alpha = folder / "Alpha.canvas"
        beta = folder / "Beta.canvas"
        self.write_canvas(alpha, asset="attachments/note.md")
        self.write_canvas(beta, node_id="n2")
        attachments = folder / "Alpha.assets" / "attachments"
        attachments.mkdir(parents=True)
        (attachments / "note.md").write_text("# note", encoding="utf-8")
        (self.canvases / "Alpha.canvas").write_text('{"nodes":[]}', encoding="utf-8")

        plans, signature = target._scan_external_canvas_folder(folder)
        result = target.import_external_canvas_copies(
            plans,
            group="g_shared",
            folder_source=folder,
            folder_signature=signature,
        )

        self.assertEqual(result["count"], 2)
        self.assertEqual(result["renamedCount"], 1)
        self.assertEqual({item["title"] for item in result["items"]}, {"Alpha-2", "Beta"})
        self.assertTrue((self.canvases / "Alpha-2.assets" / "attachments" / "note.md").is_file())
        self.assertEqual(
            {item["groupId"] for item in target.load_recent()["files"]},
            {"g_shared"},
        )

    def test_strict_folder_rejects_unknown_trash_or_incomplete_assets(self):
        cases = ("unknown", "trash", "missing", "orphan")
        for case in cases:
            with self.subTest(case=case):
                folder = self.sources / case
                folder.mkdir()
                canvas = folder / "One.canvas"
                self.write_canvas(canvas, asset="images/missing.png" if case == "missing" else None)
                if case == "unknown":
                    (folder / "desktop.ini").write_text("x", encoding="utf-8")
                elif case == "trash":
                    (folder / "回收站").mkdir()
                elif case == "orphan":
                    (folder / "Other.assets").mkdir()
                with self.assertRaises(target.ExternalCanvasImportError):
                    target._scan_external_canvas_folder(folder)

    def test_strict_folder_rejects_unreferenced_asset_file(self):
        folder = self.sources / "unknown-asset"
        folder.mkdir()
        canvas = folder / "One.canvas"
        self.write_canvas(canvas)
        assets = folder / "One.assets"
        assets.mkdir()
        (assets / "extra.png").write_bytes(b"png")

        with self.assertRaisesRegex(target.ExternalCanvasImportError, "未知或未引用"):
            target._scan_external_canvas_folder(folder)

    def test_strict_folder_rejects_invalid_annotation_and_link_entry(self):
        annotation_folder = self.sources / "bad-annotation"
        annotation_folder.mkdir()
        canvas = annotation_folder / "One.canvas"
        self.write_canvas(canvas, asset="attachments/note.md")
        assets = annotation_folder / "One.assets" / "attachments"
        assets.mkdir(parents=True)
        (assets / "note.md").write_text("note", encoding="utf-8")
        (assets / "note.md.annot.json").write_text("not json", encoding="utf-8")
        with self.assertRaisesRegex(target.ExternalCanvasImportError, "批注"):
            target._scan_external_canvas_folder(annotation_folder)

        link_folder = self.sources / "link-entry"
        link_folder.mkdir()
        unsafe = link_folder / "unsafe.canvas"
        self.write_canvas(unsafe)
        original = target._is_link_or_reparse
        with mock.patch.object(
            target,
            "_is_link_or_reparse",
            side_effect=lambda path: path == unsafe or original(path),
        ):
            with self.assertRaisesRegex(target.ExternalCanvasImportError, "链接或重解析点"):
                target._scan_external_canvas_folder(link_folder)

    def test_folder_source_change_before_commit_leaves_no_import(self):
        folder = self.sources / "changed"
        folder.mkdir()
        canvas = folder / "One.canvas"
        self.write_canvas(canvas)
        plans, signature = target._scan_external_canvas_folder(folder)

        with mock.patch.object(
            target,
            "_external_tree_signature",
            return_value=(("changed", "file", 1, 1),),
        ):
            with self.assertRaisesRegex(target.ExternalCanvasImportError, "发生变化"):
                target.import_external_canvas_copies(
                    plans,
                    folder_source=folder,
                    folder_signature=signature,
                )

        self.assertFalse((self.canvases / "One.canvas").exists())

    def test_index_failure_rolls_back_materialized_files_and_recent_state(self):
        source = self.sources / "Rollback.canvas"
        self.write_canvas(source)
        before = target.RECENT_FILE.read_bytes()
        plan = target._prepare_external_canvas(source, strict=False)

        with mock.patch.object(target, "register_recent", side_effect=OSError("index failed")):
            with self.assertRaises(target.ExternalCanvasImportError):
                target.import_external_canvas_copies([plan])

        self.assertFalse((self.canvases / "Rollback.canvas").exists())
        self.assertEqual(target.RECENT_FILE.read_bytes(), before)
        self.assertFalse(list(self.canvases.glob(".relatum-import-*")))


if __name__ == "__main__":
    unittest.main()
