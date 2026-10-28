"""Daily capability isolation and retry receipts; never opens real user files."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app
from feature_profile import FEATURES, LaunchProfile
from desktop_preferences import managed_key


class DailyWorkspaceTests(unittest.TestCase):
    def only(self, *ids):
        return LaunchProfile({key: key in ids for key in FEATURES}, restricted=True)

    def test_daily_without_canvas(self):
        profile = self.only("daily", "daily.tasks")
        self.assertTrue(profile.has_home)
        self.assertFalse(profile.canvas_home)
        self.assertEqual(profile.workspaces, ("daily",))
        self.assertTrue(profile.resource_allowed("daily-tasks.js"))
        self.assertFalse(profile.resource_allowed("calendar.js"))
        self.assertFalse(profile.resource_allowed("focus-service.js"))
        self.assertFalse(profile.resource_allowed("ledger.js"))
        self.assertTrue(profile.write_allowed("/api/daily-create"))
        self.assertFalse(profile.write_allowed("/api/ledger-entry-create"))

    def test_empty_daily_does_not_make_a_home(self):
        profile = self.only("daily")
        self.assertTrue(profile.enabled("daily"), "parent remains enabled so its children can be selected")
        self.assertFalse(profile.workspace_available("daily"))
        self.assertFalse(profile.has_home)
        self.assertEqual(profile.workspaces, ())

    def test_image_markup_is_independent_and_has_no_write_api(self):
        profile = self.only("daily", "daily.images")
        profile.validate()
        self.assertTrue(profile.has_home)
        self.assertEqual(profile.workspaces, ("daily",))
        for name in ("image-markup-core.js", "daily-images.js", "daily-images.css"):
            self.assertTrue(profile.resource_allowed(name))
            self.assertFalse(self.only("daily", "daily.tasks").resource_allowed(name))
        self.assertFalse(profile.resource_allowed("note-workspace.js"))
        self.assertFalse(profile.resource_allowed("canvas.js"))
        self.assertFalse(profile.write_allowed("/api/daily-create"))
        self.assertFalse(profile.write_allowed("/api/ledger-entry-create"))

    def test_focus_independent_from_tasks(self):
        profile = self.only("daily", "daily.focus")
        self.assertTrue(profile.resource_allowed("focus-service.js"))
        self.assertFalse(profile.api_allowed("/api/daily"))
        self.assertFalse(profile.write_allowed("/api/daily-add-minutes"))
        self.assertTrue(managed_key("daily:focusRuntime"))

    def test_focus_and_task_minutes_retry_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.multiple(app, FOCUS_FILE=root / "focus.json", DAILY_FILE=root / "daily.json", DAILY_BACKUP_FILE=root / "daily.backup.json"):
                session = {"id": "daily-stable-session", "mode": "countup", "durationSec": 120, "endedAt": "2026-10-25T10:00:00Z"}
                app.append_focus_session(session)
                focus = app.append_focus_session(session)
                self.assertEqual(len(focus["sessions"]), 1)
                daily = app.daily_create({"name": "读书"})
                task_id = daily["tasks"][0]["id"]
                request = {"id": task_id, "minutes": 2, "requestId": session["id"]}
                app.daily_add_minutes(request)
                payload = app.daily_add_minutes(request)
                self.assertEqual(payload["tasks"][0]["totalMinutes"], 2)
                self.assertNotIn("focusMinuteRequests", payload["tasks"][0])


if __name__ == "__main__":
    unittest.main()
