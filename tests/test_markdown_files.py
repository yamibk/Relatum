import base64
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import markdown_files as files


class MarkdownFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='relatum-md-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / '中文 空格.md'
        self.path.write_bytes(b'\xef\xbb\xbf# Title\r\n\r\nBody\r\n')

    def test_roundtrip_keeps_bom_and_crlf_and_detects_external_edits(self):
        document = files.MarkdownDocument(self.path)
        original = document.read()
        saved = document.save(original['content'] + '\n中文\n', original['revision'])
        raw = self.path.read_bytes()
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))
        self.assertNotIn(b'\r\r\n', raw)
        self.assertEqual(raw.count(b'\n'), raw.count(b'\r\n'))
        self.assertFalse(document.changed(saved['revision']))
        self.path.write_text('External', encoding='utf-8')
        with self.assertRaisesRegex(files.MarkdownFileError, '其他程序'):
            document.save('My draft', saved['revision'])
        self.assertEqual(self.path.read_text(), 'External')

    def test_delete_is_not_resurrected_and_failures_do_not_lose_document(self):
        document = files.MarkdownDocument(self.path)
        original = document.read()
        import app
        with mock.patch.object(app, '_atomic_write_bytes', side_effect=PermissionError('readonly')):
            with self.assertRaises(PermissionError):
                document.save('Draft', original['revision'])
        self.assertEqual(document.revision, original['revision'])
        self.path.unlink()
        with self.assertRaises(files.MarkdownFileError):
            document.save('Draft', original['revision'])
        self.assertFalse(self.path.exists())

    def test_empty_file_new_file_limits_and_relative_images(self):
        self.path.write_bytes(b'')
        document = files.MarkdownDocument(self.path)
        original = document.read()
        self.assertEqual(original['content'], '')
        with self.assertRaises(files.MarkdownFileError):
            document.save('x' * (files.MAX_NOTE_BYTES + 1), original['revision'])
        created = files.MarkdownDocument()
        target = self.root / '新建.md'
        created.save('# New\n', None, destination=target)
        self.assertEqual(target.read_bytes(), b'# New\n')
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20"/></svg>'
        image = document.upload_image('test.svg', base64.b64encode(svg).decode())
        self.assertEqual(document.image(image), (svg, 'image/svg+xml'))
        for bad in ('../secret.png', '/secret.png', 'file:///C:/secret.png', '%2e%2e/secret.png'):
            with self.assertRaises(files.MarkdownFileError):
                document.image(bad)
        with self.assertRaises(ValueError):
            document.upload_image('active.svg', base64.b64encode(b'<svg><script/></svg>').decode())
        self.assertFalse((self.root / 'CustomNotebook').exists())

    def test_preferences_recent_list_is_bounded_and_reset_does_not_delete_files(self):
        manager = files.MarkdownFiles(self.root)
        self.assertFalse(manager.state_path.exists())
        self.assertTrue(manager.read()['autoSave'])
        manager.update('autoSave', False)
        manager.update('outline', True)
        for index in range(23):
            path = self.root / (str(index) + '.md')
            path.write_text('body')
            manager.update('remember', str(path))
        manager.update('remember', str(self.path))
        self.assertEqual(len(manager.read()['recent']), 20)
        manager.update('reset')
        self.assertTrue(manager.read()['autoSave'])
        self.assertFalse(manager.read()['outline'])
        self.assertEqual(len(manager.read()['recent']), 20)
        manager.update('clear')
        self.assertTrue(self.path.exists())
        self.assertEqual(manager.read()['recent'], [])
        self.assertNotIn('content', json.dumps(manager.read()))


class FakeRegistry:
    HKEY_CURRENT_USER = 'USER'
    REG_SZ, REG_NONE, KEY_READ, KEY_WRITE, KEY_SET_VALUE = 1, 0, 1, 2, 2
    def __init__(self):
        self.keys = {}
    class Key:
        def __init__(self, name): self.name = name
        def __enter__(self): return self
        def __exit__(self, *args): pass
    def CreateKey(self, root, key):
        parts = key.split('\\')
        for end in range(1, len(parts) + 1): self.keys.setdefault('\\'.join(parts[:end]), {})
        return self.Key(key)
    def OpenKey(self, root, key, *args):
        if key not in self.keys: raise FileNotFoundError(key)
        return self.Key(key)
    def SetValueEx(self, key, name, reserved, kind, value): self.keys[key.name][name] = (value, kind)
    def QueryValueEx(self, key, name):
        try: return self.keys[key.name][name]
        except KeyError: raise FileNotFoundError(name)
    def children(self, key):
        prefix = key.name + '\\'
        return [name[len(prefix):] for name in self.keys if name.startswith(prefix) and '\\' not in name[len(prefix):]]
    def QueryInfoKey(self, key): return len(self.children(key)), len(self.keys[key.name]), 0
    def EnumKey(self, key, index): return self.children(key)[index]
    def DeleteKey(self, root, key): del self.keys[key]
    def DeleteValue(self, key, name):
        if name not in self.keys[key.name]: raise FileNotFoundError(name)
        del self.keys[key.name][name]


class AssociationTests(unittest.TestCase):
    def test_desktop_routes_markdown_without_claiming_a_workspace(self):
        import desktop
        with mock.patch('markdown_desktop.run', return_value=7) as run:
            with mock.patch.object(files.sys, 'argv', ['desktop.py', '文档.MD']):
                self.assertEqual(desktop.main(), 7)
                self.assertEqual(run.call_args.args[1], '文档.MD')
            with mock.patch.object(files.sys, 'argv', ['desktop.py', '--markdown-file']):
                self.assertEqual(desktop.main(), 7)
                self.assertIsNone(run.call_args.args[1])

    def test_register_repair_and_remove_only_own_entries_never_change_userchoice(self):
        registry = FakeRegistry()
        key = registry.CreateKey('USER', r'Software\Classes\.md\OpenWithProgids')
        registry.SetValueEx(key, 'OtherEditor', 0, 0, b'')
        choice = registry.CreateKey('USER', r'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice')
        registry.SetValueEx(choice, 'ProgId', 0, 1, 'Typora')
        with mock.patch.dict('sys.modules', winreg=registry), mock.patch.object(files.sys, 'platform', 'win32'), \
             mock.patch.object(files, 'launch_command', return_value=['D:\\My App\\Relatum.exe']), mock.patch.object(files, '_notify_associations'):
            self.assertFalse(files.association_status()['registered'])
            files.register_association()
            self.assertTrue(files.association_status()['registered'])
            self.assertFalse(files.association_status()['default'])
            self.assertEqual(files.association_command(), '"D:\\My App\\Relatum.exe" --markdown-file "%1"')
            command = r'Software\Classes\Relatum.Markdown\shell\open\command'
            registry.keys[command][''] = ('old location', 1)
            self.assertTrue(files.association_status()['otherLocation'])
            with self.assertRaises(files.MarkdownFileError): files.unregister_association()
            files.register_association()
            files.unregister_association()
            self.assertFalse(files.association_status()['registered'])
            self.assertIn('OtherEditor', registry.keys[key.name])
            self.assertEqual(registry.keys[choice.name]['ProgId'][0], 'Typora')


if __name__ == '__main__':
    unittest.main()
