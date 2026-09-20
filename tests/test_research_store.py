import json
import os
import tempfile
import unittest
from pathlib import Path

from research_store import ResearchConflictError, ResearchStoreError, ResearchWorkspaceStore


def atomic_json(target: Path, payload: dict) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(".test-research.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8", newline="")
    os.replace(temporary, target)


def node(node_id, node_type, config=None, *, state_policy="reset", saved_state=None):
    value = {
        "id": node_id, "type": node_type, "label": node_id,
        "x": 0, "y": 0, "width": 176, "height": 72,
        "config": config or {}, "statePolicy": state_policy,
    }
    if saved_state is not None:
        value["savedState"] = saved_state
    return value


def wire(edge_id, from_node, from_port, to_node, to_port):
    return {
        "id": edge_id, "kind": "wire",
        "from": {"nodeId": from_node, "portId": from_port},
        "to": {"nodeId": to_node, "portId": to_port},
    }


def calculation_document():
    nodes = [
        node("five", "constant", {"value": {"type": "number", "value": 5}}),
        node("six", "constant", {"value": {"type": "number", "value": 6}}),
        node("add", "math", {"operation": "add"}),
        node("monitor", "monitor"),
        node("button", "button"),
        node("register", "register", {"initial": {"type": "number", "value": 0}},
             state_policy="persist", saved_state={"current": {"type": "number", "value": 2}}),
    ]
    edges = [
        wire("five-add", "five", "out", "add", "a"),
        wire("six-add", "six", "out", "add", "b"),
        wire("add-monitor", "add", "out", "monitor", "in"),
        wire("add-register", "add", "out", "register", "data"),
        wire("write-register", "button", "fire", "register", "write"),
        {"id": "knowledge", "kind": "relation", "fromNodeId": "five", "toNodeId": "monitor"},
    ]
    return {
        "researchVersion": 2,
        "pages": [{
            "id": "research-page-1", "title": "", "nodes": nodes, "edges": edges,
            "view": {"x": 31, "y": -12, "scale": 1.25}, "simulation": {"speed": 2},
        }],
        "activePageId": "research-page-1",
    }


class ResearchWorkspaceStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "research-workspace"
        self.store = ResearchWorkspaceStore(self.root, atomic_json=atomic_json)

    def tearDown(self):
        self.temporary.cleanup()

    def test_save_and_reopen_preserves_v2_graph_camera_speed_and_explicit_state(self):
        initial = self.store.load()
        self.assertEqual(initial["revision"], "")
        saved = self.store.save(calculation_document(), initial["revision"])
        reopened = self.store.load()
        self.assertEqual(reopened["document"], calculation_document())
        self.assertEqual(reopened["revision"], saved["revision"])
        text = self.primary_text()
        self.assertNotIn('"runtime"', text)
        self.assertNotIn('"history"', text)
        self.assertNotIn('"eventQueue"', text)

    def test_v1_is_discarded_without_migration_or_backup_and_first_save_overwrites(self):
        self.root.mkdir(parents=True)
        legacy = {"researchVersion": 1, "pages": [{"id": "old", "nodes": [{"secret": "old"}]}]}
        atomic_json(self.store.primary, legacy)
        loaded = self.store.load()
        self.assertTrue(loaded["legacyDiscarded"])
        self.assertEqual(loaded["document"]["researchVersion"], 2)
        self.assertEqual(loaded["document"]["pages"][0]["nodes"], [])
        self.store.save(calculation_document(), loaded["revision"])
        self.assertEqual(self.store.load()["document"], calculation_document())
        self.assertFalse(self.store.backup.exists(), "V1 must not be copied into a migration backup")

    def test_stale_revision_is_rejected(self):
        saved = self.store.save(calculation_document(), "")
        with self.assertRaises(ResearchConflictError) as captured:
            self.store.save(calculation_document(), "")
        self.assertEqual(captured.exception.revision, saved["revision"])

    def test_invalid_ports_channels_cardinality_bits_and_speed_never_replace_primary(self):
        saved = self.store.save(calculation_document(), "")
        cases = []
        invalid_port = calculation_document()
        invalid_port["pages"][0]["edges"][0]["to"]["portId"] = "by-position"
        cases.append(invalid_port)
        mixed_channel = calculation_document()
        mixed_channel["pages"][0]["edges"].append(wire("bad-channel", "button", "fire", "add", "a"))
        cases.append(mixed_channel)
        duplicate_input = calculation_document()
        duplicate_input["pages"][0]["edges"].append(wire("duplicate", "six", "out", "add", "a"))
        cases.append(duplicate_input)
        invalid_bits = calculation_document()
        invalid_bits["pages"][0]["nodes"][0]["config"]["value"] = {
            "type": "bits", "width": 65, "value": "0x0"
        }
        cases.append(invalid_bits)
        invalid_speed = calculation_document()
        invalid_speed["pages"][0]["simulation"]["speed"] = 3
        cases.append(invalid_speed)
        mismatched_bits = calculation_document()
        mismatched_bits["pages"][0]["nodes"][0]["config"]["value"] = {
            "type": "bits", "width": 8, "value": "0x1"
        }
        mismatched_bits["pages"][0]["nodes"][1]["config"]["value"] = {
            "type": "bits", "width": 16, "value": "0x1"
        }
        cases.append(mismatched_bits)
        for invalid in cases:
            with self.assertRaises(ResearchStoreError):
                self.store.save(invalid, saved["revision"])
            self.assertEqual(self.store.load()["document"], calculation_document())

    def test_event_inputs_accept_multiple_sources_but_reset_nodes_drop_state(self):
        document = calculation_document()
        document["pages"][0]["nodes"].append(node("button-2", "button"))
        document["pages"][0]["edges"].append(wire("write-register-2", "button-2", "fire", "register", "write"))
        document["pages"][0]["nodes"].append(
            node("transient", "toggle", {"initial": False}, saved_state={"current": True})
        )
        saved = self.store.save(document, "")
        normalized = saved["document"]
        transient = next(item for item in normalized["pages"][0]["nodes"] if item["id"] == "transient")
        self.assertNotIn("savedState", transient)
        self.assertEqual(len([edge for edge in normalized["pages"][0]["edges"]
                              if edge.get("to", {}).get("portId") == "write"]), 2)

    def test_timer_config_and_persistent_progress_round_trip_without_scheduler_state(self):
        document = calculation_document()
        document["pages"][0]["nodes"].append(node(
            "timer", "timer", {"mode": "countdown", "durationMs": 5000, "precisionMs": 100},
            state_policy="persist",
            saved_state={"durationMs": 5000, "elapsedMs": 1200, "running": True, "done": False},
        ))
        self.store.save(document, "")
        reopened = self.store.load()["document"]
        timer = next(item for item in reopened["pages"][0]["nodes"] if item["id"] == "timer")
        self.assertEqual(timer["config"], {"mode": "countdown", "durationMs": 5000, "precisionMs": 100})
        self.assertEqual(timer["savedState"]["elapsedMs"], 1200)
        text = self.primary_text()
        self.assertNotIn('"timerId"', text)
        self.assertNotIn('"performance"', text)

    def test_probe_configuration_and_wires_persist_but_runtime_trace_is_discarded(self):
        document = calculation_document()
        probe = node("probe", "probe", {"historyLimit": 32})
        probe["trace"] = [{"kind": "event", "simulationTime": 10}]
        document["pages"][0]["nodes"].append(probe)
        document["pages"][0]["edges"].extend([
            wire("value-probe", "add", "out", "probe", "value"),
            wire("pulse-probe", "button", "fire", "probe", "pulse"),
        ])
        saved = self.store.save(document, "")["document"]
        restored = next(item for item in saved["pages"][0]["nodes"] if item["id"] == "probe")
        self.assertEqual(restored["config"], {"historyLimit": 32})
        self.assertNotIn("trace", restored)
        self.assertNotIn("savedState", restored)

    def test_corrupt_primary_is_quarantined_and_backup_is_restored(self):
        first = self.store.save(calculation_document(), "")
        changed = calculation_document()
        changed["pages"][0]["view"]["x"] = 99
        self.store.save(changed, first["revision"])
        self.store.primary.write_text("{broken", encoding="utf-8")
        recovered = self.store.load()
        self.assertTrue(recovered["recovered"])
        self.assertEqual(recovered["recovery"]["source"], "backup")
        self.assertEqual(recovered["document"], calculation_document())
        self.assertTrue(list(self.root.glob("workspace.corrupt-*.json")))

    def primary_text(self):
        return self.store.primary.read_text(encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
