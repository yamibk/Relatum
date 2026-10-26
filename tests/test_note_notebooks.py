"""Notebook preferences and directory boundaries, using disposable user data."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import notes_library
from notes_library import NotesError, NotesStore


class NotebookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = NotesStore(self.root / "notes")
        self.addCleanup(self.store.close)
        self.settings_path = self.root / "data" / "note-notebooks.json"

    def notebook(self, name="Physics"):
        return self.store.create("CustomNotebook", name, "folder", create_parents=True)["path"]

    def test_default_does_not_create_container_or_preferences(self):
        self.assertFalse(self.store.notebook_settings()["ui"]["open"])
        self.store.tree()
        self.assertFalse((self.store.root / "CustomNotebook").exists())
        self.assertFalse(self.settings_path.exists())
        self.store.update_notebook_settings({"ui": {"open": False}})
        self.assertFalse(self.settings_path.exists())

    def test_empty_notebook_creation_and_collision(self):
        relative = self.notebook()
        self.assertEqual(relative, "CustomNotebook/Physics")
        container = self.store.tree()["entries"][0]
        self.assertEqual(container["children"][0]["children"], [])
        with self.assertRaises(NotesError):
            self.notebook("physics")
        with self.assertRaises(NotesError):
            self.store.create("CustomNotebook", "Loose", "note")

    def test_legacy_history_mode_falls_back_without_startup_write(self):
        self.settings_path.parent.mkdir(parents=True)
        legacy = {"version": 1, "colors": {}, "ui": {"open": True, "mode": "history"}}
        original = json.dumps(legacy)
        self.settings_path.write_text(original, encoding="utf-8")
        settings = self.store.notebook_settings()
        self.assertEqual(settings["ui"]["mode"], "notebooks")
        self.assertEqual(self.settings_path.read_text(encoding="utf-8"), original)
        self.store.update_notebook_settings({"ui": settings["ui"]})
        self.assertEqual(json.loads(self.settings_path.read_text(encoding="utf-8"))["ui"]["mode"], "notebooks")

    def test_root_and_container_are_protected(self):
        self.notebook()
        for path in ("", "CustomNotebook", "customnotebook"):
            with self.assertRaises(NotesError):
                self.store.trash_targets(path)
            with self.assertRaises(NotesError):
                self.store.move(path, "Renamed")
        with self.assertRaises(NotesError):
            self.store.move("CustomNotebook/Physics", "CustomNotebook")
        with self.assertRaises(NotesError):
            self.store.create("", "CustomNotebook", "folder")
        relative, targets = self.store.trash_targets("CustomNotebook/Physics")
        self.assertEqual(relative, "CustomNotebook/Physics")
        self.assertEqual(targets, [self.store.root / relative])

    def test_folder_moves_across_notebooks_preserve_assets_links_and_index_identity(self):
        source = self.notebook("源本")
        target = self.notebook("目标本")
        folder = self.store.create(source, "戴维宁定理", "folder")["path"]
        note = self.store.create(folder + "/小节", "正文", "note", create_parents=True)["path"]
        image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
        uploaded = self.store.upload_image(note, "diagram.png", image, "image/png")
        loaded = self.store.load(note)
        self.store.save(note, "# 定理\n#迁移\n![diagram](" + uploaded["path"] + ")", loaded["revision"])
        self.store.create("", "Index", "note", content="[[" + note[:-3] + "]]")
        self.store.sync.complete()
        with self.store.index.read() as conn:
            identity = conn.execute("SELECT id FROM entries WHERE path=?", (note,)).fetchone()[0]
        for root in (target, "", source):
            destination = (root + "/" if root else "") + "戴维宁定理"
            with self.subTest(target=root):
                self.store.move(folder, destination)
                self.store.sync.complete()
                moved_note = destination + "/小节/正文.md"
                self.assertFalse((self.store.root / folder).exists())
                self.assertIn("[[" + moved_note[:-3] + "]]", self.store.load("Index.md")["content"])
                resolved, media_type = self.store.resolve_image(moved_note, uploaded["path"])
                self.assertEqual(media_type, "image/png")
                self.assertEqual(resolved.read_bytes(), image)
                with self.store.index.read() as conn:
                    row = conn.execute("SELECT e.id,b.root FROM entries e JOIN books b ON b.id=e.book WHERE e.path=?", (moved_note,)).fetchone()
                    self.assertEqual(tuple(row), (identity, root))
                    self.assertEqual(conn.execute("SELECT COUNT(*) FROM tags WHERE entry=?", (identity,)).fetchone()[0], 1)
                folder = destination

    def test_note_moves_across_notebooks_preserve_assets_links_and_index_identity(self):
        source = self.notebook("源本")
        target = self.notebook("目标本")
        note = self.store.create(source + "/小节", "单篇", "note", create_parents=True)["path"]
        image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
        uploaded = self.store.upload_image(note, "diagram.png", image, "image/png")
        loaded = self.store.load(note)
        self.store.save(note, "# 单篇\n#迁移\n![diagram](" + uploaded["path"] + ")", loaded["revision"])
        companion = (self.store.root / note).with_suffix(".assets")
        (companion / "attachment.pdf").write_bytes(b"companion attachment")
        self.store.create("", "Index", "note", content="[[" + note[:-3] + "#单篇|引用]]")
        self.store.sync.complete()
        with self.store.index.read() as conn:
            identity = conn.execute("SELECT id FROM entries WHERE path=?", (note,)).fetchone()[0]
        for root in (target, "", source):
            destination = (root + "/" if root else "") + "单篇.md"
            with self.subTest(target=root):
                self.store.move(note, destination)
                self.store.sync.complete()
                self.assertFalse((self.store.root / note).exists())
                self.assertFalse((self.store.root / note).with_suffix(".assets").exists())
                self.assertIn("#单篇|引用]]", self.store.load("Index.md")["content"])
                self.assertEqual(self.store.links("Index.md")["outgoing"][0]["path"], destination)
                resolved, media_type = self.store.resolve_image(destination, uploaded["path"])
                self.assertEqual(media_type, "image/png")
                self.assertEqual(resolved.read_bytes(), image)
                self.assertEqual((self.store.root / destination).with_suffix(".assets").joinpath("attachment.pdf").read_bytes(), b"companion attachment")
                self.assertEqual(self.store.links(destination)["backlinks"][0]["path"], "Index.md")
                with self.store.index.read() as conn:
                    row = conn.execute("SELECT e.id,b.root FROM entries e JOIN books b ON b.id=e.book WHERE e.path=?", (destination,)).fetchone()
                    self.assertEqual(tuple(row), (identity, root))
                    self.assertEqual(conn.execute("SELECT COUNT(*) FROM tags WHERE entry=?", (identity,)).fetchone()[0], 1)
                note = destination

    def test_cross_notebook_note_and_companion_conflicts_preserve_both_sides(self):
        source = self.notebook("Source")
        target = self.notebook("Target")
        image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
        for name, conflict in (("Same", "Same.md"), ("CaseNote", "casenote.md"), ("Assets", "Assets.assets")):
            with self.subTest(conflict=conflict):
                note = self.store.create(source, name, "note", content="source content")["path"]
                uploaded = self.store.upload_image(note, "diagram.png", image, "image/png")
                existing = self.store.root / target / conflict
                if conflict.endswith(".assets"):
                    existing.mkdir()
                    existing = existing / "keep.bin"
                existing.write_bytes(b"target content")
                with self.assertRaises(NotesError) as caught:
                    self.store.move(note, target + "/" + name + ".md")
                self.assertEqual(caught.exception.code, "exists")
                self.assertEqual(self.store.load(note)["content"], "source content")
                self.assertEqual(self.store.resolve_image(note, uploaded["path"])[0].read_bytes(), image)
                self.assertEqual(existing.read_bytes(), b"target content")

    def test_cross_notebook_note_failed_rewrite_rolls_back_assets(self):
        source = self.notebook("Source")
        target = self.notebook("Target")
        note = self.store.create(source, "单篇", "note", content="source content")["path"]
        image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
        uploaded = self.store.upload_image(note, "diagram.png", image, "image/png")
        reference = "[[" + note[:-3] + "]]"
        self.store.create("", "Index", "note", content=reference)
        self.store.sync.complete()
        with mock.patch.object(self.store, "atomic_text", side_effect=OSError("simulated write failure")):
            with self.assertRaises(OSError):
                self.store.move(note, target + "/单篇.md")
        self.assertEqual(self.store.load(note)["content"], "source content")
        self.assertEqual(self.store.load("Index.md")["content"], reference)
        self.assertEqual(self.store.resolve_image(note, uploaded["path"])[0].read_bytes(), image)
        self.assertFalse((self.store.root / target / "单篇.md").exists())
        self.assertFalse((self.store.root / target / "单篇.assets").exists())

    def test_cross_notebook_empty_folder_and_case_conflict(self):
        source = self.notebook("Source")
        target = self.notebook("Target")
        self.store.create(source, "Folder", "folder")
        self.store.create(target, "folder", "folder")
        self.store.create(source + "/Folder", "Keep", "note", content="source content")
        self.store.create(target + "/folder", "Keep", "note", content="target content")
        with self.assertRaises(NotesError) as caught:
            self.store.move(source + "/Folder", target + "/Folder")
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "exists")
        self.assertEqual(self.store.load(source + "/Folder/Keep.md")["content"], "source content")
        self.assertEqual(self.store.load(target + "/folder/Keep.md")["content"], "target content")
        empty = self.store.create(source, "Empty", "folder")["path"]
        self.store.move(empty, target + "/Empty")
        self.assertTrue((self.store.root / target / "Empty").is_dir())
        self.assertFalse((self.store.root / empty).exists())
        self.assertEqual(list((self.store.root / target / "Empty").iterdir()), [])

    def test_cross_notebook_missing_target_and_failed_rewrite_preserve_source(self):
        source = self.notebook("Source")
        target = self.notebook("Target")
        folder = self.store.create(source, "Folder", "folder")["path"]
        note = self.store.create(folder, "Keep", "note", content="source content")["path"]
        self.store.create("", "Index", "note", content="[[" + note[:-3] + "]]")
        self.store.sync.complete()
        with mock.patch.object(self.store, "atomic_text", side_effect=OSError("simulated write failure")):
            with self.assertRaises(OSError):
                self.store.move(folder, target + "/Folder")
        self.assertEqual(self.store.load(note)["content"], "source content")
        self.assertIn("[[" + note[:-3] + "]]", self.store.load("Index.md")["content"])
        self.assertFalse((self.store.root / target / "Folder").exists())
        (self.store.root / target).rmdir()
        with self.assertRaises(NotesError) as caught:
            self.store.move(folder, target + "/Folder")
        self.assertEqual(caught.exception.code, "parent_missing")
        self.assertTrue((self.store.root / note).is_file())

    def test_merge_roundtrip_and_no_unchanged_write(self):
        relative = self.notebook()
        self.store.update_notebook_settings({"colors": {relative: "blue"}})
        expected = self.store.update_notebook_settings({"ui": {"open": True, "selectedRoot": relative, "expanded": ["", relative]}})
        self.assertEqual(expected["colors"], {relative: "blue"})
        self.assertEqual(NotesStore(self.store.root).notebook_settings(), expected)
        with mock.patch.object(self.store, "atomic_text", side_effect=AssertionError("unchanged write")):
            self.assertEqual(self.store.update_notebook_settings({"ui": expected["ui"]}), expected)
        self.assertEqual(json.loads(self.settings_path.read_text(encoding="utf-8")), expected)

    def test_invalid_colors_and_paths_do_not_write(self):
        self.notebook()
        for patch in ({"colors": {"../escape": "blue"}}, {"colors": {"": "blue"}},
                      {"colors": {"CustomNotebook/Physics/sub": "blue"}},
                      {"colors": {"CustomNotebook/Physics": "invalid"}},
                      {"ui": {"selectedRoot": "ordinary-folder"}}, {"ui": {"expanded": ["../escape"]}},
                      {"ui": {"selectedRoot": False}}, {"ui": {"selectedRoot": []}}, {"ui": {"selectedRoot": 1}}):
            with self.subTest(patch=patch), self.assertRaises(NotesError):
                self.store.update_notebook_settings(patch)
        self.assertFalse(self.settings_path.exists())

    def test_visibility_legacy_defaults_and_invalid_stored_values_do_not_write(self):
        relative = self.notebook()
        self.settings_path.parent.mkdir(exist_ok=True)
        for visibility in (None, [], {relative: False, "": False, "ordinary": False,
                                      "CustomNotebook": False, "../escape": False,
                                      "CustomNotebook/Visible": True, "CustomNotebook/Bad": 0}):
            with self.subTest(visibility=visibility):
                raw = {"version": 1, "colors": {relative: "blue"}, "ui": {}}
                if visibility is not None:
                    raw["visible"] = visibility
                original = json.dumps(raw)
                self.settings_path.write_text(original, encoding="utf-8")
                reloaded = NotesStore(self.store.root)
                self.addCleanup(reloaded.close)
                settings = reloaded.notebook_settings()
                self.assertEqual(settings["visible"], {relative: False, "": False} if isinstance(visibility, dict) else {})
                self.assertEqual(settings["colors"], {relative: "blue"})
                self.assertEqual(self.settings_path.read_text(encoding="utf-8"), original)

    def test_visibility_roundtrip_sparse_restore_and_independent_settings(self):
        relative = self.notebook()
        before = self.store.update_notebook_settings({"colors": {relative: "green"},
            "ui": {"selectedRoot": relative, "expanded": ["", relative]}})
        hidden = self.store.update_notebook_settings({"visible": {relative: False, "": False}})
        self.assertEqual(hidden["visible"], {relative: False, "": False})
        self.assertEqual(hidden["colors"], before["colors"])
        self.assertEqual(hidden["ui"], before["ui"])
        reloaded = NotesStore(self.store.root)
        self.addCleanup(reloaded.close)
        self.assertEqual(reloaded.notebook_settings(), hidden)
        with mock.patch.object(self.store, "atomic_text", side_effect=AssertionError("unchanged write")):
            self.assertEqual(self.store.update_notebook_settings({"visible": {relative: False}}), hidden)
        restored = self.store.update_notebook_settings({"visible": {relative: True, "": True}})
        self.assertEqual(restored["visible"], {})
        self.assertEqual(restored["colors"], before["colors"])
        self.assertEqual(restored["ui"], before["ui"])

    def test_invalid_visibility_patch_does_not_write(self):
        relative = self.notebook()
        for patch in ({"visible": []}, {"visible": None}, {"visible": {"../escape": False}},
                      {"visible": {"CustomNotebook": False}}, {"visible": {"ordinary": False}},
                      {"visible": {relative + "/sub": False}}, {"visible": {relative: None}},
                      {"visible": {relative: "false"}}, {"visible": {relative: 0}},
                      {"visible": {relative: False, "CustomNotebook/Missing": False}}):
            with self.subTest(patch=patch), self.assertRaises(NotesError):
                self.store.update_notebook_settings(patch)
        self.assertEqual(self.store.notebook_settings()["visible"], {})
        self.assertFalse(self.settings_path.exists())

    def test_failed_visibility_write_preserves_previous_config(self):
        relative = self.notebook()
        before = self.store.update_notebook_settings({"colors": {relative: "red"}, "visible": {relative: False}})
        original = self.settings_path.read_bytes()
        with mock.patch.object(self.store, "atomic_text", side_effect=OSError("disk full")), self.assertRaises(OSError):
            self.store.update_notebook_settings({"visible": {relative: True}})
        self.assertEqual(self.store.notebook_settings(), before)
        self.assertEqual(self.settings_path.read_bytes(), original)

    def test_restore_visibility_can_clear_a_missing_notebook(self):
        relative = self.notebook()
        self.store.update_notebook_settings({"visible": {relative: False}})
        (self.store.root / relative).rmdir()
        self.assertEqual(self.store.update_notebook_settings({"visible": {relative: True}})["visible"], {})
        self.assertFalse((self.store.root / relative).exists())

    def test_visibility_cleanup_preserves_unreadable_and_existing_notebooks(self):
        relative = self.notebook()
        before = self.store.update_notebook_settings({"colors": {relative: "yellow"},
            "visible": {relative: False, "": False}, "ui": {"expanded": [relative]}})
        self.assertEqual(self.store.update_notebook_settings({"pruneMissing": [relative]})["visible"], before["visible"])
        original = Path.stat
        def inaccessible(target, *args, **kwargs):
            if target == self.store.root / relative:
                raise PermissionError("temporarily inaccessible")
            return original(target, *args, **kwargs)
        with mock.patch.object(Path, "stat", inaccessible):
            self.assertEqual(self.store.update_notebook_settings({"pruneMissing": [relative]})["visible"], before["visible"])
        (self.store.root / relative).rmdir()
        pruned = self.store.update_notebook_settings({"pruneMissing": [relative]})
        self.assertEqual(pruned["visible"], {"": False})
        self.assertEqual(pruned["colors"], {})
        self.assertEqual(pruned["ui"]["expanded"], [])

    def test_visibility_path_remap_preserves_hidden_color(self):
        source = self.notebook()
        self.store.update_notebook_settings({"colors": {source: "purple"}, "visible": {source: False}})
        destination = "CustomNotebook/Renamed"
        self.store.move(source, destination)
        updated = self.store.update_notebook_settings({"colors": {destination: "purple"},
            "visible": {destination: False}, "pruneMissing": [source]})
        self.assertEqual(updated["visible"], {destination: False})
        self.assertEqual(updated["colors"], {destination: "purple"})

    def test_canvas_sidebar_mode_roundtrip(self):
        saved = self.store.update_notebook_settings({"ui": {"mode": "canvas", "open": True}})
        self.assertEqual(saved["ui"]["mode"], "canvas")
        self.assertEqual(NotesStore(self.store.root).notebook_settings(), saved)
        with self.assertRaises(NotesError):
            self.store.update_notebook_settings({"ui": {"mode": "unknown"}})

    def test_guide_sidebar_mode_roundtrip(self):
        saved = self.store.update_notebook_settings({"ui": {"mode": "guide", "open": True}})
        self.assertEqual(saved["ui"]["mode"], "guide")
        self.assertEqual(NotesStore(self.store.root).notebook_settings(), saved)

    def test_outline_sidebar_mode_roundtrip(self):
        saved = self.store.update_notebook_settings({"ui": {"mode": "outline", "open": True}})
        self.assertEqual(saved["ui"]["mode"], "outline")
        self.assertTrue(saved["ui"]["open"])
        reloaded = NotesStore(self.store.root)
        self.assertEqual(reloaded.notebook_settings()["ui"]["mode"], "outline")
        self.assertEqual(NotesStore(self.store.root).notebook_settings(), saved)

    def test_unselected_roundtrip_and_partial_merge(self):
        relative = self.notebook()
        before = self.store.update_notebook_settings({"colors": {relative: "blue"},
            "ui": {"selectedRoot": relative, "expanded": ["", relative]}})
        unselected = self.store.update_notebook_settings({"ui": {"selectedRoot": None}})
        self.assertIsNone(unselected["ui"]["selectedRoot"])
        self.assertEqual(unselected["colors"], before["colors"])
        self.assertEqual(unselected["ui"]["expanded"], before["ui"]["expanded"])
        merged = self.store.update_notebook_settings({"ui": {"open": True, "mode": "links"}})
        self.assertIsNone(merged["ui"]["selectedRoot"])
        self.assertEqual(NotesStore(self.store.root).notebook_settings(), merged)
        self.assertEqual(json.loads(self.settings_path.read_text(encoding="utf-8")), merged)
        with mock.patch.object(self.store, "atomic_text", side_effect=AssertionError("unchanged write")):
            self.assertEqual(self.store.update_notebook_settings({"ui": {"selectedRoot": None}}), merged)
        (self.store.root / relative).rmdir()
        pruned = self.store.update_notebook_settings({"pruneMissing": [relative]})
        self.assertIsNone(pruned["ui"]["selectedRoot"])
        self.assertEqual(pruned["colors"], {})
        self.assertEqual(pruned["ui"]["expanded"], [""])

    def test_selected_root_read_defaults_and_null_do_not_rewrite(self):
        self.settings_path.parent.mkdir()
        for ui, expected in (({}, ""), ({"selectedRoot": False}, ""),
                             ({"selectedRoot": "ordinary-folder"}, ""), ({"selectedRoot": None}, None)):
            with self.subTest(ui=ui):
                raw = json.dumps({"version": 1, "colors": {}, "ui": ui})
                self.settings_path.write_text(raw, encoding="utf-8")
                self.assertEqual(NotesStore(self.store.root).notebook_settings()["ui"]["selectedRoot"], expected)
                self.assertEqual(self.settings_path.read_text(encoding="utf-8"), raw)

    def test_only_confirmed_missing_paths_are_pruned(self):
        relative = self.notebook()
        self.store.update_notebook_settings({"colors": {relative: "purple"}, "ui": {"selectedRoot": relative, "expanded": ["", relative]}})
        original = Path.stat
        def inaccessible(target, *args, **kwargs):
            if target == self.store.root / relative:
                raise PermissionError("temporarily inaccessible")
            return original(target, *args, **kwargs)
        with mock.patch.object(Path, "stat", inaccessible):
            preserved = self.store.update_notebook_settings({"pruneMissing": [relative]})
        self.assertEqual(preserved["colors"], {relative: "purple"})
        def resolve_denied(path):
            try:
                raise PermissionError("directory resolution denied")
            except PermissionError as cause:
                raise NotesError("cannot resolve", code="unsafe_path") from cause
        with mock.patch.object(self.store, "_absolute", side_effect=resolve_denied):
            self.assertEqual(self.store.update_notebook_settings({"pruneMissing": [relative]})["colors"], {relative: "purple"})
        (self.store.root / relative).rmdir()
        result = self.store.update_notebook_settings({"pruneMissing": [relative]})
        self.assertEqual(result["colors"], {})
        self.assertEqual(result["ui"]["selectedRoot"], "")
        self.assertEqual(result["ui"]["expanded"], [""])
        self.assertFalse((self.store.root / relative).exists())

    def test_failed_atomic_write_preserves_previous_config(self):
        relative = self.notebook()
        before = self.store.update_notebook_settings({"colors": {relative: "green"}})
        raw = self.settings_path.read_bytes()
        with mock.patch.object(self.store, "atomic_text", side_effect=OSError("disk full")), self.assertRaises(OSError):
            self.store.update_notebook_settings({"colors": {relative: "red"}})
        self.assertEqual(self.store.notebook_settings(), before)
        self.assertEqual(self.settings_path.read_bytes(), raw)

    def test_case_only_external_rename_discards_old_path_color(self):
        relative = self.notebook()
        self.store.update_notebook_settings({"colors": {relative: "blue"}})
        target = self.store.root / relative
        intermediate = target.with_name("temporary-case-rename")
        target.rename(intermediate)
        intermediate.rename(target.with_name("physics"))
        result = self.store.update_notebook_settings({"pruneMissing": [relative]})
        self.assertEqual(result["colors"], {})
        self.assertIn(relative, result["prunedPaths"])

    def test_corruption_defaults_and_process_cached_reads(self):
        self.settings_path.parent.mkdir()
        self.settings_path.write_text("invalid json", encoding="utf-8")
        default = self.store.notebook_settings()
        self.assertEqual(default["colors"], {})
        self.assertEqual(self.settings_path.read_text(encoding="utf-8"), "invalid json")
        self.settings_path.write_text(json.dumps({"version": 1, "ui": {"open": True}}), encoding="utf-8")
        self.assertEqual(self.store.notebook_settings(), default)
        self.assertTrue(NotesStore(self.store.root).notebook_settings()["ui"]["open"])

    def test_container_reparse_is_rejected(self):
        self.store.ensure_root()
        original = notes_library._is_reparse
        with mock.patch("notes_library._is_reparse", side_effect=lambda path: path == self.store.root / "CustomNotebook" or original(path)):
            with self.assertRaises(NotesError):
                self.notebook()


if __name__ == "__main__":
    unittest.main()
