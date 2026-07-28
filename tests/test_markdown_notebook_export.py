import tempfile
import unittest
from pathlib import Path

import app


class MarkdownNotebookExportTests(unittest.TestCase):
    def test_notebook_notes_export_to_dedicated_folder_and_count_totals(self):
        payload = {
            "version": 2,
            "nodes": [
                {"id": "n1", "kind": "card", "text": "节点", "body": "正文"},
            ],
            "edges": [],
            "markdownNotebook": {
                "version": 1,
                "notes": [
                    {"id": "a", "title": "研究", "markdown": "# 研究\n\n- A"},
                    {"id": "b", "title": "研究", "markdown": "# 另一篇"},
                ],
            },
        }
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            output, count, node_count, note_count = app.export_markdown_bundle(
                destination / "示例.canvas", payload, destination
            )

            self.assertEqual((count, node_count, note_count), (3, 1, 2))
            self.assertEqual((output / "节点.md").read_text(encoding="utf-8"), "正文\n")
            self.assertEqual(
                (output / "笔记坞" / "研究.md").read_text(encoding="utf-8"),
                "# 研究\n\n- A\n",
            )
            self.assertTrue((output / "笔记坞" / "研究-2.md").is_file())

    def test_legacy_canvas_export_keeps_node_only_counts(self):
        payload = {
            "version": 2,
            "nodes": [{"id": "n1", "kind": "index", "text": "旧节点"}],
            "edges": [],
        }
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            output, count, node_count, note_count = app.export_markdown_bundle(
                destination / "旧.canvas", payload, destination
            )

            self.assertEqual((count, node_count, note_count), (1, 1, 0))
            self.assertFalse((output / "笔记坞").exists())


if __name__ == "__main__":
    unittest.main()
