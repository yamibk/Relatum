import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from research_library import ResearchError, ResearchStore


class ResearchLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "research"
        def atomic(path, text):
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=path.parent, delete=False) as file:
                file.write(text)
                name = file.name
            os.replace(name, path)
        self.store = ResearchStore(self.root, atomic_text=atomic)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, loaded, revision=1, request_id="request-1"):
        project = copy.deepcopy(loaded["project"])
        project["revision"] = revision
        return {"projectId": project["projectId"], "project": project, "requestId": request_id,
                "expectedRevision": loaded["project"]["revision"], "expectedFingerprint": loaded["fingerprint"]}

    def test_read_does_not_create_and_creation_is_explicit(self):
        self.assertEqual(self.store.projects(), {"projects": []})
        self.assertFalse(self.root.exists())
        with self.assertRaises(ResearchError): self.store.load("project-main")
        first = self.store.create()
        self.assertEqual(first, self.store.create())
        self.assertEqual(len(first["project"]["views"]), 2)

    def test_roundtrip_unknown_data_and_idempotent_retry(self):
        body = self.request(self.store.create())
        body["project"]["extension"] = {"future": [1, "中文\nλ"]}
        body["project"]["objects"].append({"id": "future-1", "type": "future.plugin", "typeVersion": 7, "payload": {"source": "<script>never execute</script>"}})
        saved = self.store.save(body)
        path = self.root / "project-main/project.json"
        stamp = path.stat().st_mtime_ns
        self.assertEqual(saved, self.store.save(body))
        self.assertEqual(stamp, path.stat().st_mtime_ns)
        self.assertEqual(body["project"], self.store.load("project-main")["project"])

    def test_conflicting_windows_keep_disk_and_recovery(self):
        loaded = self.store.create()
        body = self.request(loaded)
        self.store.save(body)
        disk = (self.root / "project-main/project.json").read_bytes()
        other = self.request(loaded, request_id="request-2")
        other["project"]["title"] = "other window"
        with self.assertRaises(ResearchError) as caught: self.store.save(other)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(disk, (self.root / "project-main/project.json").read_bytes())
        recovery = list((self.root / "project-main").glob("recovery-*.json"))
        self.assertEqual(len(recovery), 1)
        self.assertEqual(json.loads(recovery[0].read_text(encoding="utf-8"))["title"], "other window")

    def test_drafts_roundtrip_and_validation(self):
        loaded = self.store.create()
        body = self.request(loaded)
        source = '# 中文😀\r\n未完成 $x_\n<script>source only</script>'
        for kind in ('note', 'formula'):
            body['project']['objects'].append({'id': kind, 'type': 'core.' + kind,
                'typeVersion': 1, 'payload': {'label': '草稿', 'source': source}})
        self.store.save(body)
        self.assertEqual(self.store.load('project-main')['project']['objects'], body['project']['objects'])
        for invalid in (None, 1, 'x' * 100001, '😀' * 50001):
            request = self.request(self.store.load('project-main'), revision=2)
            request['project']['objects'][0]['payload']['source'] = invalid
            with self.assertRaises(ResearchError): self.store.save(request)
        self.assertEqual(self.store.load('project-main')['project']['objects'][0]['payload']['source'], source)

    def test_external_edit_same_revision_conflicts(self):
        loaded = self.store.create()
        path = self.root / "project-main/project.json"
        project = loaded["project"].copy(); project["title"] = "external"
        self.store.atomic_text(path, json.dumps(project))
        with self.assertRaises(ResearchError) as caught: self.store.save(self.request(loaded))
        self.assertEqual(caught.exception.code, "conflict")
        self.assertEqual(self.store.load("project-main")["project"]["title"], "external")

    def test_corruption_is_never_replaced_by_empty_project(self):
        loaded = self.store.create()
        path = self.root / "project-main/project.json"; path.write_bytes(b"{broken")
        for action in [self.store.create, lambda: self.store.save(self.request(loaded))]:
            with self.assertRaises(ResearchError): action()
        self.assertEqual(path.read_bytes(), b"{broken")

    def test_invalid_identity_references_and_numbers(self):
        loaded = self.store.create()
        for project_id in ["../notes", "C:\\temp", "a/b", "", None]:
            with self.assertRaises(ResearchError): self.store.load(project_id)
        for modify in [lambda p: p.update(revision=True), lambda p: p.update(formatVersion=2),
                       lambda p: p["views"][0]["representations"].append({"id": "rep", "objectId": "missing", "x": 0, "y": 0}),
                       lambda p: p.update(extra=float("nan"))]:
            body = self.request(loaded); modify(body["project"])
            with self.assertRaises(ResearchError): self.store.save(body)
        self.assertEqual(loaded, self.store.load("project-main"))

    def test_write_failure_preserves_authoritative_snapshot(self):
        loaded = self.store.create()
        self.store.atomic_text = Mock(side_effect=OSError("disk full"))
        with self.assertRaises(OSError): self.store.save(self.request(loaded))
        self.assertEqual(loaded, self.store.load("project-main"))


if __name__ == "__main__":
    unittest.main()
