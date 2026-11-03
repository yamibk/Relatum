"""Media Markdown uses existing persistence, search, links and attachment rules."""
import tempfile
import unittest
from pathlib import Path

from notes_library import NotesStore, _wiki_mentions


class NoteMediaBlockTests(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory(prefix='relatum-media-block-'))
        self.root = Path(self.directory) / 'notes'
        self.store = NotesStore(self.root, index_path=Path(self.directory) / 'data' / 'index.sqlite3')
        self.addCleanup(self.store.close)
        self.store.ensure_root()

    def write(self, name, text):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode('utf-8') if isinstance(text, str) else text)
        return target

    def test_save_search_offsets_and_wiki_links(self):
        source = '# 文档\n\n> [!media]\n> ![图|240](Media.assets/images/a.png)\n>\n> 😀 **图文独有说明**\n> [[另一篇]]\n'
        file = self.write('Media.md', source)
        self.write('另一篇.md', 'target')
        item = self.store.query({'mode': 'search', 'q': '图文独有说明'})['items'][0]
        start, end = item['sourceRange']
        self.assertEqual(source.encode('utf-16-le')[start * 2:end * 2].decode('utf-16-le'), '图文独有说明')
        self.assertIn('另一篇', [item['base'] for item in _wiki_mentions(source)])
        loaded = self.store.load('Media.md')
        changed = source.replace('独有说明', '新的说明')
        self.store.save('Media.md', changed, loaded['revision'])
        self.assertEqual(file.read_bytes(), changed.encode('utf-8'))
        self.assertEqual(self.store.load('Media.md')['content'], changed)

    def test_cleanup_retains_markdown_and_wiki_media_images(self):
        for name in ('a.png', 'b.png', 'unused.png'):
            self.write('Media.assets/images/' + name, b'image')
        source = '> [!media]\n> ![](Media.assets/images/a.png)\n>\n> first\n\n> [!media]\n> ![[Media.assets/images/b.png|120]]\n>\n> second'
        self.write('Media.md', source)
        self.store.cleanup_unused_images('Media.md', self.store.load('Media.md')['revision'])
        self.assertTrue((self.root / 'Media.assets/images/a.png').is_file())
        self.assertTrue((self.root / 'Media.assets/images/b.png').is_file())
        self.assertFalse((self.root / 'Media.assets/images/unused.png').exists())
        self.assertEqual((self.root / 'Media.md').read_text(encoding='utf-8'), source)

    def test_crlf_is_preserved_and_image_recycling_keeps_description(self):
        source = '> [!media]\r\n> ![图|120](image.png)\r\n>\r\n> 保留说明\r\n> 下一行'
        file = self.write('Media.md', source)
        image = self.write('image.png', b'image')
        loaded = self.store.load('Media.md')
        self.store.save('Media.md', source, loaded['revision'])
        self.assertEqual(file.read_bytes(), source.encode('utf-8'))
        result = self.store.trash_media('Media.md', self.store.load('Media.md')['revision'], 'image.png',
                                        lambda targets: [target.unlink() for target in targets], kind='image')
        self.assertIn('保留说明\r\n> 下一行', result['content'])
        self.assertFalse(image.exists())


if __name__ == '__main__':
    unittest.main()
