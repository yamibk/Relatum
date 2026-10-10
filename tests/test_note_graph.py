"""Notebook graphs use disposable libraries and never change Markdown files."""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import notes_library
from feature_profile import LaunchProfile
from note_graph import graph_edges, references
from notes_library import NotesError, NotesStore


class GraphReferenceTests(unittest.TestCase):
    def targets(self, source):
        return {(item['kind'], item['target']) for item in references(source)}

    def test_wiki_inline_and_reference_forms(self):
        source = '\n'.join([
            '[[Target#part|alias]] [[Target#part|alias]]',
            '[text](Target.md#part "title")',
            '[full][OTHER] [collapsed][] [Shortcut]',
            '[other]: folder/Other.md "definition title"',
            '[collapsed]: <a b.md>',
            '[shortcut]:',
            '  ../Shortcut.md',
            '[unused]: Unused.md',
            '[other]: Wrong.md',
        ])
        self.assertEqual(self.targets(source), {
            ('wiki', 'Target#part'), ('markdown', 'Target.md#part'),
            ('markdown', 'folder/Other.md'), ('markdown', 'a b.md'),
            ('markdown', '../Shortcut.md'),
        })

    def test_balanced_destinations_escape_entities_and_reference_labels(self):
        source = '\n'.join([
            r'[one](folder/a(2).md)', r'[two](a\(3\).md)',
            '[space](<a b.md> \'title\')', '[entity](R&amp;D.md)',
            r'[title](Other.md "a ( title")',
            '[angle](<angle(.md>)', '[angle-close](<angle).md>)',
            r'[escaped-title](Other.md "quote \" and ( title")',
            '[text][Mixed    Label]', '[mixed label]: %E4%B8%AD%E6%96%87.md',
            '[escaped-reference][escaped]', r'[escaped]: a\(4\).md',
        ])
        self.assertEqual(self.targets(source), {
            ('markdown', 'folder/a(2).md'), ('markdown', 'a(3).md'),
            ('markdown', 'a b.md'), ('markdown', 'R&D.md'),
            ('markdown', 'Other.md'), ('markdown', '%E4%B8%AD%E6%96%87.md'),
            ('markdown', 'a(4).md'), ('markdown', 'angle(.md'),
            ('markdown', 'angle).md'),
        })

    def test_all_protected_syntax_images_and_escaped_tokens(self):
        source = '\n'.join([
            '\ufeff---', 'link: [[Header]]', '---', '',
            '```md', '[[Fence]] [a](Fence.md)', '```',
            '> ~~~', '> [[QuotedCode]]', '> ~~~',
            '    [[Indented]] [a](Indented.md)',
            '`[[Code]]` ``[a](Code.md)``',
            '<!-- [[Comment]]', '[a](Comment.md) --> [[Visible]]',
            '%% [[Percent]] [a](Percent.md) %%',
            '$[[InlineMath]]$ \\( [a](InlineMath.md) \\)',
            '$$', '[[BlockMath]] [a](BlockMath.md)', '$$',
            '\\[', '[[BracketMath]]', '\\]',
            r'\[[Escaped]] \[escaped](Escaped.md)',
            '![[WikiImage]] ![image](Image.md) ![image][img]',
            '[img]: Image.md',
            '<script>', '[[Script]]', '</script>',
            '<div>', '[[Html]]', '</div>', '',
            '> [[Quote]]', '- [List](List.md)',
            '  continuation [continued](Continued.md)',
            '| [table](Table.md) | plain |', '| --- | --- |',
        ])
        self.assertEqual(self.targets(source), {
            ('wiki', 'Visible'), ('wiki', 'Quote'),
            ('markdown', 'List.md'), ('markdown', 'Continued.md'),
            ('markdown', 'Table.md'),
        })

    def test_unclosed_protected_blocks_and_malformed_tokens(self):
        for source in ('```\n[[Hidden]]', '<!-- [[Hidden]]', '%% [[Hidden]]', '$$\n[[Hidden]]', '\\[\n[[Hidden]]'):
            with self.subTest(source=source):
                self.assertEqual(references(source), [])
        self.assertEqual(self.targets('[[Valid]] [broken](bad(unbalanced.md)\n[ok](Okay.md)'), {
            ('wiki', 'Valid'), ('markdown', 'Okay.md'),
        })
        self.assertEqual(references('[x](A.md "unterminated)'), [])
        self.assertEqual(references('[x](<A.md)'), [])
        self.assertEqual(references('[' * 100000), [])

    def test_protected_marker_precedence_does_not_hide_later_real_links(self):
        source = '\n'.join([
            '<!--', '```', '--> [[First]]',
            '%%', '~~~', '%% [[Second]]',
            '$$', '```', '$$', '[[Third]]',
            '`<!--` and `$%%$`', '[[Fourth]]',
        ])
        self.assertEqual(self.targets(source), {('wiki', name) for name in ('First', 'Second', 'Third', 'Fourth')})

    def test_four_mib_unclosed_delimiters_have_bounded_runtime(self):
        # A generous ceiling catches the former repeated full-tail find/slice
        # behaviour (quadratic) while allowing slow Windows test hosts.
        size = 4 * 1024 * 1024
        samples = {
            'math-parens': '[' + '\\(' * ((size - 1) // 2),
            'math-brackets': '\\[' * (size // 2),
            'mixed-backticks': ('[' + ' '.join('`' * width for width in range(1, 2895))).ljust(size, '.'),
        }
        for name, source in samples.items():
            with self.subTest(name=name):
                started = time.perf_counter()
                self.assertEqual(references(source), [])
                self.assertLess(time.perf_counter() - started, 15, 'malformed delimiter scanning must not repeatedly rescan the remaining source')

    def test_four_mib_malformed_markdown_destinations_have_bounded_runtime(self):
        size = 4 * 1024 * 1024
        depth = (size - len('a.md "unterminated')) // 5
        samples = {
            # Every label used to rescan all remaining unclosed parentheses.
            'unclosed-destinations': '[x](' * (size // 4),
            # Closed outer parentheses are insufficient: the deepest target
            # has whitespace and an unclosed title. Reject invalid nested
            # destinations without revisiting the common tail for every link.
            'unclosed-title': '[x](' * depth + 'a.md "unterminated' + ')' * depth,
            'unclosed-angle-destinations': ('[x](<' * (size // 5)).ljust(size, '.'),
        }
        for name, source in samples.items():
            with self.subTest(name=name):
                started = time.perf_counter()
                self.assertEqual(references(source), [])
                self.assertLess(time.perf_counter() - started, 15, 'failed Markdown links must not repeatedly scan the remaining source')

    def test_normalised_filename_collisions_do_not_choose_a_target(self):
        for names in (('é.md', 'e\u0301.md'), ('Case.md', 'case.MD')):
            with self.subTest(names=names):
                documents = {
                    'Index.md': {'graphReferences': references(f'[[{names[0][:-3]}]] [exact]({names[0]}) [[Unique]]')},
                    names[0]: {'graphReferences': []},
                    names[1]: {'graphReferences': []},
                    'Unique.md': {'graphReferences': []},
                }
                self.assertEqual(graph_edges(documents, ''), [{'from': 'Index.md', 'to': 'Unique.md'}])
                documents = {'CustomNotebook/One/' + path: document for path, document in documents.items()}
                documents['CustomNotebook/One/Index.md']['graphReferences'].extend(
                    references(f'[[CustomNotebook/One/{names[0]}]]'))
                self.assertEqual(graph_edges(documents, 'CustomNotebook/One'), [{
                    'from': 'CustomNotebook/One/Index.md', 'to': 'CustomNotebook/One/Unique.md',
                }])


class NoteGraphTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = NotesStore(Path(temporary.name) / 'notes')
        self.store.ensure_root()

    def note(self, path, text=''):
        target = self.store.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        self.store.atomic_text(target, text)
        return target

    def edge_pairs(self, result):
        return {frozenset((edge['from'], edge['to'])) for edge in result['edges']}

    def test_notebook_roots_and_isolated_notes(self):
        self.note('A.md', '[[B]] [C](sub/C.md) [[CustomNotebook/Other/Foreign]]')
        self.note('B.md', '[[A]]')
        self.note('sub/C.md')
        self.note('孤立.MD')
        self.note('CustomNotebook/Other/Foreign.md', '[[A]]')
        self.note('CustomNotebook/Other/B.md')
        self.note('canvases/hidden.md')
        self.note('A.assets/hidden.md')
        self.note('.trash/hidden.md')
        result = self.store.graph('')
        self.assertEqual(result['root'], '')
        self.assertEqual({node['path'] for node in result['nodes']}, {'A.md', 'B.md', 'sub/C.md', '孤立.MD'})
        self.assertTrue(all(node['id'] == node['path'] for node in result['nodes']))
        self.assertEqual(next(node['title'] for node in result['nodes'] if node['path'] == '孤立.MD'), '孤立')
        self.assertEqual(self.edge_pairs(result), {frozenset(('A.md', 'B.md')), frozenset(('A.md', 'sub/C.md'))})
        other = self.store.graph('CustomNotebook/Other')
        self.assertEqual({node['path'] for node in other['nodes']}, {'CustomNotebook/Other/Foreign.md', 'CustomNotebook/Other/B.md'})
        self.assertEqual(other['edges'], [])

    def test_custom_relative_qualified_case_and_encoded_links(self):
        root = 'CustomNotebook/Physics'
        self.note(root + '/sub/Index.md', '\n'.join([
            '[[Topic]] [[sub/Deep]] [[CustomNotebook/Physics/Topic.md#part]]',
            '[topic](../topic.MD#heading) [encoded](../%E7%A9%BA%20%E6%A0%BC.md)',
            '[parentheses](../a(2).md) [qualified](../../Other/Topic.md)',
            '[[CustomNotebook/Other/Topic]] [[Missing]] [[Index]] [self](#anchor)',
            '[remote](https://example.org/Topic.md) [protocol](//server/Topic.md)',
            '[absolute](/Topic.md) [windows](C:/Topic.md)',
            '[unsafe](../../../../Topic.md) [asset](../thing.canvas)',
            '[query](../Topic.md?q=x#heading)',
        ]))
        for path in ('Topic.md', '空 格.md', 'a(2).md', 'sub/Deep.md'):
            self.note(root + '/' + path)
        self.note('CustomNotebook/Other/Topic.md')
        self.note('Topic.md')
        result = self.store.graph(root)
        expected = {frozenset((root + '/sub/Index.md', root + '/' + path))
                    for path in ('Topic.md', '空 格.md', 'a(2).md', 'sub/Deep.md')}
        self.assertEqual(self.edge_pairs(result), expected)

    def test_wiki_same_name_ambiguity_is_scoped_and_markdown_is_exact(self):
        root = 'CustomNotebook/One'
        self.note(root + '/Index.md', '[[Topic]] [exact](left/Topic.md) [[right/Topic]]')
        self.note(root + '/left/Topic.md')
        self.note(root + '/right/Topic.md')
        result = self.store.graph(root)
        self.assertEqual(len(result['edges']), 2)
        (self.store.root / (root + '/right/Topic.md')).unlink()
        first = self.store.graph(root)
        self.note('CustomNotebook/Two/Topic.md')
        self.note('CustomNotebook/Two/Unreadable.md', 'unchanged other notebook')
        with mock.patch.object(self.store, '_read_note_bytes', wraps=self.store._read_note_bytes) as reads:
            self.assertEqual(self.store.graph(root), first)
            reads.assert_not_called()
        self.assertEqual(len(first['edges']), 1)

    def test_graph_parsing_is_lazy_no_bodies_retained_or_unchanged_reads(self):
        self.note('Index.md', '[[Target]] [link](Target.md)')
        self.note('Target.md')
        with mock.patch('notes_library.graph_references', wraps=references) as parsed:
            self.store.links('Index.md')
            parsed.assert_not_called()
            first = self.store.graph('')
            self.assertEqual(parsed.call_count, 2)
            with mock.patch.object(self.store, '_read_note_bytes', side_effect=AssertionError('unexpected body read')), \
                    mock.patch('notes_library.graph_edges', side_effect=AssertionError('unexpected edge rebuild')):
                self.assertEqual(self.store.graph(''), first)
                self.assertEqual(self.store.graph('', first['signature']), {
                    'root': '', 'signature': first['signature'], 'unchanged': True,
                })
            self.assertEqual(parsed.call_count, 2)
        self.assertTrue(all(not {'text', 'raw', 'content'} & document.keys() for document in self.store._document_cache.values()))

    def test_changed_body_only_reparses_changed_note_and_topology_signature(self):
        self.note('Index.md', '[[Target]]')
        self.note('Target.md')
        first = self.store.graph('')
        with mock.patch('notes_library.graph_references', wraps=references) as parsed, \
                mock.patch.object(self.store, '_read_note_bytes', wraps=self.store._read_note_bytes) as reads:
            self.note('Index.md', 'new prose\n[[Target]] [again](Target.md#other) [[Index]]')
            second = self.store.graph('')
            self.assertEqual(reads.call_count, 1)
            self.assertEqual(parsed.call_count, 1)
        self.assertEqual(first['signature'], second['signature'])
        loaded = self.store.load('Index.md')
        with mock.patch('notes_library.graph_references', wraps=references) as parsed:
            self.store.save('Index.md', 'remove relationship', loaded['revision'])
            parsed.assert_not_called()
            third = self.store.graph('')
            self.assertEqual(parsed.call_count, 1)
        self.assertNotEqual(first['signature'], third['signature'])
        self.assertEqual(third['edges'], [])

    def test_scoped_cache_cleanup_does_not_evict_other_notebook(self):
        self.note('Default.md')
        self.note('CustomNotebook/One/A.md')
        self.note('CustomNotebook/Two/B.md')
        self.store.graph('')
        self.store.graph('CustomNotebook/One')
        self.store.graph('CustomNotebook/Two')
        (self.store.root / 'CustomNotebook/One/A.md').unlink()
        self.assertEqual(self.store.graph('CustomNotebook/One')['nodes'], [])
        self.assertNotIn('CustomNotebook/One/A.md', self.store._document_cache)
        self.assertIn('Default.md', self.store._document_cache)
        self.assertIn('CustomNotebook/Two/B.md', self.store._document_cache)
        self.store.invalidate()
        self.assertEqual(self.store._graph_cache, {})
        self.assertEqual(self.store._graph_cache_bytes, 0)

    def test_graph_cache_count_total_budget_and_oversized_responses(self):
        for index in range(26):
            root = 'CustomNotebook/Book-' + str(index)
            self.note(root + '/Note.md')
            self.store.graph(root)
        self.assertEqual(len(self.store._graph_cache), 24)
        self.assertLessEqual(self.store._graph_cache_bytes, notes_library.GRAPH_CACHE_BYTES)
        self.store.invalidate()
        with mock.patch('notes_library.GRAPH_CACHE_BYTES', 900):
            self.store.graph('CustomNotebook/Book-0')
            self.store.graph('CustomNotebook/Book-1')
            self.assertLessEqual(self.store._graph_cache_bytes, 900)
            self.assertEqual(len(self.store._graph_cache), 1)
        with mock.patch('notes_library.GRAPH_CACHE_BYTES', 1):
            result = self.store.graph('CustomNotebook/Book-2')
            self.assertEqual(len(result['nodes']), 1)
            self.assertNotIn('CustomNotebook/Book-2', self.store._graph_cache)

    def test_external_create_rename_delete_and_timestamp_only_changes(self):
        target = self.note('Index.md', '[[Target]]')
        before = self.store.graph('')
        with mock.patch('notes_library.graph_references', wraps=references) as parsed:
            metadata = target.stat()
            os.utime(target, ns=(metadata.st_atime_ns, metadata.st_mtime_ns + 1_000_000))
            self.assertEqual(self.store.graph('')['signature'], before['signature'])
            parsed.assert_not_called()
        target_note = self.note('Target.md')
        created = self.store.graph('')
        self.assertEqual(len(created['edges']), 1)
        target_note.rename(target_note.with_name('Renamed.md'))
        renamed = self.store.graph('')
        self.assertEqual(renamed['edges'], [])
        self.assertNotEqual(created['signature'], renamed['signature'])
        target.unlink()
        self.assertEqual(len(self.store.graph('')['nodes']), 1)

    def test_incomplete_reads_do_not_replace_previous_complete_snapshot(self):
        self.note('Good.md', '[[Other]]')
        self.note('Other.md')
        first = self.store.graph('')
        bad = self.note('Bad.md')
        bad.write_bytes(b'\xff')
        with self.assertRaises(NotesError) as caught:
            self.store.graph('')
        self.assertEqual(caught.exception.code, 'statistics_incomplete')
        self.assertEqual(self.store._graph_cache[''][1], first)
        bad.unlink()
        with mock.patch('notes_library.os.scandir', side_effect=PermissionError('locked directory')):
            with self.assertRaises(NotesError) as caught:
                self.store.graph('')
        self.assertEqual(caught.exception.code, 'statistics_incomplete')
        self.assertEqual(self.store.graph(''), first)

    def test_invalid_roots_reparse_sandbox_and_nonfollowing_scans(self):
        self.note('CustomNotebook/One/A.md')
        for root in ('CustomNotebook/Missing', 'CustomNotebook/One/A.md'):
            with self.subTest(root=root), self.assertRaises(NotesError) as caught:
                self.store.graph(root)
            # A document is not a selectable notebook root.
            self.assertIn(caught.exception.status, (400, 404))
        for root in ('../escape', 'ordinary-folder', 'CustomNotebook', 'CustomNotebook/One/sub', None, False):
            with self.subTest(root=root), self.assertRaises(NotesError):
                self.store.graph(root)
        original = notes_library._is_reparse
        with mock.patch('notes_library._is_reparse', side_effect=lambda path:
                        Path(path) == self.store.root / 'CustomNotebook/One' or original(path)):
            with self.assertRaises(NotesError) as caught:
                self.store.graph('CustomNotebook/One')
        self.assertEqual(caught.exception.code, 'unsafe_path')

    def test_feature_gate_follows_notes_without_embedded_canvas(self):
        profile = LaunchProfile({'notes': True}, restricted=True)
        self.assertTrue(profile.api_allowed('/api/note-graph'))
        disabled = LaunchProfile({'notes': False}, restricted=True)
        self.assertFalse(disabled.api_allowed('/api/note-graph'))

    def test_source_files_and_preferences_are_not_rewritten(self):
        target = self.note('Keep.md', '[[Missing]]\r\n[link](Missing.md)\r\n')
        raw = target.read_bytes()
        before = target.stat().st_mtime_ns
        self.store.graph('')
        self.assertEqual(target.read_bytes(), raw)
        self.assertEqual(target.stat().st_mtime_ns, before)
        self.assertFalse((self.store.root.parent / 'data').exists())


if __name__ == '__main__':
    unittest.main()
