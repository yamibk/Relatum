import os
import unittest
from pathlib import Path
from unittest import mock

import app


class RuntimePathTests(unittest.TestCase):
    def test_msix_uses_local_app_data(self):
        local_app_data = (Path.cwd() / "test-local-app-data").resolve()
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local_app_data)}, clear=False):
            self.assertEqual(
                app._resolve_user_root(packaged=True),
                local_app_data / "Relatum",
            )

    def test_explicit_root_override_wins(self):
        override = Path.cwd() / "custom-relatum-data"
        with mock.patch.dict(os.environ, {"RELATUM_DATA_ROOT": str(override)}, clear=False):
            self.assertEqual(app._resolve_user_root(packaged=True), override.resolve())

    def test_source_mode_keeps_repository_root(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RELATUM_DATA_ROOT", None)
            with mock.patch.object(app.sys, "frozen", False, create=True):
                self.assertEqual(app._resolve_user_root(packaged=False), app.SOURCE_ROOT)


if __name__ == "__main__":
    unittest.main()
