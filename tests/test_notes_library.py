import base64
import os
import stat
import subprocess
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import notes_library
from notes_library import NotesError, NotesStore


@contextmanager
def _tree_scan_fixture(original, folder, overrides, observed):
    with original(folder) as scan:
        entries = []
        for entry in scan:
            target = Path(folder) / entry.name
            read_stat = mock.Mock(wraps=entry.stat)
            if target in overrides:
                value = overrides[target]
                if isinstance(value, BaseException):
                    read_stat.side_effect = value
                else:
                    read_stat.return_value = value
            observed[target] = read_stat
            entries.append(SimpleNamespace(name=entry.name, stat=read_stat))
        yield entries


class NotesLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "notes"
        self.recovery = Path(self.temp.name) / "data" / "note-recovery"
        self.store = NotesStore(self.root)
        self.store.ensure_root()

    def tearDown(self):
        self.temp.cleanup()

    def test_link_index_does_not_retain_note_bodies(self):
        self.store.create('', 'Target', 'note', content='target')
        for index in range(16):
            self.store.create('', f'Large-{index}', 'note', content='plain text\n' * 24000 + '[[Target]]')
        self.assertEqual(len(self.store.links('Target.md')['backlinks']), 16)
        self.assertEqual(len(self.store._document_cache), 17)
        self.assertTrue(all('text' not in item and 'raw' not in item for item in self.store._document_cache.values()))
        with mock.patch.object(self.store, '_read_note_bytes', wraps=self.store._read_note_bytes) as reads:
            self.store.links('Target.md')
            self.assertEqual(reads.call_count, 1, 'unchanged link index must not reread every body')

    def test_unchanged_load_save_and_links_reuse_parsed_fields(self):
        self.store.create('', 'Target', 'note', content='target')
        content = '#study\n[[Target]]\nbody\n'
        self.store.create('', 'Cached', 'note', content=content)
        cached = self.store._document_cache['Cached.md']
        with mock.patch('notes_library._wiki_mentions', wraps=notes_library._wiki_mentions) as mentions, \
                mock.patch('notes_library.note_metadata', wraps=notes_library.note_metadata) as metadata, \
                mock.patch.object(self.store, '_decode_note', wraps=self.store._decode_note) as decode, \
                mock.patch('notes_library._revision', wraps=notes_library._revision) as revision, \
                mock.patch.object(self.store, 'atomic_text', wraps=self.store.atomic_text) as writes:
            first = self.store.load('Cached.md')
            self.assertEqual(self.store.load('Cached.md'), first)
            self.assertEqual(self.store.save('Cached.md', content, first['revision'])['revision'], first['revision'])
            self.assertEqual(self.store.links('Cached.md')['outgoing'][0]['path'], 'Target.md')
            self.assertEqual(mentions.call_count, 0)
            self.assertEqual(metadata.call_count, 0)
            self.assertEqual(decode.call_count, 2, 'each load decodes once; save and indexed links need no decode')
            self.assertEqual(revision.call_count, 4, 'each operation hashes the actual bytes once')
            writes.assert_not_called()
        for field in ('mentions', 'tags', 'excerpt'):
            self.assertIs(self.store._document_cache['Cached.md'][field], cached[field])

    def test_revision_reuse_refreshes_signatures_and_missing_metadata(self):
        self.store.create('', 'Cached', 'note', content='#study\n[[Target]]')
        self.store.tags()
        cached = self.store._document_cache['Cached.md']
        target = self.root / 'Cached.md'
        before = target.stat()
        os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns + 10_000_000))
        with mock.patch('notes_library._wiki_mentions', wraps=notes_library._wiki_mentions) as mentions, \
                mock.patch('notes_library.note_metadata', wraps=notes_library.note_metadata) as metadata, \
                mock.patch.object(self.store, '_decode_note', wraps=self.store._decode_note) as decode:
            self.store.tags()
            self.assertEqual(mentions.call_count, 0)
            self.assertEqual(metadata.call_count, 0)
            self.assertEqual(decode.call_count, 0)
            self.assertEqual(self.store._document_cache['Cached.md']['signature'][0], target.stat().st_mtime_ns)
            self.store._document_cache['Cached.md'].pop('excerpt')
            loaded = self.store.load('Cached.md')
            self.assertEqual(metadata.call_count, 1)
            self.assertEqual(mentions.call_count, 0)
            self.assertEqual(loaded['revision'], cached['revision'])
            self.store._document_cache['Cached.md'].pop('mentions')
            self.store.links('Cached.md')
            self.assertEqual(mentions.call_count, 1)
            self.assertEqual(metadata.call_count, 1, 'missing links do not invalidate existing metadata')

    def test_loaded_revision_detects_changed_bytes_with_unchanged_file_signature(self):
        self.store.create('', 'Cached', 'note', content='#old\n[[Old]]')
        target = self.root / 'Cached.md'
        before = target.stat()
        old_revision = self.store._document_cache['Cached.md']['revision']
        target.write_bytes(b'#new\n[[New]]')
        os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
        with mock.patch('notes_library._wiki_mentions', wraps=notes_library._wiki_mentions) as mentions, \
                mock.patch('notes_library.note_metadata', wraps=notes_library.note_metadata) as metadata:
            loaded = self.store.load('Cached.md')
            self.assertNotEqual(loaded['revision'], old_revision)
            self.assertEqual(mentions.call_count, 1)
            self.assertEqual(metadata.call_count, 1)
        indexed = self.store._document_cache['Cached.md']
        self.assertEqual(indexed['tags'], [{'key': 'new', 'label': 'new'}])
        self.assertEqual(indexed['mentions'][0]['base'], 'New')

    def test_link_fallback_only_parses_when_index_entry_is_missing(self):
        self.store.create('', 'Cached', 'note', content='[[Missing]]')
        with mock.patch.object(self.store, '_documents', return_value={}), \
                mock.patch('notes_library._wiki_mentions', wraps=notes_library._wiki_mentions) as mentions:
            self.assertEqual(self.store.links('Cached.md')['outgoing'][0]['state'], 'missing')
            self.assertEqual(mentions.call_count, 1)
        (self.root / 'Invalid.md').write_bytes(b'\xff')
        self.assertNotIn('Invalid.md', self.store._documents(metadata=True))

    def test_move_rejects_body_changed_after_indexing_before_writing(self):
        self.store.create('', 'Target', 'note', content='target')
        self.store.create('', 'Source', 'note', content='[[Target]] original')
        original = self.store._documents
        def indexed_then_changed():
            documents = original()
            (self.root / 'Source.md').write_text('external [[Target]] new', encoding='utf-8')
            return documents
        with mock.patch.object(self.store, '_documents', side_effect=indexed_then_changed):
            with self.assertRaises(NotesError) as caught:
                self.store.move('Target.md', 'Renamed.md')
        self.assertEqual(caught.exception.code, 'conflict')
        self.assertTrue((self.root / 'Target.md').exists())
        self.assertFalse((self.root / 'Renamed.md').exists())
        self.assertEqual((self.root / 'Source.md').read_text(encoding='utf-8'), 'external [[Target]] new')

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
        self.assertFalse(self.recovery.exists())
        result = self.store.cleanup_unused_images('Image.md', self.store.load('Image.md')['revision'])
        self.assertEqual(result['deletedCount'], 1)
        self.assertEqual(result['deletedBytes'], len(png))
        self.assertEqual(result['failedCount'], 0)
        self.assertFalse(unused.exists())
        self.assertTrue(shared.exists())
        self.assertTrue((self.root / asset).exists())
        self.assertTrue((folder / 'document.pdf').exists())
        self.assertEqual((self.root / 'Image.md').read_bytes(), before)
        self.assertFalse(self.recovery.exists())
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
        return png, asset, annotation, selected, kept, content, saved

    def test_image_text_cleanup_removes_selected_unused_without_backup(self):
        png, asset, annotation, selected, kept, content, saved = self.image_text_fixture()
        self.assertFalse(self.recovery.exists())
        result = self.store.image_text_operation('Image.md', content, saved['revision'], {'line': 2, 'source': selected})
        self.assertIn(kept, result['content'])
        for identifier in ('selected', 'orphan', 'code', 'missing'):
            self.assertNotIn(annotation(identifier), result['content'])
        self.assertIn('正文 <!--ordinary-->', result['content'])
        self.assertEqual((self.root / 'Image.md').read_bytes(), result['content'].encode('utf-8'))
        self.assertEqual((self.root / asset).read_bytes(), png)
        self.assertFalse(self.recovery.exists())
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

    def test_image_text_write_failure_is_retryable_and_does_not_replace_current(self):
        _, _, annotation, selected, _, content, saved = self.image_text_fixture()
        with mock.patch.object(self.store, 'atomic_text', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.store.image_text_operation('Image.md', content, saved['revision'], {'line': 2, 'source': selected})
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

    def test_tree_preserves_mixed_directory_order_and_metadata(self):
        for folder in ("课程10", "课程2", "Picture.assets", ".relatum-stage", ".trash"):
            (self.root / folder).mkdir()
            (self.root / folder / "Nested.md").write_text("nested", encoding="utf-8")
        for name in ("笔记10.md", "笔记2.MD", "ignore.txt", ".relatum-hidden.md"):
            (self.root / name).write_text("正文\nsecond line", encoding="utf-8")

        def note(relative):
            target = self.root / relative
            metadata = target.stat()
            return {"kind": "note", "name": target.stem, "fileName": target.name,
                    "path": relative, "modifiedNs": metadata.st_mtime_ns,
                    "createdNs": getattr(metadata, "st_birthtime_ns", metadata.st_ctime_ns),
                    "size": metadata.st_size}

        expected = {"version": 1, "entries": [
            {"kind": "folder", "name": folder, "path": folder,
             "children": [note(folder + "/Nested.md")]}
            for folder in ("课程2", "课程10")
        ] + [note("笔记2.MD"), note("笔记10.md")]}
        self.assertEqual(self.store.tree(), expected)

    def test_tree_reads_one_nonfollowing_stat_per_visible_entry(self):
        for index in range(20):
            (self.root / f"Note-{index}.md").write_text("note", encoding="utf-8")
        (self.root / "Hidden.assets").mkdir()
        (self.root / "Hidden.assets" / "Nested.md").write_text("hidden", encoding="utf-8")
        original = os.scandir
        observed = {}
        with mock.patch("notes_library.os.scandir", side_effect=lambda folder:
                        _tree_scan_fixture(original, folder, {}, observed)):
            self.assertEqual(len(self.store.tree()["entries"]), 20)
        for target, read_stat in observed.items():
            if target.name == "Hidden.assets":
                read_stat.assert_not_called()
            else:
                read_stat.assert_called_once_with(follow_symlinks=False)
        self.assertNotIn(self.root / "Hidden.assets" / "Nested.md", observed)

    def test_tree_skips_disappeared_or_unreadable_entry(self):
        for name in ("Live.md", "Gone.md", "Locked.md"):
            (self.root / name).write_text(name, encoding="utf-8")
        original = os.scandir
        observed = {}
        overrides = {self.root / "Gone.md": FileNotFoundError("removed during scan"),
                     self.root / "Locked.md": PermissionError("locked during scan")}
        with mock.patch("notes_library.os.scandir", side_effect=lambda folder:
                        _tree_scan_fixture(original, folder, overrides, observed)):
            self.assertEqual([entry["path"] for entry in self.store.tree()["entries"]], ["Live.md"])

    def test_tree_reports_directory_enumeration_failure(self):
        folder = self.root / "Folder"
        folder.mkdir()
        original = os.scandir
        for failing in (self.root, folder):
            with self.subTest(directory=failing):
                def scan(target):
                    if Path(target) == failing:
                        raise PermissionError("directory unavailable")
                    return original(target)
                with mock.patch("notes_library.os.scandir", side_effect=scan):
                    with self.assertRaises(NotesError) as caught:
                        self.store.tree()
                self.assertEqual(caught.exception.code, "read_failed")
                self.assertEqual(caught.exception.status, 500)

        @contextmanager
        def interrupted_scan(target):
            def entries():
                with original(target) as scan:
                    yield next(scan)
                raise OSError("enumeration interrupted")
            yield entries()
        with mock.patch("notes_library.os.scandir", side_effect=interrupted_scan):
            with self.assertRaises(NotesError) as caught:
                self.store.tree()
        self.assertEqual(caught.exception.code, "read_failed")

    def test_tree_rejects_symlink_and_windows_reparse_stat(self):
        (self.root / "Live.md").write_text("live", encoding="utf-8")
        (self.root / "FileLink.md").write_text("outside", encoding="utf-8")
        for folder in ("DirectoryLink", "Junction"):
            (self.root / folder).mkdir()
            (self.root / folder / "Outside.md").write_text("outside", encoding="utf-8")
        overrides = {
            self.root / "FileLink.md": SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0),
            self.root / "DirectoryLink": SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0),
            self.root / "Junction": SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400),
        }
        original = os.scandir
        observed = {}
        with mock.patch("notes_library.os.scandir", side_effect=lambda folder:
                        _tree_scan_fixture(original, folder, overrides, observed)):
            self.assertEqual([entry["path"] for entry in self.store.tree()["entries"]], ["Live.md"])
        self.assertFalse(any(target.name == "Outside.md" for target in observed))

    def test_tree_rechecks_directory_before_entering_it(self):
        folder = self.root / "ChangedFolder"
        folder.mkdir()
        (folder / "Outside.md").write_text("outside", encoding="utf-8")
        original = notes_library._is_reparse
        # The nonfollowing DirEntry stat still describes an ordinary directory,
        # but the fresh check sees its replacement before recursion begins.
        with mock.patch("notes_library._is_reparse", side_effect=lambda path:
                        Path(path) == folder or original(path)):
            with mock.patch("notes_library.os.scandir", wraps=os.scandir) as scans:
                self.assertEqual(self.store.tree()["entries"], [])
        scans.assert_called_once_with(self.root)

    def test_tree_excludes_real_file_and_directory_symlinks(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "Outside.md").write_text("outside", encoding="utf-8")
        try:
            (self.root / "FileLink.md").symlink_to(outside / "Outside.md")
            (self.root / "DirectoryLink").symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError) as err:
            self.skipTest(f"symlink creation unavailable: {err}")
        self.assertEqual(self.store.tree()["entries"], [])
        self.assertEqual((outside / "Outside.md").read_text(encoding="utf-8"), "outside")

    @unittest.skipUnless(os.name == "nt", "Windows junction only")
    def test_tree_excludes_real_windows_junction(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "Outside.md").write_text("outside", encoding="utf-8")
        junction = self.root / "Junction"
        created = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
                                 capture_output=True, check=False)
        if created.returncode:
            self.skipTest("junction creation unavailable")
        try:
            self.assertTrue(notes_library._is_reparse(junction))
            self.assertEqual(self.store.tree()["entries"], [])
            self.assertEqual((outside / "Outside.md").read_text(encoding="utf-8"), "outside")
        finally:
            junction.rmdir()

    def test_stale_revision_editor_wins_without_snapshot(self):
        self.store.create("", "A", "note", content="one")
        loaded = self.store.load("A.md")
        saved = self.store.save("A.md", "two", loaded["revision"])
        self.assertTrue(saved["revision"].startswith("sha256:"))
        overwritten = self.store.save("A.md", "three", loaded["revision"])
        self.assertEqual(self.store.load("A.md")["content"], "three")
        self.assertFalse(self.recovery.exists())
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
        self.assertFalse(self.recovery.exists())

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

    def test_note_link_target_resolves_files_inside_vault_only(self):
        self.store.create("folder", "Index", "note", create_parents=True)
        attachment = self.root / "shared.pdf"
        attachment.write_bytes(b"pdf")
        self.assertEqual(
            self.store.resolve_link_target("folder/Index.md", "../shared.pdf#page=2"),
            attachment,
        )
        with self.assertRaises(NotesError):
            self.store.resolve_link_target("folder/Index.md", "../../outside.pdf")
        with self.assertRaises(NotesError):
            self.store.resolve_link_target("folder/Index.md", "https://example.com/file.pdf")

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

    def test_custom_new_note_uses_unique_name_without_changing_exact_create_or_move(self):
        first = self.store.create_unique_note("", "Ideas")
        second = self.store.create_unique_note("", "Ideas.md")
        third = self.store.create_unique_note("", "Ideas")
        self.assertEqual([first["path"], second["path"], third["path"]],
                         ["Ideas.md", "Ideas-2.md", "Ideas-3.md"])
        with self.assertRaises(NotesError) as collision:
            self.store.create("", "ideas", "note")
        self.assertEqual(collision.exception.code, "exists")
        self.store.create("", "Other", "note")
        with self.assertRaises(NotesError) as collision:
            self.store.move("Other.md", "Ideas.md")
        self.assertEqual(collision.exception.code, "exists")
        for bad in ("", "../escape", "folder/name", "CON", "trailing."):
            with self.subTest(bad=bad), self.assertRaises(NotesError):
                self.store.create_unique_note("", bad)
        note = next(entry for entry in self.store.tree()["entries"] if entry["path"] == "Ideas.md")
        self.assertIsInstance(note["createdNs"], int)
        self.assertGreater(note["createdNs"], 0)

    def test_save_move_and_image_cleanup_do_not_create_recovery(self):
        _, _, _, selected, _, content, saved = self.image_text_fixture()
        self.store.image_text_operation('Image.md', content, saved['revision'], {'line': 2, 'source': selected})
        self.store.move('Image.md', 'Moved.md')
        self.store.tree()
        self.assertFalse(self.recovery.exists())

    def test_existing_recovery_files_are_not_accessed_or_changed(self):
        _, _, _, selected, _, content, saved = self.image_text_fixture()
        bucket = self.recovery / 'legacy'
        bucket.mkdir(parents=True)
        files = {bucket / 'old.md': b'legacy snapshot', bucket / 'manifest.json': b'legacy manifest'}
        for path, raw in files.items():
            path.write_bytes(raw)
        signatures = {path: path.stat().st_mtime_ns for path in files}
        self.store.save('Image.md', content + '\nlocal edit', 'stale')
        loaded = self.store.load('Image.md')
        self.store.image_text_operation('Image.md', loaded['content'], loaded['revision'], {'line': 2, 'source': selected})
        self.store.move('Image.md', 'Moved.md')
        self.store.tree()
        for path, raw in files.items():
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(path.stat().st_mtime_ns, signatures[path])
        self.assertEqual(set(bucket.iterdir()), set(files))

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
