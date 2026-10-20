"""Build system failure paths; all files and HTTP traffic are disposable/local."""
import contextlib
import ctypes
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('desktop_build', ROOT / 'scripts/desktop_build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
SHELL = Path(os.environ.get('SystemRoot', '')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'


class DesktopBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='relatum-build-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def release(self, name):
        root = self.root / name
        for relative in ['Relatum.exe', 'RelatumLauncher.exe', 'Relatum.exe.config', 'RelatumLauncher.exe.config',
                         '_internal/assets/app-icon.ico', '_internal/assets/launcher-icon.ico', '_internal/assets/feature-catalog.json']:
            file = root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(name.encode())
        return root

    def test_lock_is_complete_and_fixed(self):
        lock, fingerprint = builder.load_lock()
        self.assertEqual(lock['runtime']['version'], '3.12.15')
        self.assertEqual(len(fingerprint), 64)
        packages = {item['name'].replace('_', '-').lower(): item for item in lock['packages']}
        self.assertEqual(len(packages), len(lock['packages']))
        for name in ['pywebview', 'pyinstaller', 'pystray', 'pillow', 'pythonnet', 'clr-loader', 'cffi', 'pip', 'setuptools', 'wheel']:
            self.assertIn(name, packages)
        for item in [lock['runtime'], *lock['packages']]:
            self.assertRegex(item['sha256'], r'^[0-9a-f]{64}$')
            self.assertTrue(item['url'].startswith('https://'))
            self.assertEqual(Path(item['filename']).name, item['filename'])

    def test_publish_switches_only_complete_release(self):
        staged, release = self.release('new'), self.release('old')
        builder.publish(staged, release)
        self.assertEqual((release / 'Relatum.exe').read_bytes(), b'new')
        self.assertFalse(list(self.root.glob('old.previous-*')))
        self.assertTrue((staged / 'Relatum.exe').exists())

    def test_partial_stage_leaves_old_release_unchanged(self):
        staged, release = self.release('new'), self.release('old')
        (staged / 'Relatum.exe.config').unlink()
        with self.assertRaisesRegex(RuntimeError, 'missing'):
            builder.publish(staged, release)
        self.assertEqual((release / 'Relatum.exe').read_bytes(), b'old')

    def test_user_data_is_refused_even_deeply_nested(self):
        staged, release = self.release('new'), self.release('old')
        data = release / 'subfolder/notes/真实笔记.md'
        data.parent.mkdir(parents=True)
        data.write_text('keep', encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'user data'):
            builder.publish(staged, release)
        self.assertEqual(data.read_text(encoding='utf-8'), 'keep')

    def test_explicit_force_preserves_user_data_in_backup(self):
        staged, release = self.release('new'), self.release('old')
        data = release / 'data/settings.json'
        data.parent.mkdir()
        data.write_text('keep')
        builder.publish(staged, release, force=True)
        backups = list(self.root.glob('old.previous-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / 'data/settings.json').read_text(), 'keep')

    def test_switch_failure_rolls_back_old_release(self):
        staged, release = self.release('new'), self.release('old')
        replace = os.replace

        def fail_install(source, target):
            if '.incoming-' in Path(source).name:
                raise PermissionError('synthetic destination lock')
            replace(source, target)

        with mock.patch.object(builder.os, 'replace', side_effect=fail_install):
            with self.assertRaisesRegex(PermissionError, 'destination lock'):
                builder.publish(staged, release)
        self.assertEqual((release / 'Relatum.exe').read_bytes(), b'old')
        self.assertFalse(list(self.root.glob('old.incoming-*')))

    @unittest.skipUnless(os.name == 'nt', 'Windows file sharing')
    def test_real_locked_destination_retains_old_release(self):
        staged, release = self.release('new'), self.release('old')
        create = ctypes.windll.kernel32.CreateFileW
        create.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p]
        create.restype = ctypes.c_void_p
        handle = create(str(release / 'Relatum.exe'), 0x80000000, 0, None, 3, 0, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
        try:
            with self.assertRaises(OSError):
                builder.publish(staged, release)
        finally:
            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(handle))
        self.assertEqual((release / 'Relatum.exe').read_bytes(), b'old')

    def test_copy_failure_retains_old_release(self):
        staged, release = self.release('new'), self.release('old')
        with mock.patch.object(builder.shutil, 'copytree', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                builder.publish(staged, release)
        self.assertEqual((release / 'Relatum.exe').read_bytes(), b'old')

    def test_blocked_rollback_keeps_backup_and_reports_its_location(self):
        staged, release = self.release('new'), self.release('old')
        replace = os.replace

        def block_switch_and_rollback(source, target):
            if Path(source) != release:
                raise PermissionError('synthetic switch/rollback lock')
            replace(source, target)

        with mock.patch.object(builder.os, 'replace', side_effect=block_switch_and_rollback):
            with self.assertRaisesRegex(RuntimeError, 'preserved at'):
                builder.publish(staged, release)
        backups = list(self.root.glob('old.previous-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / 'Relatum.exe').read_bytes(), b'old')

    def test_user_data_appearing_during_copy_is_preserved(self):
        staged, release = self.release('new'), self.release('old')
        copy = builder.shutil.copytree

        def copy_and_add_data(source, target, *args, **kwargs):
            result = copy(source, target, *args, **kwargs)
            if Path(source) == staged:
                (release / 'notes').mkdir(exist_ok=True)
                (release / 'notes/keep.md').write_text('keep')
            return result

        with mock.patch.object(builder.shutil, 'copytree', side_effect=copy_and_add_data):
            with self.assertRaisesRegex(RuntimeError, 'appeared'):
                builder.publish(staged, release)
        self.assertEqual((release / 'notes/keep.md').read_text(), 'keep')

    def test_path_escape_and_repository_output_are_rejected(self):
        for target in [self.root, self.root.parent, self.root / '..' / 'outside']:
            with self.assertRaises(RuntimeError):
                builder.safe_path(target, self.root)
        with self.assertRaises(RuntimeError):
            builder.validate_output(ROOT)

    def test_wrong_version_and_missing_packages_are_diagnostic(self):
        lock, _ = builder.load_lock()
        with mock.patch.object(builder.importlib.metadata, 'version', return_value='0'):
            with self.assertRaisesRegex(RuntimeError, 'expected.*found'):
                builder.verify_packages(lock)
        with mock.patch.object(builder.importlib.metadata, 'version', side_effect=builder.importlib.metadata.PackageNotFoundError):
            with self.assertRaisesRegex(RuntimeError, 'MISSING'):
                builder.verify_packages(lock)

    def test_failed_preparation_keeps_previous_record(self):
        pointer = builder.pointer_path(self.root)
        builder.atomic_json(pointer, {'fingerprint': builder.load_lock()[1], 'environment': 'envs/old'})
        before = pointer.read_bytes()
        with mock.patch.object(builder, 'download'), mock.patch.object(builder, 'run', side_effect=RuntimeError('interrupted')):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                builder.prepare(self.root, True)
        self.assertEqual(pointer.read_bytes(), before)

    def test_sqlite_failure_is_not_ignored(self):
        with mock.patch.object(builder, 'probe'), mock.patch.object(builder, 'run', side_effect=[None, RuntimeError('SQLite unsupported')]):
            with self.assertRaisesRegex(RuntimeError, 'SQLite unsupported'):
                builder.verify(self.root)

    def test_verified_cache_never_opens_network(self):
        package = {'sha256': hashlib.sha256(b'package').hexdigest(), 'url': 'https://invalid.example/package'}
        target = self.root / 'package.whl'
        target.write_bytes(b'package')
        with mock.patch.object(builder.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            builder.download(package, target, offline=True)
            target.write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'corrupt'):
                builder.download(package, target, offline=True)

    def test_network_failures_retry_finitely_and_leave_no_partial(self):
        package = {'sha256': '0' * 64, 'url': 'https://invalid.example/package'}
        with mock.patch.object(builder.urllib.request, 'urlopen', side_effect=TimeoutError('synthetic timeout')) as request:
            with self.assertRaises(TimeoutError):
                builder.download(package, self.root / 'package', timeout=.01, attempts=2)
        self.assertEqual(request.call_count, 2)
        self.assertFalse(list(self.root.glob('*.part')))

    def test_native_failure_and_timeout_are_reported(self):
        with self.assertRaisesRegex(RuntimeError, 'exit 7'):
            builder.run([builder.sys.executable, '-I', '-B', '-c', 'raise SystemExit(7)'], cwd=self.root)
        with self.assertRaisesRegex(RuntimeError, 'timed out'):
            builder.run([builder.sys.executable, '-I', '-B', '-c', 'import time; time.sleep(30)'], cwd=self.root, timeout=.3)

    def test_http_download_checks_hash_before_cache_commit(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'package')

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            package = {'sha256': hashlib.sha256(b'package').hexdigest(), 'url': 'http://127.0.0.1:%s/' % server.server_port}
            target = self.root / 'package'
            builder.download(package, target)
            self.assertEqual(target.read_bytes(), b'package')
            target.unlink()
            package['sha256'] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                builder.download(package, target, attempts=1)
            self.assertFalse(target.exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    @unittest.skipUnless(SHELL.is_file(), 'Windows PowerShell 5.1')
    def test_daily_entry_missing_environment_exits_without_installation(self):
        result = subprocess.run([SHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ROOT / 'build-desktop.ps1', '-BuildHome', self.root, '-CheckOnly'], capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'never install or download', result.stdout)
        self.assertFalse((self.root / 'envs').exists())

    @unittest.skipUnless(SHELL.is_file(), 'Windows PowerShell 5.1')
    def test_concurrent_entry_fails_before_environment_work(self):
        with (self.root / 'build.lock').open('wb'):
            result = subprocess.run([SHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ROOT / 'build-desktop.ps1', '-BuildHome', self.root, '-CheckOnly'], capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Another build', result.stdout)

    def test_bat_entries_are_ascii_and_have_no_environment_logic(self):
        names = ['构建Relatum-release.bat', '准备Relatum构建环境.bat', '离线修复Relatum构建环境.bat', '检查Relatum构建环境.bat', '打开Relatum构建日志.bat']
        for name in names:
            source = (ROOT / 'Relatum-维护工具' / name).read_bytes().decode('ascii')
            self.assertNotIn('for /f', source.lower())
            self.assertNotIn('pip install', source.lower())


if __name__ == '__main__':
    unittest.main()
