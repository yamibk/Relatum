import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_preferences import DesktopPreferences, read_launcher_language
from feature_profile import LaunchProfile, FEATURES, FULL_PROFILE
import app


class DesktopPreferencesTests(unittest.TestCase):
    def test_launcher_language_changes_only_on_explicit_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            full = DesktopPreferences(root, 'full')
            notes = DesktopPreferences(root, 'notes')
            self.assertEqual(read_launcher_language(root), 'zh-CN')
            full.update({'canvas:toolbarLanguage': 'en'})  # legacy import
            full.flush()
            self.assertFalse((root / 'data/launcher-language.json').exists())
            full.update({'canvas:toolbarLanguage': 'en'}, 'en')  # same value, deliberate choice
            self.assertEqual(read_launcher_language(root), 'en')
            original = (root / 'data/launcher-language.json').read_bytes()
            notes.update({'canvas:toolbarLanguage': 'zh-CN'})
            notes.update({'canvas:startTheme': 'dark'})
            notes.flush()
            DesktopPreferences(root, 'notes').flush()
            self.assertEqual((root / 'data/launcher-language.json').read_bytes(), original)
            notes.update({'canvas:toolbarLanguage': 'zh-CN'}, 'zh-CN')
            notes.flush()
            full.flush()
            self.assertEqual(read_launcher_language(root), 'zh-CN')
            self.assertEqual(DesktopPreferences(root, 'full').values['canvas:toolbarLanguage'], 'en')

    def test_launcher_language_invalid_and_deleted_fall_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'data/launcher-language.json'
            target.parent.mkdir()
            for content in ('bad', '[]', 'null', '{"version":true,"language":"en"}',
                            '{"version":2,"language":"en"}', '{"version":1,"language":"fr"}',
                            '{"version":1}', '{"version":1,"language":[]}'):
                target.write_text(content, encoding='utf-8')
                self.assertEqual(read_launcher_language(root), 'zh-CN', content)
            target.write_bytes(b'\xff')
            self.assertEqual(read_launcher_language(root), 'zh-CN')
            preferences = DesktopPreferences(root, 'notes')
            for value in ('fr', 1, {}, []):
                with self.assertRaises(ValueError):
                    preferences.update({'canvas:toolbarLanguage': 'en'}, value)
            with patch('desktop_preferences._save_json', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    preferences.update({'canvas:toolbarLanguage': 'en'}, 'en')
            preferences.update({'canvas:toolbarLanguage': 'en'}, 'en')
            preferences.flush()
            self.assertEqual(read_launcher_language(root), 'en')
            self.assertFalse(list(target.parent.glob('*.tmp')))
            target.unlink()
            self.assertEqual(read_launcher_language(root), 'zh-CN')

    def test_effective_workspace_and_stable_combination(self):
        profile = LaunchProfile({key: key in ('canvas', 'notes') for key in FEATURES}, restricted=True)
        self.assertEqual(profile.workspaces, ('notes',))
        profile.choices['canvas.editor'] = True
        self.assertEqual(profile.workspaces, ('canvas', 'notes'))
        key = profile.session_key
        profile.choices['editor.ai'] = True
        self.assertEqual(profile.session_key, key)
        self.assertEqual(FULL_PROFILE.session_key, 'full')

    def test_isolation_merge_delete_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            notes = DesktopPreferences(root, 'notes')
            canvas = DesktopPreferences(root, 'canvas')
            notes.update({'canvas:startTheme': 'dark', 'canvas:noteFontScale:v1': '120'})
            notes.update({'research:panSpeed:v1': '80', 'canvas:noteFontScale:v1': None})
            notes.flush()
            restored = DesktopPreferences(root, 'notes')
            self.assertEqual(restored.values, {'canvas:startTheme': 'dark', 'research:panSpeed:v1': '80'})
            self.assertFalse(canvas.values)
            self.assertTrue(restored.initialized)
            self.assertFalse(list(notes.path.parent.glob('*.tmp')))

    def test_legacy_full_and_safe_bootstrap(self):
        with tempfile.TemporaryDirectory() as directory:
            preferences = DesktopPreferences(Path(directory), 'full')
            self.assertFalse(preferences.initialized)
            preferences.update({'canvas:startTheme': '</script><script>bad()</script>'})
            self.assertNotIn('</script><script>bad', preferences.bootstrap())
            preferences.flush()
            self.assertTrue(DesktopPreferences(Path(directory), 'full').initialized)

    def test_graph_preload_joins_existing_snapshot_in_full_and_notes_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            for session in ('full', 'notes'):
                preferences = DesktopPreferences(Path(directory), session)
                preferences.update({'canvas:noteGraphPreload:v1': '1', 'canvas:noteGraphSpacing:v1': '140'})
                preferences.flush()
                restored = DesktopPreferences(Path(directory), session)
                self.assertEqual(restored.values['canvas:noteGraphPreload:v1'], '1')
                self.assertIn('canvas:noteGraphPreload:v1', restored.bootstrap())

    def test_review_preferences_join_existing_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            value = json.dumps({'hideTextTips': False, 'autoRevealAnswer': True})
            preferences = DesktopPreferences(Path(directory), 'full')
            preferences.update({'canvas:reviewPreferences:v1': value})
            preferences.flush()
            restored = DesktopPreferences(Path(directory), 'full')
            self.assertEqual(restored.values['canvas:reviewPreferences:v1'], value)
            self.assertIn('canvas:reviewPreferences:v1', restored.bootstrap())

    def test_failed_write_retries_and_invalid_input_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            preferences = DesktopPreferences(Path(directory), 'notes')
            for delta in ({'../notes/file.md': 'body'}, {'canvas:x': 1}, {'canvas:x': 'x' * (512 * 1024 + 1)}):
                with self.assertRaises(ValueError):
                    preferences.update(delta)
            preferences.update({'canvas:startTheme': 'dark'})
            with patch('desktop_preferences._save_json', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    preferences.flush()
            self.assertTrue(preferences._dirty)
            preferences.flush()
            self.assertEqual(json.loads(preferences.path.read_text(encoding='utf-8'))['values']['canvas:startTheme'], 'dark')

    def test_real_bind_skips_occupied_socket(self):
        first = app.bind_canvas_server(0, 1)
        try:
            port = first.server_address[1]
            second = app.bind_canvas_server(port, 2)
            try:
                self.assertEqual(second.server_address[1], port + 1)
            finally:
                second.server_close()
        finally:
            first.server_close()

    def test_write_lock_failure_rejects_mutation(self):
        with patch('ctypes.windll.kernel32.CreateMutexW', return_value=0):
            with self.assertRaises(OSError):
                with app._cross_process_mutation_lock():
                    self.fail('unlocked mutation reached')


if __name__ == '__main__':
    unittest.main()
