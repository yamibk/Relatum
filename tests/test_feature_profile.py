"""Launcher preferences, dependency and server boundaries; all data is temporary."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import feature_profile as features
from launcher import launch_command
import launcher


class FeatureProfileTests(unittest.TestCase):
    def only(self, *keys):
        return features.LaunchProfile({key: key in keys for key in features.FEATURES}, restricted=True)

    def test_parent_retains_child_and_direct_default_is_full(self):
        profile = features.LaunchProfile({"canvas": False}, restricted=True)
        self.assertTrue(profile.choices["canvas.editor"])
        self.assertFalse(profile.enabled("editor.ai"))
        self.assertFalse(profile.canvas_home)
        self.assertTrue(features.FULL_PROFILE.enabled("editor.ai"))

    def test_save_restore_corruption_and_new_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile, warning = features.read_preferences(root)
            self.assertFalse(warning)
            self.assertTrue(all(profile.choices.values()))
            profile.choices["canvas"] = False
            features.save_preferences(root, profile)
            restored, _ = features.read_preferences(root)
            self.assertFalse(restored.choices["canvas"])
            self.assertTrue(restored.choices["canvas.editor"])
            with patch.dict(features.FEATURES, {"future": {"id": "future"}}):
                restored, _ = features.read_preferences(root)
                self.assertTrue(restored.enabled("future"))
            config = root / "data" / features.PROFILE_FILENAME
            config.write_text("{broken", encoding="utf8")
            restored, warning = features.read_preferences(root)
            self.assertTrue(warning)
            self.assertTrue(all(restored.choices.values()))
            self.assertEqual(config.read_text(encoding="utf8"), "{broken")
            self.assertFalse(list(config.parent.glob("*.tmp")))

    def test_invalid_handoff_stops(self):
        for raw in ("bad", "[]", '{"version":2,"features":{}}', '{"version":true,"features":{}}', '{"version":1,"features":{"notes":"yes"}}'):
            with self.subTest(raw=raw), self.assertRaises(features.ProfileError):
                features.LaunchProfile.decode(raw)
        with self.assertRaises(features.ProfileError):
            features.LaunchProfile.decode(self.only().encode())

    def test_launcher_setting_and_quick_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(features.read_launcher_settings(root)["skipSelection"])
            profile = self.only("notes")
            features.save_preferences(root, profile)
            with patch.object(launcher.subprocess, "Popen") as spawn, patch.object(launcher, "desktop_instance_running", return_value=False):
                self.assertIsNone(launcher.quick_launch(root))
                features.save_launcher_settings(root, True)
                command = launcher.quick_launch(root)
                spawn.assert_not_called()
                handoff = features.LaunchProfile.decode(command[command.index(features.HANDOFF_ARGUMENT) + 1])
                self.assertTrue(handoff.enabled("notes"))
                self.assertFalse(handoff.enabled("canvas.editor"))
                features.save_launcher_settings(root, False)
                self.assertIsNone(launcher.quick_launch(root))
                features.save_launcher_settings(root, True)
                (root / "data" / features.PROFILE_FILENAME).write_text("bad", encoding="utf8")
                self.assertIsNone(launcher.quick_launch(root))
                spawn.assert_not_called()
            target = root / "data" / features.LAUNCHER_SETTINGS_FILENAME
            for raw in ("bad", "[]", '{"version":true,"skipSelection":true}', '{"version":1,"skipSelection":"yes"}'):
                target.write_text(raw, encoding="utf8")
                self.assertFalse(features.read_launcher_settings(root)["skipSelection"])
            self.assertFalse(list(target.parent.glob("*.tmp")))

    def test_editor_quick_launch_and_existing_instance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / "test.canvas"
            file.write_text('{"nodes":[],"edges":[]}', encoding="utf8")
            features.save_preferences(root, self.only("canvas", "canvas.editor"), str(file))
            features.save_launcher_settings(root, True)
            with patch.object(launcher.subprocess, "Popen") as spawn, patch.object(launcher, "desktop_instance_running", return_value=False):
                self.assertEqual(launcher.quick_launch(root)[-1], str(file.resolve()))
                file.unlink()
                self.assertIsNone(launcher.quick_launch(root))
                spawn.assert_not_called()
            features.save_preferences(root, self.only("notes"))
            with patch.object(launcher, "desktop_instance_running", return_value=True), patch.object(launcher.subprocess, "Popen") as spawn, patch("ctypes.windll.user32.MessageBoxW", return_value=1):
                self.assertTrue(features.LaunchProfile.decode(launcher.quick_launch(root)[1]).restricted)
                spawn.assert_not_called()

    def test_quick_main_enters_desktop_in_process(self):
        import desktop
        with tempfile.TemporaryDirectory() as directory, patch.object(launcher, "launcher_root", return_value=Path(directory)), patch.object(launcher.sys, "argv", ["launcher.py"]), patch.object(desktop, "main", return_value=7) as main, patch.object(launcher.subprocess, "Popen") as spawn:
            features.save_preferences(Path(directory), self.only("notes"))
            features.save_launcher_settings(Path(directory), True)
            self.assertEqual(launcher.main(), 7)
            self.assertTrue(features.LaunchProfile.decode(launcher.sys.argv[2]).restricted)
            main.assert_called_once_with()
            spawn.assert_not_called()

    def test_desktop_setting_persists_without_changing_features(self):
        import desktop
        with tempfile.TemporaryDirectory() as directory, patch.object(desktop.app, "ROOT", Path(directory)):
            root = Path(directory)
            features.save_preferences(root, self.only("notes"))
            original = (root / "data" / features.PROFILE_FILENAME).read_bytes()
            bridge = desktop.DesktopBridge()
            self.assertFalse(bridge.get_launcher_settings()["skipSelection"])
            self.assertTrue(bridge.set_launcher_skip_selection(True)["skipSelection"])
            self.assertTrue(desktop.DesktopBridge().get_launcher_settings()["skipSelection"])
            self.assertEqual(original, (root / "data" / features.PROFILE_FILENAME).read_bytes())
            with self.assertRaises(features.ProfileError):
                bridge.set_launcher_skip_selection("yes")
            self.assertFalse(bridge.set_launcher_skip_selection(False)["skipSelection"])

    def test_invalid_catalog_dependencies_stop(self):
        with self.assertRaises(features.ProfileError):
            features.validate_catalog({"version": 1, "features": [{"id": "a", "parent": "a"}]})
        with self.assertRaises(features.ProfileError):
            features.validate_catalog({"version": 1, "features": [{"id": "a", "requires": ["missing"]}]})

    def test_editor_only_requires_real_canvas(self):
        profile = self.only("canvas", "canvas.editor")
        self.assertFalse(profile.has_home)
        with self.assertRaises(features.ProfileError):
            launch_command(profile)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "a.canvas"
            file.write_text('{"nodes":[],"edges":[]}', encoding="utf8")
            command = launch_command(profile, str(file))
            self.assertEqual(command[-1], str(file.resolve()))
            self.assertIn(features.HANDOFF_ARGUMENT, command)
            with self.assertRaises(features.ProfileError):
                launch_command(self.only("notes"), str(file))
        self.assertFalse(profile.resource_allowed("index.html"))

    def test_html_omits_feature_dom_and_keeps_independent_activity(self):
        source = (features.RESOURCE_ROOT / "assets" / "index.html").read_text(encoding="utf8")
        profile = self.only("canvas", "canvas.activity")
        html = features.render_html(source, profile, "index.html")
        self.assertIn('src="study-activity.js"', html)
        self.assertNotIn('src="study.js"', html)
        self.assertIn('data-role="cadence-view"', html)
        self.assertNotIn('data-role="study-view"', html)
        self.assertNotIn('data-start-workspace-panel="notes"', html)
        self.assertFalse(profile.resource_allowed("research/research-workspace.js"))
        self.assertFalse(profile.resource_allowed("editor.html"))
        self.assertFalse(profile.api_allowed("/api/note"))
        self.assertTrue(profile.api_allowed("/api/study-activity"))
        self.assertFalse(profile.write_allowed("/api/study-task-update"))
        self.assertFalse(profile.write_allowed("/api/note-save"))

    def test_notes_only_uses_shared_shell(self):
        source = (features.RESOURCE_ROOT / "assets" / "index.html").read_text(encoding="utf8")
        html = features.render_html(source, self.only("notes"), "index.html")
        self.assertIn('src="start-shell.js"', html)
        self.assertNotIn('src="start.js"', html)
        self.assertNotIn('data-start-workspace-panel="canvas"', html)

    def test_tree_and_study_share_goal_tree_model(self):
        source = (features.RESOURCE_ROOT / "assets" / "index.html").read_text(encoding="utf8")
        for name, keys in (("tree", ("canvas", "canvas.tree")), ("study", ("canvas", "canvas.study")), ("neither", ("notes",))):
            with self.subTest(name=name):
                profile = self.only(*keys)
                html = features.render_html(source, profile, "index.html")
                model = 'src="study-goal-tree.js"'
                expected = name != "neither"
                self.assertEqual(profile.resource_allowed("study-goal-tree.js"), expected)
                self.assertEqual(model in html, expected)
                for resource in ("study.js", "study-route.js"):
                    self.assertEqual(profile.resource_allowed(resource), name == "study")
                    self.assertEqual(f'src="{resource}"' in html, name == "study")
                self.assertEqual('src="tree-page.js"' in html, name == "tree")
                if name == "tree":
                    self.assertLess(html.index(model), html.index('src="tree-page.js"'))
                    self.assertTrue(profile.api_allowed("/api/tree-page"))
                    self.assertTrue(profile.write_allowed("/api/tree-page-command"))
                    self.assertFalse(profile.write_allowed("/api/study-task-update"))
                elif name == "study":
                    self.assertLess(html.index(model), html.index('src="study-route.js"'))

    def test_full_launch_cannot_reuse_restricted_window(self):
        from desktop import DesktopActivationRouter
        router = DesktopActivationRouter(self.only("notes"))
        self.assertEqual(router.handle({"file": ""})["status"], "restricted-session")


if __name__ == "__main__":
    unittest.main()
