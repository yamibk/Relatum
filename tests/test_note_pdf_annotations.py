import json
import os
import tempfile
import unittest
import uuid
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import note_pdf_annotations as pdf
from notes_library import NotesError, NotesStore


class NotePdfAnnotationTests(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='relatum-note-annot-')))
        self.store = NotesStore(root / 'notes')
        self.addCleanup(self.store.close)
        self.store.create('', 'Main', 'note')
        self.source = b'%PDF-1.7\nSource'
        self.info = self.import_pdf('Report.pdf')
        self.target = self.store.resolve_pdf_embed('Main.md', self.info['id'])
        self.sidecar = self.target.with_name(pdf.FILENAME)

    def import_pdf(self, name):
        return self.store.import_pdf_embed('Main.md', name, BytesIO(self.source), self.store.load('Main.md')['revision'])

    @staticmethod
    def note():
        return {'id': str(uuid.uuid4()), 'page': 2, 'kind': 'note', 'color': '#f4b740',
                'point': [37, 412.5], 'text': '附注'}

    def save(self, marks, remove=None):
        snapshot = pdf.read(self.sidecar)
        version = pdf.asset_revision(self.target.stat())
        digest = pdf.fingerprint(self.target, version)
        pdf.check_binding(snapshot, digest)
        return pdf.save(self.sidecar, snapshot, digest,
                        {'revision': snapshot['revision'], 'upsert': marks, 'remove': remove or []}, self.store.atomic_bytes)

    def test_fingerprint_matches_streaming_stat_and_detects_replacement(self):
        mark = self.note()
        saved = self.save([mark])
        with self.target.open('rb') as stream:
            version = pdf.asset_revision(os.fstat(stream.fileno()))
        self.assertEqual(version, pdf.asset_revision(self.target.stat()))
        self.assertEqual(saved['pdfHash'], pdf.fingerprint(self.target, version))
        self.assertEqual(self.target.read_bytes(), self.source)
        replacement = self.target.with_suffix('.temp')
        replacement.write_bytes(b'%PDF-1.7\nChanged')
        os.replace(replacement, self.target)
        with self.assertRaises(NotesError) as conflict:
            pdf.fingerprint(self.target, version)
        self.assertEqual(conflict.exception.code, 'pdf_changed')
        with self.assertRaises(NotesError) as binding:
            self.save([])
        self.assertEqual(binding.exception.code, 'pdf_changed')
        self.assertEqual(pdf.read(self.sidecar)['annotations'], [mark])

    def test_delta_and_guarded_writes(self):
        first, second = self.note(), self.note()
        saved = self.save([first])
        snapshot = pdf.read(self.sidecar)
        self.save([second], [first['id']])
        current = pdf.read(self.sidecar)
        self.assertEqual(current['annotations'], [second])
        with self.assertRaises(NotesError) as conflict:
            pdf.save(self.sidecar, current, snapshot['pdfHash'],
                     {'revision': saved['revision'], 'upsert': [], 'remove': [second['id']]}, self.store.atomic_bytes)
        self.assertEqual(conflict.exception.code, 'annotation_conflict')
        with self.assertRaises(NotesError):
            self.save([{**second, 'point': [float('nan'), 0]}])
        self.assertEqual(pdf.read(self.sidecar), current)

    def test_write_can_be_replayed_until_another_write_commits(self):
        mark = self.note()
        digest = pdf.fingerprint(self.target, pdf.asset_revision(self.target.stat()))
        body = {'revision': None, 'upsert': [mark], 'remove': []}
        first = pdf.save(self.sidecar, pdf.read(self.sidecar), digest, body, self.store.atomic_bytes)
        with patch.object(self.store, 'atomic_bytes') as writer:
            replay = pdf.save(self.sidecar, pdf.read(self.sidecar), digest, body, writer)
            writer.assert_not_called()
        self.assertEqual(first, replay)
        self.save([self.note()])
        with self.assertRaises(NotesError) as conflict:
            pdf.save(self.sidecar, pdf.read(self.sidecar), digest, body, self.store.atomic_bytes)
        self.assertEqual(conflict.exception.code, 'annotation_conflict')

    def test_cleanup_protects_references_open_tabs_and_unknown_files(self):
        self.save([self.note()])
        linked = self.import_pdf('Linked.pdf')
        opened = self.import_pdf('Opened.pdf')
        extra = self.import_pdf('Extra.pdf')
        self.store.resolve_pdf_embed('Main.md', extra['id']).with_name('unmanaged.txt').touch()
        self.store.create('', 'Other', 'note')
        revision = self.store.load('Other.md')['revision']
        self.store.save('Other.md', f"[Reference](Main.assets/pdf/{linked['id']}/Linked.pdf)", revision)
        _, unused = pdf.unused(self.store, 'Main.md', {opened['id']})
        self.assertEqual(list(unused), [self.info['id']])
        self.assertTrue(unused[self.info['id']][3])
        revision = self.store.load('Main.md')['revision']
        self.store.save('Main.md', '\x60\x60\x60pdf-embed ' + self.info['id'], revision)
        self.assertEqual(pdf.unused(self.store, 'Main.md', {opened['id']})[1], {})

    def test_sidecar_retries_windows_sharing_violation(self):
        mark = self.note()
        digest = pdf.fingerprint(self.target, pdf.asset_revision(self.target.stat()))
        error = PermissionError('file temporarily in use')
        error.winerror = 32
        with patch.object(pdf.time, 'sleep') as sleep, patch.object(
                self.store, 'atomic_bytes', side_effect=[error, None]) as write:
            pdf.save(self.sidecar, pdf.read(self.sidecar), digest,
                     {'revision': None, 'upsert': [mark], 'remove': []}, self.store.atomic_bytes)
        self.assertEqual(write.call_count, 2)
        self.assertEqual(write.call_args_list[0], write.call_args_list[1])
        sleep.assert_called_once_with(0.02)

    def test_unrecognized_sidecar_is_preserved(self):
        self.sidecar.write_text(json.dumps({'version': 9}), encoding='utf-8')
        with self.assertRaises(NotesError) as error:
            pdf.read(self.sidecar)
        self.assertEqual(error.exception.code, 'annotation_unreadable')
        self.assertEqual(pdf.unused(self.store, 'Main.md', set())[1], {})
