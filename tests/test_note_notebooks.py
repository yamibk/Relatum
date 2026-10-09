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

    def test_canvas_sidebar_mode_roundtrip(self):
        saved = self.store.update_notebook_settings({"ui": {"mode": "canvas", "open": True}})
        self.assertEqual(saved["ui"]["mode"], "canvas")
        self.assertEqual(NotesStore(self.store.root).notebook_settings(), saved)
        with self.assertRaises(NotesError):
            self.store.update_notebook_settings({"ui": {"mode": "unknown"}})

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
