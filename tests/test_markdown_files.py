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

    def test_unchanged_recent_list_and_preferences_do_not_write(self):
        import app
        manager = files.MarkdownFiles(self.root)
        manager.update('remember', str(self.path))
        with mock.patch.object(app, '_atomic_write_json', wraps=app._atomic_write_json) as write:
            manager.update('remember', str(self.path))
            manager.update('autoSave', True)
            manager.update('reset')
            write.assert_not_called()
            manager.update('outline', True)
            self.assertEqual(write.call_count, 1)


class MarkdownWindowStateTests(unittest.TestCase):
    class Timer:
        def __init__(self, delay, callback):
            self.delay, self.callback, self.cancelled = delay, callback, False
        def start(self): pass
        def cancel(self): self.cancelled = True

    def setUp(self):
        import markdown_window_state
        self.module = markdown_window_state
        self.temporary = tempfile.TemporaryDirectory(prefix='relatum-md-window-')
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'window-state.json'
        self.current = dict(version=1, x=30, y=60, width=1040, height=780, maximized=False)

    def session(self, timestamp):
        session = self.module.WindowState(self.path, lambda: self.current.copy() if self.current else None,
                                         clock=lambda: timestamp, timer=self.Timer)
        session.start()
        return session

    def test_start_unchanged_close_and_minimize_never_save(self):
        session = self.session(10)
        session.changed()
        self.current = None
        session.changed()
        session.stop()
        self.assertFalse(self.path.exists())

    def test_resize_debounce_close_and_maximize_keep_normal_size(self):
        session = self.session(10)
        self.current['width'] = 850
        session.changed()
        first = session.timer
        self.assertEqual(first.delay, .4)
        self.current.update(height=630, maximized=True)
        session.changed()
        self.assertTrue(first.cancelled)
        first.callback()  # A cancelled callback already queued cannot flush the new timer.
        self.assertFalse(self.path.exists())
        session.flush()
        saved = self.module.read_state(self.path)
        self.assertEqual((saved['width'], saved['height'], saved['maximized']), (850, 630, True))
        self.current = None
        session.changed()
        session.stop()
        self.assertEqual(self.module.read_state(self.path), saved)

    def test_reverse_close_order_does_not_overwrite_newer_adjustment(self):
        old = self.session(10)
        self.current['width'] = 800
        old.changed()
        newer = self.session(20)
        self.current['width'] = 900
        newer.changed()
        newer.stop()
        old.stop()
        self.assertEqual(self.module.read_state(self.path)['width'], 900)
        unchanged = self.session(30)
        unchanged.stop()
        self.assertEqual(self.module.read_state(self.path)['updatedNs'], 20)

    def test_write_failure_can_retry_without_blocking_document(self):
        import app
        session = self.session(10)
        self.current['height'] = 600
        session.changed()
        with mock.patch.object(app, '_atomic_write_json', side_effect=PermissionError('read-only')), \
             self.assertLogs(self.module.log, level='WARNING'):
            session.flush()
        self.assertIsNotNone(session.pending)
        session.stop()
        self.assertEqual(self.module.read_state(self.path)['height'], 600)

    def test_invalid_state_defaults_and_dpi_work_area_fitting(self):
        for value in ('broken', '[]', '{"version":2}', json.dumps({**self.current, 'updatedNs': 10, 'width': True})):
            self.path.write_text(value, encoding='utf-8')
            self.assertIsNone(self.module.read_state(self.path))
        saved = {**self.current, 'x': 5000, 'y': -3000, 'width': 900, 'height': 600}
        for scale in (1, 1.5, 2):
            x, y, width, height = self.module.fit_placement(saved, (0, 40, 1920, 1080), scale, (10, 20))
            self.assertEqual((width, height), (min(1920, round(900 * scale)), min(1040, round(600 * scale))))
            self.assertGreaterEqual(x, 0)
            self.assertGreaterEqual(y, 40)
            self.assertLessEqual(x + width, 1920)
            self.assertLessEqual(y + height, 1080)
        self.assertEqual(self.module.fit_placement(None, (0, 0, 3000, 2000), 1, (50, 60)), (50, 60, 1040, 780))
        self.assertEqual(self.module.fit_placement({**saved, 'width': 100, 'height': 100}, (0, 0, 1920, 1080), 1, (0, 0))[2:], (520, 400))

    def test_native_capture_converts_workspace_position_and_uses_actual_normal_rect(self):
        import desktop
        from ctypes import wintypes
        def placement(hwnd, output):
            output._obj.rcNormalPosition = wintypes.RECT(30, 20, 1380, 920)
            return 1
        user = types.SimpleNamespace(IsIconic=lambda hwnd: False, IsZoomed=lambda hwnd: True,
                                     GetWindowPlacement=placement)
        info = types.SimpleNamespace(work=wintypes.RECT(0, 60, 1920, 1080), monitor=wintypes.RECT(0, 0, 1920, 1080))
        shell = types.SimpleNamespace(_hwnd=lambda window: 123, _window_scale=lambda window: 1.5,
                                      _WINDOWPLACEMENT=desktop._WINDOWPLACEMENT)
        with mock.patch.object(self.module.ctypes, 'windll', types.SimpleNamespace(user32=user)), \
             mock.patch.object(self.module, '_monitor', return_value=(1, info)):
            value = self.module.capture_placement(shell, object())
            self.assertEqual((value['x'], value['y'], value['width'], value['height']), (30, 80, 900, 600))
            self.assertTrue(value['maximized'])
            user.IsIconic = lambda hwnd: True
            self.assertIsNone(self.module.capture_placement(shell, object()))


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
    def test_default_query_uses_the_supported_shell_api(self):
        import ctypes
        def answer(flags, kind, extension, verb, output, size):
            self.assertEqual((flags, kind, extension, verb), (0, 20, '.md', None))
            output.value = files.PROGID
            return 0
        query = mock.Mock(side_effect=answer)
        with mock.patch.object(ctypes, 'windll', types.SimpleNamespace(shlwapi=types.SimpleNamespace(AssocQueryStringW=query))), \
             mock.patch.object(files.sys, 'platform', 'win32'):
            self.assertEqual(files.default_markdown_progid(), files.PROGID)
            query.side_effect = lambda *args: -1
            self.assertIsNone(files.default_markdown_progid())

    def test_monochrome_icon_contains_all_windows_sizes_and_transparent_margins(self):
        from PIL import Image
        with Image.open(files.markdown_icon_path()) as icon:
            self.assertEqual(icon.ico.sizes(), {(size, size) for size in (16, 24, 32, 48, 64, 128, 256)})
            for size in icon.ico.sizes():
                frame = icon.ico.getimage(size).convert('RGBA')
                self.assertEqual(frame.getpixel((0, 0))[3], 0)
                self.assertTrue(all(r == g == b for r, g, b, _ in frame.get_flattened_data()))

    def test_native_appearance_is_per_window_and_handles_unsupported_attributes(self):
        import ctypes
        import markdown_desktop
        recorded = []
        setter = mock.Mock(side_effect=lambda hwnd, attr, value, length: recorded.append((hwnd, attr, value._obj.value, length)) or 0)
        shell = types.SimpleNamespace(_hwnd=lambda window: 123456)
        with mock.patch.object(ctypes, 'windll', types.SimpleNamespace(dwmapi=types.SimpleNamespace(DwmSetWindowAttribute=setter))), \
             mock.patch.object(files.sys, 'platform', 'win32'):
            self.assertTrue(markdown_desktop.set_window_appearance(shell, object(), True)['native'])
            self.assertEqual([item[:3] for item in recorded], [(123456, 20, 1), (123456, 35, 0), (123456, 36, 0xFFFFFF)])
            recorded.clear()
            self.assertTrue(markdown_desktop.set_window_appearance(shell, object(), False)['native'])
            self.assertEqual([item[:3] for item in recorded], [(123456, 20, 0), (123456, 35, 0xFFFFFF), (123456, 36, 0)])
            setter.side_effect = lambda *args: -1
            self.assertEqual(markdown_desktop.set_window_appearance(shell, object(), True), {'ok': True, 'native': False})
            self.assertFalse(markdown_desktop.set_window_appearance(shell, object(), 'dark')['ok'])

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
             mock.patch.object(files, 'launch_command', return_value=['D:\\My App\\Relatum.exe']), \
             mock.patch.object(files, 'default_markdown_progid', return_value=None), mock.patch.object(files, '_notify_associations'):
            self.assertFalse(files.association_status()['registered'])
            files.register_association()
            self.assertTrue(files.association_status()['registered'])
            self.assertTrue(files.association_status()['iconCurrent'])
            icon_key = r'Software\Classes\Relatum.Markdown\DefaultIcon'
            self.assertEqual(registry.keys[icon_key][''][0], files.association_icon())
            registry.keys[icon_key][''] = ('old Relatum.exe,0', 1)
            self.assertTrue(files.association_status()['registered'])
            self.assertFalse(files.association_status()['iconCurrent'])
            registry.keys[choice.name]['ProgId'] = (files.PROGID, 1)
            files.register_association()
            self.assertTrue(files.association_status()['default'])
            self.assertTrue(files.association_status()['iconCurrent'])
            self.assertEqual(registry.keys[choice.name]['ProgId'][0], files.PROGID)
            registry.keys[choice.name]['ProgId'] = ('Typora', 1)
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
