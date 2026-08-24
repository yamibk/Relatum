import ctypes
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import app
from notes_library import NotesStore


@unittest.skipUnless(app.sys.platform == "win32", "Windows Recycle Bin contract")
class NoteTrashTests(unittest.TestCase):
    def test_note_and_companion_are_sent_in_one_recycle_operation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "notes"
            store = NotesStore(root, recovery_root=Path(temporary) / "recovery")
            store.ensure_root()
            store.create("", "A", "note")
            store.upload_image(
                "A.md", "a.png", b"\x89PNG\r\n\x1a\n" + b"x" * 20, "image/png",
            )
            _, targets = store.trash_targets("A.md")
            calls = []

            class FakeOperation:
                argtypes = None
                restype = None

                def __call__(self, pointer):
                    operation = pointer._obj
                    calls.append((operation.wFunc, operation.pFrom, operation.fFlags))
                    operation.fAnyOperationsAborted = False
                    return 0

            fake_shell = SimpleNamespace(SHFileOperationW=FakeOperation())
            with mock.patch.object(ctypes, "windll", SimpleNamespace(shell32=fake_shell)):
                app._move_paths_to_recycle_bin(targets)

            self.assertEqual(len(calls), 1)
            self.assertEqual(len(targets), 2)
            self.assertEqual(calls[0][0], 3)
            self.assertEqual(calls[0][1], str(targets[0].resolve()))
            self.assertTrue((root / "A.md").is_file())
            self.assertTrue((root / "A.assets").is_dir())


if __name__ == "__main__":
    unittest.main()
