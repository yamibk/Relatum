import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.original_file = app.LEDGER_FILE
        self.original_backup = app.LEDGER_BACKUP_FILE
        app.LEDGER_FILE = root / "ledger.json"
        app.LEDGER_BACKUP_FILE = root / "ledger.backup.json"

    def tearDown(self):
        app.LEDGER_FILE = self.original_file
        app.LEDGER_BACKUP_FILE = self.original_backup
        self.temp_dir.cleanup()

    def create(self, **changes):
        body = {
            "type": "expense", "amountCents": 1250, "date": "2026-08-18",
            "note": "午饭", "color": "", "ledgerPage": 1,
        }
        body.update(changes)
        return app.ledger_entry_create(body)

    def test_missing_file_is_empty_v2_and_not_written(self):
        payload = app.ledger_full_payload()
        self.assertEqual(payload["version"], 2)
        self.assertEqual(payload["revision"], 0)
        self.assertEqual(payload["highestPage"], 1)
        self.assertEqual(payload["pageUnits"], {})
        self.assertEqual(payload["entries"], [])
        self.assertFalse(app.LEDGER_FILE.exists())

    def test_mutations_increment_revision_and_return_deltas_only(self):
        created = self.create()
        self.assertEqual(created["revision"], 1)
        self.assertNotIn("ledger", created)
        entry_id = created["entry"]["id"]
        updated = app.ledger_entry_update({"id": entry_id, "note": "晚饭"})
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["entry"]["note"], "晚饭")
        self.assertNotIn("ledger", updated)
        deleted = app.ledger_entry_delete({"id": entry_id})
        self.assertEqual(deleted, {"ok": True, "revision": 3, "deletedId": entry_id})
        self.assertEqual(app.ledger_full_payload()["revision"], 3)

    def test_client_id_makes_uncertain_create_retry_idempotent(self):
        entry_id = "le_" + "b" * 32
        first = self.create(id=entry_id, amountCents=2500, multiplier="0.58")
        retried = self.create(id=entry_id, amountCents=2500, multiplier="0.58")
        self.assertEqual(first["revision"], 1)
        self.assertEqual(retried["revision"], 1)
        self.assertTrue(retried["idempotent"])
        self.assertEqual(len(app.ledger_full_payload()["entries"]), 1)
        with self.assertRaises(ValueError):
            self.create(id=entry_id, amountCents=2600, multiplier="0.58")

    def test_multiplier_is_canonical_decimal_text_and_rounds_half_up(self):
        first = self.create(amountCents=25, multiplier="0.5800")
        second = self.create(amountCents=101, multiplier="1.005")
        self.assertEqual(first["entry"]["multiplier"], "0.58")
        self.assertEqual(app._ledger_effective_amount(first["entry"]), 15)
        self.assertEqual(app._ledger_effective_amount(second["entry"]), 102)
        cleared = app.ledger_entry_update({"id": second["entry"]["id"], "multiplier": None})
        self.assertNotIn("multiplier", cleared["entry"])
        self.assertEqual(app._ledger_effective_amount(cleared["entry"]), 101)

    def test_entries_require_page_and_highest_page_includes_units(self):
        with self.assertRaises(ValueError):
            self.create(ledgerPage=None)
        page_two = self.create(type="income", amountCents=5000, ledgerPage=2)
        self.assertEqual(page_two["entry"]["ledgerPage"], 2)
        self.assertEqual(app.ledger_full_payload()["highestPage"], 2)
        saved = app.ledger_page_unit_update({"page": 3, "unit": "块"})
        self.assertTrue(saved["changed"])
        self.assertEqual(saved["revision"], 2)
        self.assertEqual(saved["page"], 3)
        self.assertEqual(saved["unit"], "块")
        self.assertEqual(app.ledger_full_payload()["highestPage"], 3)
        unchanged = app.ledger_page_unit_update({"page": 3, "unit": "块"})
        self.assertFalse(unchanged["changed"])
        self.assertEqual(unchanged["revision"], 2)

    def test_full_payload_covers_all_months_and_pages(self):
        self.create(amountCents=3000, date="2026-07-01")
        self.create(type="income", amountCents=9000, date="2026-08-01")
        self.create(type="income", amountCents=5000, date="2026-06-01", ledgerPage=2)
        ledger = app.ledger_full_payload()
        self.assertEqual(len(ledger["entries"]), 3)
        self.assertEqual({entry["date"] for entry in ledger["entries"]}, {
            "2026-07-01", "2026-08-01", "2026-06-01",
        })

    def test_invalid_requests_do_not_change_file(self):
        self.create()
        before = app.LEDGER_FILE.read_bytes()
        invalid = [
            {"type": "transfer", "amountCents": 10, "date": "2026-08-01", "ledgerPage": 1},
            {"type": "expense", "amountCents": 0, "date": "2026-08-01", "ledgerPage": 1},
            {"type": "expense", "amountCents": 12.5, "date": "2026-08-01", "ledgerPage": 1},
            {"type": "expense", "amountCents": 10, "date": "2026-02-30", "ledgerPage": 1},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "color": "red", "ledgerPage": 1},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "multiplier": 2, "ledgerPage": 1},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "multiplier": "1.23456", "ledgerPage": 1},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "ledgerPage": 0},
        ]
        for body in invalid:
            with self.assertRaises(ValueError):
                app.ledger_entry_create(body)
            self.assertEqual(app.LEDGER_FILE.read_bytes(), before)

    def test_invalid_entry_in_valid_json_recovers_backup_without_silent_drop(self):
        created = self.create(note="有效备份")
        valid = app.LEDGER_FILE.read_bytes()
        app.LEDGER_BACKUP_FILE.write_bytes(valid)
        raw = json.loads(valid)
        raw["entries"].append({**created["entry"], "id": "le_" + "a" * 32, "amountCents": 0})
        app.LEDGER_FILE.write_text(json.dumps(raw), encoding="utf-8")
        loaded = app.load_ledger()
        self.assertEqual([entry["note"] for entry in loaded["entries"]], ["有效备份"])
        self.assertEqual(len(list(app.LEDGER_FILE.parent.glob("ledger.corrupt-*.json"))), 1)

    def test_duplicate_id_is_corruption_and_recovers_backup(self):
        created = self.create()
        valid = app.LEDGER_FILE.read_bytes()
        app.LEDGER_BACKUP_FILE.write_bytes(valid)
        raw = json.loads(valid)
        raw["entries"].append(dict(created["entry"]))
        app.LEDGER_FILE.write_text(json.dumps(raw), encoding="utf-8")
        loaded = app.load_ledger()
        self.assertEqual(len(loaded["entries"]), 1)
        self.assertEqual(len(list(app.LEDGER_FILE.parent.glob("ledger.corrupt-*.json"))), 1)

    def test_read_oserror_is_reported_without_quarantining_primary(self):
        self.create()
        path_type = type(app.LEDGER_FILE)
        with mock.patch.object(path_type, "read_bytes", side_effect=PermissionError("locked")):
            with self.assertRaises(PermissionError):
                app.load_ledger()
        self.assertTrue(app.LEDGER_FILE.exists())
        self.assertEqual(list(app.LEDGER_FILE.parent.glob("ledger.corrupt-*.json")), [])

    def test_incompatible_version_is_not_overwritten(self):
        raw = {"version": 99, "revision": 0, "entries": [], "pageUnits": {}}
        app.LEDGER_FILE.write_text(json.dumps(raw), encoding="utf-8")
        with self.assertRaises(app.LedgerVersionError):
            app.load_ledger()
        self.assertEqual(json.loads(app.LEDGER_FILE.read_text(encoding="utf-8")), raw)


if __name__ == "__main__":
    unittest.main()
