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

    def test_cleanup_unused_images_preserves_live_shared_and_nonimage_files(self):
        png, asset, _, _, _, _, _ = self.image_text_fixture()
        folder = (self.root / asset).parent
        unused = folder / 'unused.png'
        unused.write_bytes(png)
        shared = folder / 'shared.png'
        shared.write_bytes(png)
        (folder / 'document.pdf').write_bytes(b'keep')
        self.store.create('', 'Other', 'note', content='![](Image.assets/images/shared.png)')
        before = (self.root / 'Image.md').read_bytes()
        history = self.store.history('Image.md')
        result = self.store.cleanup_unused_images('Image.md', self.store.load('Image.md')['revision'])
        self.assertEqual(result['deletedCount'], 1)
        self.assertEqual(result['deletedBytes'], len(png))
        self.assertEqual(result['failedCount'], 0)
        self.assertFalse(unused.exists())
        self.assertTrue(shared.exists())
        self.assertTrue((self.root / asset).exists())
        self.assertTrue((folder / 'document.pdf').exists())
        self.assertEqual((self.root / 'Image.md').read_bytes(), before)
        self.assertEqual(self.store.history('Image.md'), history)
        self.assertEqual(self.store.cleanup_unused_images('Image.md', self.store.load('Image.md')['revision'])['deletedCount'], 0)

    def test_cleanup_unused_images_understands_markdown_paths_and_nested_assets(self):
        self.store.create('', 'A', 'note')
        folder = self.root / 'A.assets' / 'nested'
        folder.mkdir(parents=True)
        names = ['空 格.png', 'diagram(2).png', 'escaped(3).png', 'wiki.png', 'link.png', 'ref.png', 'code.png', 'comment.png']
        for name in names:
            (folder / name).write_bytes(b'image')
        content = '\n'.join([
            '![a](<A.assets/nested/空 格.png> "title")',
            'inline ![a](A.assets/nested/diagram(2).png) text',
            '![a](A.assets/nested/escaped\\(3\\).png)',
            '![[A.assets/nested/wiki.png|200]]', '[download](A.assets/nested/link.png)',
            '![ref][picture]', '[picture]: A.assets/nested/ref.png',
            '```md', '![](A.assets/nested/code.png)', '```',
            '<!-- ![](A.assets/nested/comment.png) -->',
        ])
        self.store.save('A.md', content, self.store.load('A.md')['revision'])
        result = self.store.cleanup_unused_images('A.md', self.store.load('A.md')['revision'])
        self.assertEqual(result['deletedCount'], 2)
        self.assertEqual({p.name for p in folder.iterdir()}, set(names[:-2]))

    def test_cleanup_unused_images_empty_folder_revision_and_path_guards(self):
        self.store.create('', 'A', 'note')
        revision = self.store.load('A.md')['revision']
        self.assertEqual(self.store.cleanup_unused_images('A.md', revision)['deletedCount'], 0)
        with self.assertRaises(NotesError):
            self.store.cleanup_unused_images('A.md', 'stale')
        with self.assertRaises(NotesError):
            self.store.cleanup_unused_images('../A.md', revision)
        folder = self.root / 'A.assets'
        folder.mkdir()
        (folder / 'a.png').write_bytes(b'image')
        original = notes_library._is_reparse
        with mock.patch('notes_library._is_reparse', side_effect=lambda path: path == folder or original(path)):
            with self.assertRaises(NotesError):
                self.store.cleanup_unused_images('A.md', revision)
        self.assertTrue((folder / 'a.png').exists())

    def test_cleanup_unused_images_reports_partial_failure_and_retries(self):
        self.store.create('', 'A', 'note')
        folder = self.root / 'A.assets'
        folder.mkdir()
        for name in ['a.png', 'b.png']:
            (folder / name).write_bytes(b'image')
        original = Path.unlink
        def unlink(path, *args, **kwargs):
            if path.name == 'a.png':
                raise PermissionError('locked')
            return original(path, *args, **kwargs)
        revision = self.store.load('A.md')['revision']
        with mock.patch.object(Path, 'unlink', unlink):
            result = self.store.cleanup_unused_images('A.md', revision)
        self.assertEqual((result['deletedCount'], result['failedCount']), (1, 1))
        self.assertEqual(self.store.cleanup_unused_images('A.md', revision)['deletedCount'], 1)

    def image_text_fixture(self):
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=')
        self.store.create('', 'Image', 'note')
        asset = self.store.upload_image('Image.md', 'original.png', png, 'image/png')['path']
        def annotation(identifier):
            return notes_library._image_text_comment([{
                'id': identifier, 'text': '中文\nsecond line', 'x': .5, 'y': .5, 'size': 'md', 'color': 'white',
            }])
        selected = f'![原图|700](<{asset}> "title")' + annotation('selected')
        kept = f'![[{asset}|320]]' + annotation('keep')
        content = '\r\n'.join(['# 正文 😀', selected, kept, annotation('orphan'),
                                  '```md', f'![]({asset})' + annotation('code'), '```',
                                  '![](missing.png)' + annotation('missing'), '正文 <!--ordinary-->'])
        saved = self.store.save('Image.md', content, self.store.load('Image.md')['revision'])
        self.store.snapshot('Image.md', content, force=True)
        return png, asset, annotation, selected, kept, content, saved

    def test_image_text_cleanup_removes_selected_unused_and_history_without_backup(self):
        png, asset, annotation, selected, kept, content, saved = self.image_text_fixture()
        before = self.store.history('Image.md')['versions']
        result = self.store.image_text_operation('Image.md', content, saved['revision'], {'line': 2, 'source': selected})
        self.assertIn(kept, result['content'])
        for identifier in ('selected', 'orphan', 'code', 'missing'):
            self.assertNotIn(annotation(identifier), result['content'])
        self.assertIn('正文 <!--ordinary-->', result['content'])
        self.assertEqual((self.root / 'Image.md').read_bytes(), result['content'].encode('utf-8'))
        self.assertEqual((self.root / asset).read_bytes(), png)
        after = self.store.history('Image.md')['versions']
        self.assertEqual([v['id'] for v in before], [v['id'] for v in after])
        for version in after:
            historical = self.store.history_version('Image.md', version['id'])['content']
            for identifier in ('selected', 'orphan', 'code', 'missing'):
                self.assertNotIn(annotation(identifier), historical)
        # Repeating cleanup with a now-empty selected image is safe.
        clean_source = result['content'].splitlines()[1]
        repeated = self.store.image_text_operation('Image.md', result['content'], result['revision'], {'line': 2, 'source': clean_source})
        self.assertEqual(repeated, result)

    def test_image_text_merge_preserves_original_reference_width_title_and_other_occurrence(self):
        png, asset, annotation, selected, kept, content, saved = self.image_text_fixture()
        result = self.store.image_text_operation('Image.md', content, saved['revision'], {'line': 2, 'source': selected}, png)
        line = result['content'].splitlines()[1]
        self.assertTrue(line.startswith('![原图|700](<Image.assets/images/merged-'))
        self.assertTrue(line.endswith('> "title")'))
        self.assertIn(kept, result['content'])
        self.assertEqual((self.root / asset).read_bytes(), png)
        self.assertEqual(len(list((self.root / 'Image.assets/images').glob('*.png'))), 2)

    def test_image_text_rejects_stale_selection_revision_and_invalid_png_before_cleanup(self):
        png, asset, annotation, selected, kept, content, saved = self.image_text_fixture()
        for revision, selection, image in [
            ('stale', {'line': 2, 'source': selected}, None),
            (saved['revision'], {'line': 3, 'source': selected}, None),
            (saved['revision'], {'line': 2, 'source': selected}, b'not a PNG'),
        ]:
            with self.assertRaises(NotesError):
                self.store.image_text_operation('Image.md', content, revision, selection, image)
            self.assertEqual(self.store.load('Image.md')['content'], content)

    def test_image_text_history_failure_is_retryable_and_does_not_replace_current(self):
        png, asset, annotation, selected, kept, content, saved = self.image_text_fixture()
        with mock.patch.object(self.store, '_write_history_manifest', side_effect=OSError('disk full')):
            with self.assertRaises(NotesError) as caught:
                self.store.image_text_operation('Image.md', content, saved['revision'], {'line': 2, 'source': selected})
        self.assertEqual(caught.exception.code, 'history_cleanup_failed')
        self.assertEqual(self.store.load('Image.md')['content'], content)
        result = self.store.image_text_operation('Image.md', content, saved['revision'], {'line': 2, 'source': selected})
        self.assertNotIn(annotation('selected'), result['content'])

    def test_image_text_full_document_rendered_lines_exclude_html_source(self):
        png, asset, annotation, selected, kept, content, saved = self.image_text_fixture()
        result = self.store.image_text_operation('Image.md', content, saved['revision'],
                                                {'line': 2, 'source': selected}, rendered_lines=[2])
        self.assertNotIn(annotation('keep'), result['content'])

    def test_image_text_cleanup_without_selection_only_removes_unused_data(self):
        png, asset, annotation, selected, kept, content, saved = self.image_text_fixture()
        result = self.store.image_text_operation('Image.md', content, saved['revision'], None,
                                                rendered_lines=[2, 3, 8])
        self.assertIn(selected, result['content'])
        self.assertIn(kept, result['content'])
        for identifier in ('orphan', 'code', 'missing'):
            self.assertNotIn(annotation(identifier), result['content'])
        for version in self.store.history('Image.md')['versions']:
            historical = self.store.history_version('Image.md', version['id'])['content']
            for identifier in ('orphan', 'code', 'missing'):
                self.assertNotIn(annotation(identifier), historical)
        self.assertEqual((self.root / asset).read_bytes(), png)

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

    def test_multiline_write_preserves_bytes_and_revision(self):
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)):
                content = newline.join(["# 图片文字", "", "![图](A.assets/image.png)", "正文"])
                created = self.store.create("", "Multiline-" + str(len(newline)), "note", content=content)
                note_path = self.root / created["path"]
                self.assertEqual(note_path.read_bytes(), content.encode("utf-8"))
                loaded = self.store.load(created["path"])
                changed = content + newline + "abc"
                saved = self.store.save(created["path"], changed, loaded["revision"])
                self.assertEqual(note_path.read_bytes(), changed.encode("utf-8"))
                self.assertEqual(saved["revision"], self.store.load(created["path"])["revision"])
                before = note_path.stat().st_mtime_ns
                self.store.save(created["path"], changed, saved["revision"])
                self.assertEqual(note_path.stat().st_mtime_ns, before, "unchanged save must not rewrite the note")

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

    def test_note_move_between_folders_keeps_companion_image_resolvable(self):
        self.store.create("", "old", "folder")
        self.store.create("", "new", "folder")
        self.store.create("old", "Picture", "note")
        image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
        uploaded = self.store.upload_image("old/Picture.md", "diagram.png", image, "image/png")
        loaded = self.store.load("old/Picture.md")
        self.store.save(
            "old/Picture.md",
            f"![diagram]({uploaded['path']})",
            loaded["revision"],
        )

        moved = self.store.move("old/Picture.md", "new/Picture.md")

        self.assertEqual(moved["path"], "new/Picture.md")
        moved_note = self.store.load("new/Picture.md")
        self.assertIn(uploaded["path"], moved_note["content"])
        target, media_type = self.store.resolve_image("new/Picture.md", uploaded["path"])
        self.assertEqual(media_type, "image/png")
        self.assertEqual(target.read_bytes(), image)
        self.assertEqual(target.parent, self.root / "new" / "Picture.assets" / "images")
        self.assertFalse((self.root / "old" / "Picture.assets").exists())

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

    def test_external_delete_with_active_editor_content_stays_deleted(self):
        self.store.create("", "Deleted", "note", content="one")
        loaded = self.store.load("Deleted.md")
        (self.root / "Deleted.md").unlink()
        with self.assertRaises(NotesError) as caught:
            self.store.save("Deleted.md", "local typing", loaded["revision"])
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "not_found")
        self.assertFalse((self.root / "Deleted.md").exists())

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
