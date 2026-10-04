import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_preferences import DesktopPreferences
from feature_profile import LaunchProfile, FEATURES, FULL_PROFILE
import app


class DesktopPreferencesTests(unittest.TestCase):
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
