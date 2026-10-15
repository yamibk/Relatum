"""Quick Notes page transactions; every write uses a temporary directory."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from feature_profile import FEATURES, LaunchProfile, render_html


class Capture:
    def _send_json(self, status, payload):
        self.status, self.payload = status, payload


class QuickNotesPagesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.patches = [patch.object(app, "NOTES_FILE", self.root / "notes.json"),
                        patch.object(app, "STUDY_ARCHIVE_DIR", self.root / "archives")]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def note(self, nid="a", page=1, text="文字", **extra):
        return {"id": nid, "notePage": page, "x": 10, "y": 20, "text": text, "color": "sage", **extra}

    def save(self, page, notes=None, edges=None, arrows=None):
        handler = Capture()
        app.Handler._api_notes_save(handler, {"notePage": page, "notes": notes or [],
                                             "edges": edges or [], "arrows": arrows or []})
        self.assertEqual(handler.status, 200, handler.payload)
        return handler.payload

    def test_legacy_read_assigns_first_page_without_writing(self):
        raw = {"version": 1, "notes": [self.note("a"), self.note("b")],
               "edges": [{"id": "e", "from": "a", "to": "b"}],
               "arrows": [{"id": "r", "x1": 1, "y1": 2, "toNote": "a"}]}
        for item in raw["notes"]:
            del item["notePage"]
        original = json.dumps(raw, ensure_ascii=False).encode("utf-8")
        app.NOTES_FILE.write_bytes(original)
        result = app.load_notes()
        self.assertEqual(result["version"], 2)
        self.assertTrue(all(item["notePage"] == 1 for key in ("notes", "edges", "arrows") for item in result[key]))
        self.assertEqual(app.NOTES_FILE.read_bytes(), original)

    def test_page_replacement_preserves_other_page_and_flat_inventory(self):
        self.save(1, [self.note("a", text="第一页")])
        self.save(2, [self.note("a", text="第二页", stack="same"), self.note("b", stack="same")],
                  [{"id": "e", "from": "a", "to": "b"}],
                  [{"id": "r", "x1": 1, "y1": 2, "toNote": "b"}])
        before = app.notes_page_payload(app.load_notes(), 2)
        self.save(1, [self.note("new")])
        after = app.notes_page_payload(app.load_notes(), 2)
        self.assertEqual(before, after)
        self.assertEqual(len(app.load_notes()["notes"]), 3)
        self.assertEqual(after["highestPage"], 2)
        self.assertTrue(all(item["notePage"] == 2 for key in ("notes", "edges", "arrows") for item in after[key]))

    def test_legacy_save_only_replaces_first_page(self):
        self.save(99, [self.note("keep")])
        handler = Capture()
        app.Handler._api_notes_save(handler, {"notes": [self.note("legacy")]})
        self.assertEqual(handler.status, 200)
        self.assertEqual([n["id"] for n in app.notes_page_payload(app.load_notes(), 99)["notes"]], ["keep"])

    def test_cross_page_connections_are_rejected_and_stack_ids_stay_scoped(self):
        raw = app._build_notes_payload(
            [self.note("a", 1, stack="pile"), self.note("b", 2, stack="pile")],
            [{"id": "bad", "from": "a", "to": "b", "notePage": 1}],
            [{"id": "bad", "fromNote": "a", "toNote": "b", "notePage": 2},
             {"id": "free", "x1": 0, "y1": 0, "x2": 1, "y2": 2, "notePage": 99}])
        self.assertEqual(raw["edges"], [])
        self.assertEqual([item["id"] for item in raw["arrows"]], ["free"])
        self.assertEqual(app.notes_page_payload(raw, 99)["highestPage"], 99)
        self.assertEqual(len(raw["notes"]), 2)

    def test_capacity_is_per_page(self):
        for page in (1, 2):
            self.save(page, [self.note(str(i)) for i in range(app.NOTES_MAX + 3)],
                      [{"id": "e" + str(i), "from": str(i % app.NOTES_MAX),
                        "to": str((i + 1 + i // app.NOTES_MAX) % app.NOTES_MAX)} for i in range(app.NOTE_EDGES_MAX + 3)],
                      [{"id": "r" + str(i), "x1": i, "y1": 0, "x2": i + 1, "y2": 2} for i in range(app.NOTE_ARROWS_MAX + 3)])
        result = app.load_notes()
        self.assertEqual(len(result["notes"]), app.NOTES_MAX * 2)
        self.assertEqual(len(app.notes_page_payload(result, 2)["notes"]), app.NOTES_MAX)
        self.assertEqual(len(result["edges"]), app.NOTE_EDGES_MAX * 2)
        self.assertEqual(len(result["arrows"]), app.NOTE_ARROWS_MAX * 2)

    def test_archive_uses_saved_current_page_and_retains_other_page(self):
        self.save(1, [self.note("keep")])
        self.save(2, [self.note("named", text="已提交文字"), self.note("blank", text="")],
                  arrows=[{"id": "free", "x1": 1, "y1": 2, "x2": 3, "y2": 4}])
        other = app.notes_page_payload(app.load_notes(), 1)
        handler = Capture()
        app.Handler._api_notes_archive(handler, {"notePage": 2, "notes": [self.note(text="过期客户端文字")]})
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload["count"], 1)
        marker = json.loads((app.STUDY_ARCHIVE_DIR / handler.payload["folder"] / "notes.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["notes"][0]["text"], "已提交文字")
        self.assertEqual(marker["notePage"], 2)
        for key in ("notes", "edges", "arrows"):
            self.assertEqual(app.notes_page_payload(app.load_notes(), 2)[key], [])
            self.assertEqual(app.notes_page_payload(app.load_notes(), 1)[key], other[key])

    def test_blank_and_free_arrow_page_clears_without_archive_folder(self):
        self.save(3, [self.note(text="")], arrows=[{"id": "r", "x1": 0, "y1": 0, "x2": 1, "y2": 1}])
        handler = Capture()
        app.Handler._api_notes_archive(handler, {"notePage": 3, "notes": []})
        self.assertEqual(handler.payload["count"], 0)
        self.assertIsNone(handler.payload["folder"])
        self.assertFalse(app.STUDY_ARCHIVE_DIR.exists())
        self.assertEqual(app.load_notes()["arrows"], [])

    def test_invalid_pages_never_write(self):
        self.save(2, [self.note("keep")])
        original = app.NOTES_FILE.read_bytes()
        for page in (0, 100, -1, True, 1.5, None, "invalid"):
            for method in (app.Handler._api_notes_save, app.Handler._api_notes_archive):
                handler = Capture()
                method(handler, {"notePage": page, "notes": []})
                self.assertEqual(handler.status, 400, page)
                self.assertEqual(app.NOTES_FILE.read_bytes(), original)

    def test_unreadable_or_corrupt_file_cannot_be_overwritten_by_empty_state(self):
        for content in (b"{broken", b"[]", b"\xff"):
            app.NOTES_FILE.write_bytes(content)
            handler = Capture()
            app.Handler._api_notes_save(handler, {"notes": []})
            self.assertEqual(handler.status, 500)
            self.assertEqual(app.NOTES_FILE.read_bytes(), content)

    def test_atomic_write_failure_keeps_all_pages(self):
        self.save(1, [self.note("a")])
        self.save(2, [self.note("b")])
        original = app.NOTES_FILE.read_bytes()
        with patch.object(app, "_atomic_write_json", side_effect=OSError("disk full")):
            handler = Capture()
            app.Handler._api_notes_save(handler, {"notePage": 1, "notes": []})
            self.assertEqual(handler.status, 500)
        self.assertEqual(app.NOTES_FILE.read_bytes(), original)

    def test_quicknotes_only_profile_keeps_palette_and_page_ui(self):
        profile = LaunchProfile({key: key in ("canvas", "canvas.quicknotes") for key in FEATURES}, restricted=True)
        html = render_html((app.ASSETS / "index.html").read_text(encoding="utf-8"), profile, "index.html")
        self.assertIn('src="study-palette.js"', html)
        self.assertIn('data-role="notes-page-rail"', html)
        self.assertNotIn('data-role="study-view"', html)
        disabled = LaunchProfile({"canvas.quicknotes": False}, restricted=True)
        html = render_html((app.ASSETS / "index.html").read_text(encoding="utf-8"), disabled, "index.html")
        self.assertNotIn('data-role="notes-page-rail"', html)


if __name__ == "__main__":
    unittest.main()
