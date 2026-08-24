import base64
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import notes_library
from notes_library import NotesError, NotesStore


class NotesLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "notes"
        self.recovery = Path(self.temp.name) / "data" / "note-recovery"
        self.store = NotesStore(self.root, recovery_root=self.recovery)
        self.store.ensure_root()

    def tearDown(self):
        self.temp.cleanup()

    def test_nested_create_tree_and_path_guards(self):
        created = self.store.create("", "课程/数学/极限", "note", create_parents=True)
        self.assertEqual(created["path"], "课程/数学/极限.md")
        tree = self.store.tree()
        self.assertEqual(tree["entries"][0]["name"], "课程")
        with self.assertRaises(NotesError):
            self.store.create("../outside", "bad", "note")
        with self.assertRaises(NotesError):
            self.store.create("", "C:/outside", "note")
        with self.assertRaises(NotesError):
            self.store.create("", "CON", "folder")
        with self.assertRaises(NotesError):
            self.store.create("", "topic.assets", "folder")
        self.store.create("", "大小写", "note")
        with self.assertRaises(NotesError):
            self.store.create("", "大小写.MD", "note")

    def test_stale_revision_snapshots_disk_then_editor_wins(self):
        self.store.create("", "A", "note", content="one")
        loaded = self.store.load("A.md")
        saved = self.store.save("A.md", "two", loaded["revision"])
        self.assertTrue(saved["revision"].startswith("sha256:"))
        overwritten = self.store.save("A.md", "three", loaded["revision"])
        self.assertEqual(self.store.load("A.md")["content"], "three")
        versions = self.store.history("A.md")["versions"]
        self.assertTrue(versions)
        restored_disk = self.store.history_version("A.md", versions[0]["id"])
        self.assertEqual(restored_disk["content"], "two")
        self.assertEqual(overwritten["revision"], self.store.load("A.md")["revision"])

    def test_concurrent_revision_writers_are_serialized_without_conflict_ui(self):
        self.store.create("", "Concurrent", "note", content="base")
        revision = self.store.load("Concurrent.md")["revision"]
        barrier = threading.Barrier(2)
        results = []
        result_lock = threading.Lock()
        store_lock = threading.Lock()

        def writer(value):
            barrier.wait()
            with store_lock:
                result = ("saved", self.store.save("Concurrent.md", value, revision))
            with result_lock:
                results.append(result)

        first = threading.Thread(target=writer, args=("one",))
        second = threading.Thread(target=writer, args=("two",))
        first.start()
        second.start()
        first.join()
        second.join()
        self.assertEqual([item[0] for item in results], ["saved", "saved"])
        self.assertIn(self.store.load("Concurrent.md")["content"], {"one", "two"})
        self.assertGreaterEqual(len(self.store.history("Concurrent.md")["versions"]), 2)

    def test_links_backlinks_and_missing_states(self):
        self.store.create("", "A", "note", content="去 [[folder/B|第二篇]] 和 [[Missing]]")
        self.store.create("folder", "B", "note", content="返回 [[A]]", create_parents=True)
        loaded = self.store.links("A.md")
        self.assertEqual(loaded["outgoing"][0]["path"], "folder/B.md")
        self.assertEqual(loaded["outgoing"][1]["state"], "missing")
        target = self.store.links("folder/B.md")
        self.assertEqual(target["backlinks"][0]["path"], "A.md")

    def test_note_rename_rewrites_links_and_companion_images(self):
        self.store.create("", "Source", "note", content="[[Old#part|别名]]")
        self.store.create("", "Old", "note", content="![图](Old.assets/images/a.png)")
        image = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        uploaded = self.store.upload_image("Old.md", "a.png", image, "image/png")
        old_text = self.store.load("Old.md")
        self.store.save(
            "Old.md",
            old_text["content"].replace("Old.assets/images/a.png", uploaded["path"]),
            old_text["revision"],
        )
        moved = self.store.move("Old.md", "New.md")
        self.assertGreaterEqual(moved["rewritten"], 2)
        self.assertIn("[[New#part|别名]]", self.store.load("Source.md")["content"])
        self.assertIn("New.assets/images/", self.store.load("New.md")["content"])
        self.assertTrue((self.root / "New.assets" / "images").is_dir())
        self.assertFalse((self.root / "Old.assets").exists())

    def test_folder_move_rewrites_qualified_link(self):
        self.store.create("", "Index", "note", content="[[old/Topic]]")
        self.store.create("old", "Topic", "note", create_parents=True)
        result = self.store.move("old", "new")
        self.assertEqual(result["path"], "new")
        self.assertIn("[[new/Topic]]", self.store.load("Index.md")["content"])

    def test_case_only_note_rename_keeps_companion_assets(self):
        self.store.create("", "Topic", "note")
        image = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        self.store.upload_image("Topic.md", "a.png", image, "image/png")
        result = self.store.move("Topic.md", "topic.md")
        self.assertEqual(result["path"], "topic.md")
        self.assertTrue((self.root / "topic.md").is_file())
        self.assertTrue((self.root / "topic.assets" / "images").is_dir())

    def test_ambiguous_link_is_not_rewritten(self):
        self.store.create("", "Index", "note", content="[[Topic]]")
        self.store.create("one", "Topic", "note", create_parents=True)
        self.store.create("two", "Topic", "note", create_parents=True)
        result = self.store.move("one/Topic.md", "one/Renamed.md")
        self.assertTrue(result["warnings"])
        self.assertEqual(self.store.load("Index.md")["content"], "[[Topic]]")

    def test_asset_resolution_and_hidden_tree(self):
        self.store.create("", "Picture", "note")
        image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
        uploaded = self.store.upload_image("Picture.md", "示例.png", image, "image/png")
        target, media_type = self.store.resolve_image("Picture.md", uploaded["path"])
        self.assertEqual(media_type, "image/png")
        self.assertEqual(target.read_bytes(), image)
        names = [entry["name"] for entry in self.store.tree()["entries"]]
        self.assertEqual(names, ["Picture"])
        with self.assertRaises(NotesError):
            self.store.resolve_image("Picture.md", "https://example.com/a.png")
        with self.assertRaises(NotesError) as caught:
            self.store.upload_image("Picture.md", "forged.png", b"not a png", "image/png")
        self.assertEqual(caught.exception.code, "invalid_image")

    def test_relative_parent_image_stays_inside_vault(self):
        self.store.create("folder", "Picture", "note", create_parents=True)
        image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
        (self.root / "shared.png").write_bytes(image)
        target, media_type = self.store.resolve_image("folder/Picture.md", "../shared.png")
        self.assertEqual(target, self.root / "shared.png")
        self.assertEqual(media_type, "image/png")
        with self.assertRaises(NotesError):
            self.store.resolve_image("folder/Picture.md", "../../outside.png")

    def test_move_failure_rolls_back_note_assets_and_rewrites(self):
        self.store.create("", "Index", "note", content="[[Old]]")
        self.store.create("", "Old", "note", content="body")
        image = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        self.store.upload_image("Old.md", "a.png", image, "image/png")
        original_atomic = self.store.atomic_text
        calls = 0

        def fail_first_write(target, text):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError("simulated write failure")
            original_atomic(target, text)

        self.store.atomic_text = fail_first_write
        with self.assertRaises(OSError):
            self.store.move("Old.md", "New.md")
        self.assertTrue((self.root / "Old.md").is_file())
        self.assertTrue((self.root / "Old.assets" / "images").is_dir())
        self.assertFalse((self.root / "New.md").exists())
        self.assertEqual(self.store.load("Index.md")["content"], "[[Old]]")

    def test_trash_targets_include_companion_and_reject_root(self):
        self.store.create("folder", "A", "note", create_parents=True)
        image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
        self.store.upload_image("folder/A.md", "a.png", image, "image/png")
        normalized, targets = self.store.trash_targets("folder/A.md")
        self.assertEqual(normalized, "folder/A.md")
        self.assertEqual([target.name for target in targets], ["A.md", "A.assets"])
        normalized, targets = self.store.trash_targets("folder")
        self.assertEqual(normalized, "folder")
        self.assertEqual(targets, [self.root / "folder"])
        with self.assertRaises(NotesError):
            self.store.trash_targets("")

    def test_timestamp_note_and_inline_folder_defaults_are_unique(self):
        first = self.store.create_timestamp_note("")
        second = self.store.create_timestamp_note("")
        self.assertRegex(first["path"], r"^\d{4}-\d{2}-\d{2}-\d{6}\.md$")
        self.assertNotEqual(first["path"], second["path"])
        folder = self.store.create_untitled_folder("")
        another = self.store.create_untitled_folder("")
        self.assertEqual(folder["path"], "新建文件夹")
        self.assertEqual(another["path"], "新建文件夹-2")

    def test_history_restore_snapshots_current_version(self):
        self.store.create("", "History", "note", content="one")
        first = self.store.load("History.md")
        self.store.save("History.md", "two", first["revision"])
        version = self.store.history("History.md")["versions"][-1]
        restored = self.store.restore_history("History.md", version["id"])
        self.assertEqual(restored["content"], "one")
        contents = [
            self.store.history_version("History.md", item["id"])["content"]
            for item in self.store.history("History.md")["versions"]
        ]
        self.assertIn("two", contents)

    def test_history_interval_external_force_and_move_follow_path(self):
        self.store.create("", "Moving", "note", content="one")
        first = self.store.load("Moving.md")
        second = self.store.save("Moving.md", "two", first["revision"])
        self.store.save("Moving.md", "three", second["revision"])
        self.assertEqual(len(self.store.history("Moving.md")["versions"]), 1)
        self.store.save("Moving.md", "four", first["revision"])
        self.assertEqual(len(self.store.history("Moving.md")["versions"]), 2)
        self.store.move("Moving.md", "Moved.md")
        versions = self.store.history("Moved.md")["versions"]
        self.assertEqual(len(versions), 2)
        self.assertEqual(self.store.history_version("Moved.md", versions[0]["id"])["path"], "Moved.md")

    def test_history_prunes_snapshots_older_than_seven_days(self):
        self.store.create("", "Prune", "note", content="now")
        item = self.store.snapshot("Prune.md", "old", force=True)
        bucket = next(path for path in self.recovery.iterdir() if path.is_dir())
        manifest_path = bucket / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["snapshots"][0]["createdEpoch"] = time.time() - 8 * 24 * 60 * 60
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        self.store.snapshot("Prune.md", "new", force=True)
        self.assertEqual(len(self.store.history("Prune.md")["versions"]), 1)
        self.assertFalse((bucket / item["file"]).exists())

    def test_external_delete_with_active_editor_content_recreates_note(self):
        self.store.create("", "Recreate", "note", content="one")
        loaded = self.store.load("Recreate.md")
        (self.root / "Recreate.md").unlink()
        saved = self.store.save("Recreate.md", "local typing", loaded["revision"])
        self.assertTrue(saved["revision"].startswith("sha256:"))
        self.assertEqual(self.store.load("Recreate.md")["content"], "local typing")

    def test_staged_external_import_keeps_structure_and_numbers_collisions(self):
        token = self.store.begin_import("")["token"]
        self.store.upload_import_file(token, "course/A.md", "# A".encode("utf-8"))
        self.store.upload_import_file(token, "course/image.png", b"\x89PNG\r\n\x1a\n" + b"x" * 20, "image/png")
        imported = self.store.commit_import(token)
        self.assertIn("course/A.md", imported["notes"])
        self.assertTrue((self.root / "course" / "image.png").is_file())
        second = self.store.begin_import("")["token"]
        self.store.upload_import_file(second, "course/A.md", b"second")
        result = self.store.commit_import(second)
        self.assertEqual(result["items"], ["course-2"])

    def test_staged_import_enforces_total_scope_and_can_abort(self):
        token = self.store.begin_import("")["token"]
        with mock.patch.object(notes_library, "MAX_NOTE_IMPORT_BYTES", 3):
            with self.assertRaises(NotesError) as caught:
                self.store.upload_import_file(token, "A.md", b"four")
        self.assertEqual(caught.exception.code, "import_too_large")
        self.store.abort_import(token)
        self.assertFalse(any(path.name.startswith(".relatum-import-") for path in self.root.iterdir()))


if __name__ == "__main__":
    unittest.main()
