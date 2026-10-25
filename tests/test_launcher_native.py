"""WinForms layout/selection and real kernel-instance probe on Windows."""
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import launcher
from feature_profile import PROFILE_FILENAME, LaunchProfile, read_preferences, save_preferences, save_launcher_settings, FEATURES
from desktop_instance import DesktopInstanceCoordinator, desktop_instance_running
from desktop_preferences import DesktopPreferences


class LauncherTextTests(unittest.TestCase):
    def test_feature_rows_keep_subtrees_together(self):
        rows = list(launcher.feature_rows())
        ids = [item['id'] for item, _ in rows]
        self.assertEqual(set(ids), set(FEATURES))
        self.assertEqual(len(ids), len(set(ids)))
        start = ids.index('daily')
        self.assertEqual(ids[start:start + 6], ['daily', 'daily.tasks', 'daily.calendar', 'daily.calendar.wallpaper', 'daily.focus', 'daily.ledger'])
        self.assertEqual([depth for _, depth in rows[start:start + 6]], [0, 1, 1, 2, 1, 1])
        for item, depth in rows:
            parent = item.get('parent')
            if parent:
                self.assertLess(ids.index(parent), ids.index(item['id']))
                self.assertEqual(depth, next(value for entry, value in rows if entry['id'] == parent) + 1)

    def test_feature_and_message_translations(self):
        from desktop_instance import conflict_message
        self.assertEqual(set(launcher.FEATURE_TEXT_EN), set(FEATURES))
        for label, description in launcher.FEATURE_TEXT_EN.values():
            self.assertTrue(label and description)
            self.assertFalse(any('\u4e00' <= char <= '\u9fff' for char in label + description))
        message = conflict_message(('notes', 'research'))
        self.assertEqual(launcher.launcher_text(message, 'zh-CN'), message)
        translated = launcher.launcher_text(message, 'en')
        self.assertIn('Notes workspace, Research workspace', translated)
        self.assertNotIn('已在运行', translated)
        self.assertEqual(launcher.launcher_text('user-file.canvas', 'en'), 'user-file.canvas')


@unittest.skipUnless(sys.platform == "win32", "Windows native launcher")
class NativeLauncherTests(unittest.TestCase):
    def test_native_form_language_and_layout(self):
        import clr
        clr.AddReference('System.Windows.Forms')
        clr.AddReference('System.Drawing')
        from System.Threading import Thread, ThreadStart, ApartmentState
        from System.Drawing import Bitmap, Rectangle
        from System.Drawing.Imaging import ImageFormat
        from System.Windows.Forms import Application, TextRenderer
        errors = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def check():
                try:
                    Application.EnableVisualStyles()
                    for language in ('en', 'zh-CN'):
                        preferences = DesktopPreferences(root, 'notes')
                        preferences.update({'canvas:toolbarLanguage': language}, language)
                        preferences.flush()
                        form = launcher.create_form(root)
                        try:
                            buttons, pick, detail, start, _ = form._relatum_controls
                            self.assertEqual(list(buttons), [item['id'] for item, _ in launcher.feature_rows()])
                            for item, depth in launcher.feature_rows():
                                self.assertEqual(buttons[item['id']].Margin.Left, depth * 20)
                            expected = launcher.FEATURE_TEXT_EN['notes.graph'][0] if language == 'en' else '笔记图谱'
                            self.assertEqual(buttons['notes.graph'].Text, expected)
                            self.assertEqual(start.Text, 'Start Relatum' if language == 'en' else '启动 Relatum')
                            self.assertEqual(pick.Text, 'Choose .canvas…' if language == 'en' else '选择 .canvas…')
                            form.Opacity = 0
                            form.Show()
                            Application.DoEvents()
                            buttons['notes.graph'].Focus()
                            self.assertIn('relationship graph' if language == 'en' else '笔记本关系图谱', detail.Text)
                            original = form.Size
                            for size_name, size in (('normal', original), ('minimum', form.MinimumSize)):
                                form.Size = size
                                Application.DoEvents()
                                for button in buttons.values():
                                    self.assertLessEqual(TextRenderer.MeasureText(button.Text, button.Font).Width + 18, button.Width, button.Text)
                                for button in (pick, start):
                                    self.assertLessEqual(TextRenderer.MeasureText(button.Text, button.Font).Width, button.Width - 8, button.Text)
                                self.assertLessEqual(start.Right, start.Parent.ClientSize.Width)
                                output = os.environ.get('RELATUM_LAUNCHER_PREVIEW_DIR')
                                if output:
                                    Path(output).mkdir(parents=True, exist_ok=True)
                                    bitmap = Bitmap(form.Width, form.Height)
                                    try:
                                        form.DrawToBitmap(bitmap, Rectangle(0, 0, form.Width, form.Height))
                                        bitmap.Save(str(Path(output) / f'launcher-{language}-{size_name}.png'), ImageFormat.Png)
                                    finally:
                                        bitmap.Dispose()
                        finally:
                            form.Close()
                            form.Dispose()
                except Exception as err:
                    errors.append(err)
            thread = Thread(ThreadStart(check))
            thread.SetApartmentState(ApartmentState.STA)
            thread.Start()
            thread.Join()
        if errors:
            raise errors[0]

    def test_direct_full_with_canvas_rejects_restricted_owner(self):
        import desktop
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canvas = root / 'sample.canvas'
            canvas.write_text('{"nodes":[],"edges":[]}', encoding='utf-8')
            primary = DesktopInstanceCoordinator(root, lambda _: {}, workspaces=('notes',))
            try:
                self.assertTrue(primary.acquire_or_forward(None)['primary'])
                with patch.object(desktop.app, 'ROOT', root), patch.object(sys, 'argv', ['Relatum.exe', str(canvas)]), patch.object(desktop, '_webview2_runtime_available', return_value=True), patch.object(desktop, '_message_box', return_value=1) as message, patch.object(desktop.app, 'bind_canvas_server') as server, patch.object(launcher, 'main') as chooser:
                    self.assertEqual(desktop.main(), 1)
                    self.assertIn('笔记工作区', message.call_args.args[0])
                    server.assert_not_called()
                    chooser.assert_not_called()
            finally:
                primary.close()

    def test_quick_main_rejects_existing_real_instance(self):
        import desktop
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = LaunchProfile({key: key == 'notes' for key in FEATURES}, restricted=True)
            save_preferences(root, profile)
            save_launcher_settings(root, True)
            original = (root / 'data' / PROFILE_FILENAME).read_bytes()
            commands = []
            primary = DesktopInstanceCoordinator(root, lambda command: commands.append(command) or {'ok': True})
            try:
                self.assertTrue(primary.acquire_or_forward(None)['primary'])
                launch = launcher.main
                with patch.object(launcher, 'launcher_root', return_value=root), patch.object(desktop.app, 'ROOT', root), patch.object(sys, 'argv', ['launcher.py']), patch.object(desktop, '_webview2_runtime_available', return_value=True), patch.object(launcher, 'main', return_value=9) as chooser, patch.object(launcher.subprocess, 'Popen') as spawn:
                    self.assertEqual(launch(), 9)
                    self.assertTrue(chooser.call_args.kwargs['initial_profile'].enabled('notes'))
                    self.assertIn('已在运行', chooser.call_args.kwargs['notice'])
                    spawn.assert_not_called()
                self.assertFalse(commands)
                self.assertEqual(original, (root / 'data' / PROFILE_FILENAME).read_bytes())
            finally:
                primary.close()

    def test_real_mutex_rejects_launcher_forwarding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = []
            primary = DesktopInstanceCoordinator(root, lambda command: commands.append(command) or {"ok": True})
            secondary = DesktopInstanceCoordinator(root, lambda _: {})
            try:
                self.assertFalse(desktop_instance_running(root))
                self.assertTrue(primary.acquire_or_forward(None)["primary"])
                self.assertTrue(desktop_instance_running(root))
                result = secondary.acquire_or_forward(None, allow_forward=False)
                self.assertEqual(result["status"], "workspace-conflict")
                self.assertFalse(commands)
            finally:
                secondary.close()
                primary.close()
            self.assertFalse(desktop_instance_running(root))

    def test_native_form_parent_memory_and_cancel(self):
        import clr
        clr.AddReference("System.Windows.Forms")
        clr.AddReference("System.Drawing")
        from System.Threading import ApartmentState, Thread, ThreadStart
        from System.Drawing import Bitmap, Rectangle
        from System.Drawing.Imaging import ImageFormat
        from System.Windows.Forms import Application
        errors = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def check():
                try:
                    Application.EnableVisualStyles()
                    form = launcher.create_form(root)
                    buttons, pick, detail, start, selected_file = form._relatum_controls
                    self.assertEqual(set(buttons), set(FEATURES))
                    self.assertTrue(buttons['runtime.preload'].Enabled)
                    self.assertTrue(all(button.Checked for button in buttons.values()))
                    self.assertEqual(buttons['notes.graph'].Text.strip(), '笔记图谱')
                    buttons['notes'].Checked = False
                    self.assertFalse(buttons['notes.graph'].Enabled)
                    self.assertTrue(buttons['notes.graph'].Checked)
                    buttons['notes'].Checked = True
                    self.assertTrue(buttons['notes.graph'].Enabled)
                    buttons['notes.graph'].Checked = False
                    self.assertTrue(buttons['editor.graph'].Checked)
                    self.assertTrue(buttons['canvas.activity'].Checked)
                    buttons['notes.graph'].Checked = True
                    buttons['canvas'].Checked = False
                    self.assertFalse(buttons['canvas.editor'].Enabled)
                    self.assertTrue(buttons['canvas.editor'].Checked)
                    self.assertFalse(pick.Enabled)
                    buttons['canvas'].Checked = True
                    self.assertTrue(buttons['canvas.editor'].Enabled)
                    self.assertTrue(buttons['editor.ai'].Checked)
                    original_size = form.Size
                    form.Size = form.MinimumSize
                    self.assertLessEqual(start.Right, start.Parent.ClientSize.Width)
                    form.Size = original_size
                    form.Opacity = 0
                    form.Show()
                    Application.DoEvents()
                    bitmap = Bitmap(form.Width, form.Height)
                    form.DrawToBitmap(bitmap, Rectangle(0, 0, form.Width, form.Height))
                    output = os.environ.get('RELATUM_LAUNCHER_PREVIEW')
                    if output:
                        bitmap.Save(output, ImageFormat.Png)
                    bitmap.Dispose()
                    form.Close()
                    form.Dispose()
                    self.assertFalse((root / 'data' / PROFILE_FILENAME).exists())
                    form = launcher.create_form(root)
                    form.Opacity = 0
                    form.Show()
                    Application.DoEvents()
                    buttons, _, _, start, _ = form._relatum_controls
                    for key, button in buttons.items():
                        button.Checked = key == 'notes'
                    with patch.object(launcher, 'workspace_conflicts', return_value=()), patch.object(launcher.subprocess, 'Popen') as spawn:
                        start.PerformClick()
                        self.assertEqual(spawn.call_count, 1)
                        command = spawn.call_args.args[0]
                        handoff = LaunchProfile.decode(command[command.index('--launch-profile') + 1])
                        self.assertTrue(handoff.enabled('notes'))
                        self.assertFalse(handoff.enabled('canvas.editor'))
                    self.assertFalse((root / 'data' / PROFILE_FILENAME).exists(), 'child saves only after admission')
                    form.Dispose()
                except Exception as err:
                    errors.append(err)
            thread = Thread(ThreadStart(check))
            thread.SetApartmentState(ApartmentState.STA)
            thread.Start()
            thread.Join()
        if errors:
            raise errors[0]


if __name__ == '__main__':
    unittest.main()
